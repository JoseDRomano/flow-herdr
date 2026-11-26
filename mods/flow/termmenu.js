// The terminal's right-click menu in the Flow layouts (their root `terminal_menu`): Herdr's own pane items plus
// Split right on… and Split down on…, which open a dropdown of machines. A split onto another machine is a bridge
// pane (bridge.js), reached from the tab's machine as flow.json's routes say. Herdr opens this copy at the pointer at a
// fixed size, so it hands its items to Flow's menu (menu.js), sized to them, and closes itself.

import { div } from "gpui-kit";
import { props, run, closeOverlay, panes, terminals, focused, spaces, hc, exec, notify, shared, setShared, appHome, readTextFile } from "herdr";
import { openMenu } from "./ui.js";
import { BRIDGES, LOCAL, ROUTES_FILE, bridgeOf, lost, machineChoices, machineItems, paneItems, reconnectLine, remember, routeArgv, routeFor } from "./bridge.js";
import { openMachineForm } from "./machine-form.js";
import { THREADS, folderOn, normalize as threadsOf } from "./threads.js";

/** The right-click menu's items for Herdr's target `{pane, terminal}`. */
export function menuFor(target) {
  const pane = target?.pane ?? null;
  const terminal = target?.terminal ?? null;
  const all = terminals();
  const term = all.find((t) => t.address === terminal);
  const parent = term?.parent ? all.find((t) => t.address === term.parent) : null;
  const shown = panes().find((p) => p.pane === pane) ?? null;
  const bridge = shown ? bridgeOf(shared(BRIDGES), pane) : null;
  return paneItems({
    pane,
    terminal: term ? terminal : null,
    inTab: Boolean(shown),
    parent: parent ? parent.name || parent.address : null,
    toProgram: term?.labels?.["herdr.right-click"] === "program",
    bridge,
    reconnect: lost(bridge, shown),
  });
}

export default class TerminalMenu {
  init(p) {
    const given = p ?? props() ?? {};
    // Shown in Herdr's own popup only for the frame it takes to open cockpit's.
    try {
      openMenu(menuFor(given.target));
    } finally {
      if (given.overlay) closeOverlay(given.overlay);
    }
  }

  render() {
    return div();
  }
}

/** The machines a split can go to, as `hc machine ls` lists them; none when it can't say. */
export async function listMachines() {
  try {
    const r = await hc(["machine", "ls", "--json"]);
    return r.code === 0 ? machineChoices(JSON.parse(r.stdout)) : [];
  } catch {
    return [];
  }
}

/** The space a pane's tab is in, or null. */
function spaceOf(pane) {
  const tab = panes().find((p) => p.pane === pane)?.tab;
  return (tab && spaces().find((s) => s.tabs?.some((t) => t.id === tab))) || null;
}

/** The machine a pane's tab lives on, as `hc machine ls` names it; null for this computer. */
function originOf(pane) {
  return spaceOf(pane)?.machine || null;
}

/** flow.json in the Herdr home, `{}` when there is none; a file that doesn't parse says so and counts as none. */
export async function routesConfig() {
  const path = `${appHome()}/${ROUTES_FILE}`;
  try {
    return JSON.parse((await readTextFile(path)) ?? "{}") ?? {};
  } catch (e) {
    notify({ title: `${ROUTES_FILE} can't be read`, body: `${path}: ${e?.message ?? e}`, level: "warning", timeout: 8000 });
    return {};
  }
}

/** Whether `origin`'s own hc knows `target` (its `hc machine ls`); false when it can't say within a few seconds. */
export async function knows(origin, target) {
  try {
    const r = await exec("sh", ["-lc", "hc machine ls --json"], { on: origin, timeout: 5000 });
    return r.code === 0 && machineChoices(JSON.parse(r.stdout)).some((m) => m.name === target);
  } catch {
    return false;
  }
}

/** Opens the dropdown of machines to split `pane` onto, to the right or down (`direction` null: both). */
export async function openMachineMenu(direction, pane) {
  const space = spaceOf(pane);
  const thread = space ? threadsOf(shared(THREADS)).threads[space.id]?.where?.machine ?? null : null;
  openMenu(machineItems(direction, pane, await listMachines(), space?.machine || null, thread), { width: 300 });
}

/** Opens the form that says how `pane`'s machine reaches another one, picked among this computer and the machines. */
export async function openRouteForm(direction, pane) {
  const origin = originOf(pane);
  const targets = [LOCAL, ...(await listMachines()).map((m) => m.name)].filter((t) => t !== origin);
  openMachineForm({ origin, targets, direction, pane });
}

/** Whether a folder exists on a machine (`local`: this computer), asked there; false when it doesn't answer in time. */
export async function hasFolder(folder, machine) {
  try {
    return (await exec("test", ["-d", folder], { ...(machine === LOCAL ? {} : { on: machine }), timeout: 5000 })).code === 0;
  } catch {
    return false;
  }
}

/**
 * Splits `pane` right or down with a terminal on `target` (a machine's name, or `local` for this computer). On the tab's
 * own machine it is Herdr's own split; elsewhere the new pane reaches the target as flow.json's routes say (from this
 * computer, hc by default; from another machine, hc only when that machine's hc knows the target).
 * With no route, it opens the form that asks for one. It starts in the folder of the bridge it splits when that is on
 * the target, else in the folder of the pane's thread when the thread works on the target, else in the pane's own
 * folder; any of them only when that machine has it, else in its home.
 */
export async function splitOnto(direction, pane, target) {
  const origin = originOf(pane);
  let route = routeFor(await routesConfig(), target, origin);
  if (route?.kind === "split") return run("pane.split", { direction, pane });
  if (!route && target !== LOCAL && (await knows(origin, target))) route = { kind: "hc", name: target };
  // No way there yet: the form asks for one, saves it to flow.json and makes this split.
  if (!route) return openMachineForm({ origin, target, direction, pane });
  const source = panes().find((p) => p.pane === pane);
  const from = bridgeOf(shared(BRIDGES), pane);
  // A split of a bridge pane onto its own machine keeps its folder there; onto the machine its thread works on, the
  // thread's folder; else the pane's own folder, only if that machine has it.
  const wanted = (from?.machine === target ? from.folder : null) ?? folderOn(shared(THREADS), spaceOf(pane)?.id, target) ?? source?.cwd ?? null;
  const folder = wanted && (await hasFolder(wanted, target)) ? wanted : null;
  const argv = routeArgv(route, folder);
  run("pane.focus", { pane });
  run("terminal.open", { argv, place: direction, ...(source?.cwd ? { folder: source.cwd } : {}) });
  const opened = focused()?.pane;
  if (opened && opened !== pane) setShared(BRIDGES, remember(shared(BRIDGES), opened, target, folder, new Set(panes().map((p) => p.pane)), argv));
}

/** Puts a bridge pane whose terminal Herdr gave a shell (after a reboot) back on its machine, the way it first got there. */
export async function reconnect(pane) {
  const bridge = bridgeOf(shared(BRIDGES), pane);
  const shown = panes().find((p) => p.pane === pane);
  if (!bridge || !shown?.terminal) return;
  try {
    const r = await hc(["send", shown.terminal, reconnectLine(bridge)]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `hc send exited with ${r.code}`);
  } catch (e) {
    notify({ title: `Could not reconnect to ${bridge.machine}`, body: e?.message ?? String(e), level: "error" });
  }
}
