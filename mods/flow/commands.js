// The window's commands for both cockpit layouts: what keys.json binds, what the palette lists and what the keys sheet
// shows. The one copy the layout always shows runs them: the status bar.

import { run, shared, setShared, keys, commands, focused, openOverlay, spaces, panes, notify, terminals } from "herdr";
import * as hub from "./hub.js";
import { fleet, goToAgent } from "./fleet.js";
import { show, showWork, screens, screensOf, layoutName, shownLayout, nodeOf, agentInView } from "./screens.js";
import { shownScreen } from "./front.js";
import { follow } from "./notify.js";
import { openUpdate } from "./update.js";
import { openCode } from "./code.js";
import { openSettings } from "./doctor.js";
import { openUsage } from "./usage.js";
import { openStart } from "./start.js";
import { keyed, take } from "./person.js";
import { openMenu } from "./ui.js";
import { undoToast } from "./agentsui.js";
import { projectPanels } from "./projects.js";
import { FOLDERS, deleteFolder, toggleFolder, moveMachine } from "./folders.js";
import { openFolderName } from "./folder-name.js";
import { openThreadForm } from "./thread-form.js";
import { openGitlabForm } from "./gitlab-form.js";
import { THREADS, KINDS, mark, release, resolve, forget, activity } from "./threads.js";
import { openMachineMenu, openRouteForm, splitOnto, reconnect } from "./termmenu.js";

/** The view that runs the window's commands in each layout: always shown there, and only once. */
export const RUNNER = { flow: "status" };

// ---------------------------------------------------------------------------------------------------------------------
// Keys

const SYMBOL = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", escape: "Esc", backspace: "⌫", space: "Space", tab: "⇥", up: "↑", down: "↓", left: "←", right: "→" };

/** "cmd-shift-p" as the caps ⌘ ⇧ P. */
export function keyCaps(k) {
  const parts = k.endsWith("--") ? [...k.slice(0, -2).split("-"), "-"] : k.split("-");
  return parts.map((p) => SYMBOL[p] ?? (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)));
}

/** A key as one string of caps: "⌘⌥0". */
export const keyText = (k) => keyCaps(k).join("");

/** The keys that work in a layout: its own section's, then Herdr's global ones it does not take over. */
export function bindings(layout = shownLayout(), bound = keys()) {
  const own = bound.filter((b) => b.section === `layout:${layout}`);
  const taken = new Set(own.map((b) => b.keys));
  return [...own, ...bound.filter((b) => b.section === "global" && !taken.has(b.keys))];
}

/** The key an action is bound to in a layout, or null. */
export function keyFor(action, layout = shownLayout(), bound = keys()) {
  return bindings(layout, bound).find((b) => b.action === action)?.keys ?? null;
}

/** A tooltip with its key after two spaces when the shown layout binds one: "Home  ⌘⌥0". */
export function hint(label, action) {
  const k = action ? keyFor(action) : null;
  return k ? `${label}  ${keyText(k)}` : label;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the commands are called

/** A command of cockpit's besides its screens: what the palette and the keys sheet call it, and where it works. */
const entry = (command, title, icon, group, words, more = {}) => ({ command, title, icon, group, words, ...more });

/** cockpit's commands besides its screens. `layouts` names the layouts where a view handles one (the queue drawer). */
export const CATALOGUE = [
  entry("flow.palette", "Search or run a command", "search", "Window", "palette find"),
  entry("flow.keys", "Keys", "keyboard", "Window", "shortcuts keybindings help sheet"),
  entry("flow.settings", "Flow settings", "sliders-horizontal", "Window", "options preferences config version update check switch toggle"),
  entry("flow.settings:health", "Flow settings: Health", "shield-check", "Window", "doctor diagnostics checks report setup getting started hub fix"),
  entry("flow.settings:agents", "Flow settings: Agents", "bot", "Window", "installed providers can start resume fork tools"),
  entry("flow.settings:layout", "Flow settings: Layout", "layout", "Window", "flow look switch screenshot"),
  entry("flow.gitlab", "Connect GitLab", "git-merge", "Window", "gitlab self-hosted merge requests mr pipelines issues connect sign in server"),
  entry("flow.next-waiting", "Next agent waiting for you", "bell", "Agents", "needs you question jump"),
  entry("flow.next:blocked", "Next blocked agent", "circle-dot", "Agents", "needs you"),
  entry("flow.next:done", "Next finished agent", "circle-check", "Agents", "done"),
  entry("flow.recap", "Recap the agents", "sparkles", "Agents", "whose move stages summary"),
  entry("flow.usage", "Usage and limits", "gauge", "Agents", "quota limits tokens spend estimate account plan"),
  entry("flow.thread", "New thread…", "git-branch", "Agents", "fix feature bug space work new main machine"),
  entry("flow.thread:edit", "Edit this thread…", "sliders-horizontal", "Agents", "rename name kind folder properties change"),
  entry("flow.start", "Start work…", "play", "Agents", "new agent worktree ticket pr prompt task branch"),
  entry("flow.resume", "Resume stopped agents", "play", "Agents", "restart reboot resume session"),
  entry("flow.queue", "Prompt queue", "list", "Agents", "follow-ups send later", { layouts: ["flow"] }),
  entry("flow.agent-view", "The focused agent alone", "bot", "This agent", "focus lone terminal tab toggle", { layouts: ["flow"] }),
  entry("flow.dismiss", "Dismiss this agent until it asks again", "x", "This agent", "needs you set aside hide waiting card"),
  entry("flow.dismiss:back", "Bring this agent back to Needs you", "undo", "This agent", "dismissed restore undo waiting card"),
  entry("flow.pr", "This branch's PR", "git-pull-request", "This agent", "pull request github"),
  entry("flow.ticket", "This branch's ticket", "ticket", "This agent", "linear jira issue"),
  entry("flow.panel", "Side panel", "panel-right", "Side panel", "show review runbook files changes toggle"),
  entry("flow.panel:show", "Side panel: Show", "layout", "Side panel", "charts tables diagrams"),
  entry("flow.panel:review", "Side panel: Review", "git-pull-request", "Side panel", "diff comments"),
  entry("flow.panel:runbook", "Side panel: Runbook", "book", "Side panel", "steps ticket"),
  entry("flow.panel:files", "Side panel: Files", "folder", "Side panel", "tree"),
  entry("flow.panel:changes", "Side panel: Changes", "git-fork", "Side panel", "git diff"),
];

/** Older names of commands, which keys bound to them still run: the keys sheet names each as what it opens now. */
export const ALIASES = { "flow.diagnostics": "flow.settings:health" };

/** What the palette runs for an entry: its command. */
export function paletteAction(e) {
  return e.command;
}

/** Herdr's own names for its commands: [command, args, group, title, keywords]. */
export const NAMED = [
  ["tab.new", {}, "Tab", "New tab", "tab agent new task"],
  ["mod.open", { name: "picker" }, "Tab", "Go to space or tab…", "switch jump find"],
  ["tab.rename", {}, "Tab", "Rename tab", "tab"],
  ["tab.close", {}, "Tab", "Close tab", "tab kill"],
  ["tab.next", {}, "Tab", "Next tab", "tab"],
  ["tab.prev", {}, "Tab", "Previous tab", "tab"],
  ["pane.split", { direction: "right" }, "Pane", "Split right", "vertical"],
  ["pane.split", { direction: "down" }, "Pane", "Split down", "horizontal"],
  ["pane.close", {}, "Pane", "Close pane", "kill"],
  ["pane.zoom", {}, "Pane", "Zoom pane", "maximize fullscreen"],
  ["pane.rename", {}, "Pane", "Rename pane", "name title"],
  ...["left", "right", "up", "down"].map((d) => ["pane.resize", { direction: d }, "Pane", `Move pane edge ${d}`, "resize size wider narrower taller"]),
  ...["left", "right", "up", "down"].map((d) => ["pane.go", { direction: d }, "Pane", `Focus pane ${d}`, "move go"]),
  ...["left", "right", "up", "down"].map((d) => ["pane.swap", { direction: d }, "Pane", `Swap pane ${d}`, "move"]),
  ["space.new", {}, "Space", "New space", "workspace"],
  ["space.rename", {}, "Space", "Rename space", "workspace"],
  ["space.close", {}, "Space", "Close space", "workspace kill"],
  ["space.next", {}, "Space", "Next space", "workspace"],
  ["space.prev", {}, "Space", "Previous space", "workspace"],
  ["layout.switch", {}, "Layout", "Next layout", "look switch"],
  ["layout.reset", {}, "Layout", "Reset layout", "new version default restore herdr's"],
  ["layout.clone", {}, "Layout", "Duplicate layout", "clone copy customize"],
  ["mod.clone", {}, "Layout", "Duplicate mod", "clone copy customize"],
  ["terminal.open", {}, "Terminal", "New terminal", "shell"],
  ["terminal.copy", {}, "Terminal", "Copy", "clipboard"],
  ["terminal.paste", {}, "Terminal", "Paste", "clipboard"],
  ["agent.next", {}, "Agent", "Next agent", ""],
  ["agent.prev", {}, "Agent", "Previous agent", ""],
  ["window.minimize", {}, "Window", "Minimize window", ""],
  ["window.maximize", {}, "Window", "Maximize window", "restore"],
  ["window.close", {}, "Window", "Close window", "quit"],
  ["app.settings", {}, "App", "Settings", "preferences options config look font theme sound"],
  ["app.help", {}, "App", "Herdr's keys", "keybindings shortcuts help"],
  ["app.welcome", {}, "App", "Welcome", "intro start onboarding"],
  ["app.whats_new", {}, "App", "What's new", "release changes news update"],
  ["app.reset", {}, "App", "Reset to the default screen", "escape hatch broken restore"],
  ["app.zoom_in", {}, "App", "Zoom in", "bigger font size"],
  ["app.zoom_out", {}, "App", "Zoom out", "smaller font size"],
  ["app.zoom_reset", {}, "App", "Reset zoom", "font size"],
  ["app.quit", {}, "App", "Quit Herdr", "exit"],
  ...["graphite", "ink", "moss", "atom-one-dark"].map((n) => ["app.theme", { name: n }, "App", `Theme: ${n.replace(/-/g, " ")}`, "colors look"]),
];

/** A Herdr command's name in words: "tab.rename" reads "Rename tab". */
export function titleOf(name) {
  const [noun, verb] = name.split(".");
  return { group: noun.charAt(0).toUpperCase() + noun.slice(1), title: `${(verb ?? "").replace(/_/g, " ")} ${noun}`.replace(/^./, (c) => c.toUpperCase()) };
}

/** keys.json's `name:value` as [name, value]; value is undefined without one. */
function splitAction(action) {
  const at = action.indexOf(":");
  return at < 0 ? [action, undefined] : [action.slice(0, at), action.slice(at + 1)];
}

/** Keys a view takes itself, the same in every app that has them: a page header's source chips. */
export const VIEW_KEYS = [
  ["shift-l", "Sign in to a source again"],
  ["shift-r", "Read the sources again"],
];

/** The keys sheet's groups, in order. */
const SHEET = ["Screens", "Agents", "This agent", "Side panel", "Window", "In the apps", "Herdr"];

/** What a keys.json action does, in words and in which group of the sheet: {title, group, icon}. */
export function describe(action, layout = layoutName()) {
  const s = screensOf(layout)?.list.find((x) => x.command === action);
  if (s) return { title: s.label, group: "Screens", icon: s.icon };
  const c = CATALOGUE.find((e) => e.command === (ALIASES[action] ?? action));
  if (c) return { title: c.title, group: c.group, icon: c.icon };
  const [name, value] = splitAction(action);
  const named = NAMED.find(([n, args]) => n === name && (value === undefined ? Object.keys(args).length === 0 : Object.values(args)[0] === value));
  if (named) return { title: named[3], group: "Herdr", icon: null };
  return { title: `${titleOf(name).title}${value === undefined ? "" : ` ${value}`}`, group: "Herdr", icon: null };
}

/**
 * The keys sheet of a layout: its bindings grouped, Herdr's global ones it keeps last, cockpit's in the order of its
 * screens and commands whatever order keys() gives. [{title, rows: [{keys, action, title, group, icon}]}].
 */
export function sheet(layout = layoutName(), bound = keys(), section = shownLayout()) {
  const order = [...(screensOf(layout)?.list ?? []).map((s) => s.command), ...CATALOGUE.map((e) => e.command)];
  const at = (r) => (r.group === "Herdr" ? 0 : order.indexOf(r.action) + 1 || order.length + 1);
  const rows = bindings(section, bound).map((b) => ({ keys: b.keys, action: b.action, ...describe(b.action, layout) }));
  rows.push(...VIEW_KEYS.map(([k, title]) => ({ keys: k, action: null, title, group: "In the apps", icon: null })));
  // Herdr's commands a layout binds keep NAMED's order (left, right, up, down), whatever order keys() lists them in.
  const named = (r) => {
    const [name, value] = splitAction(r.action ?? "");
    const n = NAMED.findIndex(([c, args]) => c === name && (value === undefined || Object.values(args)[0] === value));
    return n < 0 ? NAMED.length : n;
  };
  const sorted = rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => at(a) - at(b) || named(a) - named(b) || i - j).map(([r]) => r);
  return SHEET.map((title) => ({ title, rows: sorted.filter((r) => r.group === title) })).filter((g) => g.rows.length > 0);
}

/** keys.json's value for an argument: a number when it is written as one (`tab.select:1`). */
const argValue = (value) => (/^-?\d+$/.test(value) ? Number(value) : value);

/** Runs a keys.json action: a cockpit command, or Herdr's `name:value` with the value as its first argument. */
export function runAction(action) {
  if (action.startsWith("flow.")) return run(action);
  const [name, value] = splitAction(action);
  if (value === undefined) return run(name, {});
  const arg = commands().find((c) => c.name === name)?.args?.[0]?.name;
  return run(name, arg ? { [arg]: argValue(value) } : {});
}

// ---------------------------------------------------------------------------------------------------------------------
// The side panel

/** The side panel's children by the names keys and the activity bar use. */
export const PANELS = { show: "show", review: "review", runbook: "runbook-panel", files: "files", changes: "changes" };

/**
 * The panel a name shows: cockpit's Files and Changes, which follow the projects the agent works in, where the layout
 * has them and `chat.projectPanels` is on, else Herdr's.
 */
export function panelChild(name, tree) {
  const child = PANELS[name] ?? name;
  const ours = `project-${child}`;
  return (child === "files" || child === "changes") && projectPanels() && nodeOf(ours, tree) ? ours : child;
}

/** Whether the side panel is open, and on what, as last set; `panelOpen` reads what the shown layout really does. */
export const PANELED = "flow.panel.open";
export const PANEL_CHILD = "flow.panel.child";

/** Whether the shown layout's side panel is open: each layout keeps its own, so a flag set in the other never decides. */
export function panelOpen(tree) {
  const node = nodeOf("panel", tree);
  return Boolean(node && !node.hidden);
}

/** Puts the flag back on what the shown layout does; true when it was off. */
export function settlePanel(tree) {
  const open = panelOpen(tree);
  if ((shared(PANELED) === true) === open) return false;
  setShared(PANELED, open);
  return true;
}

/** Opens the side panel on that child, left open when it already shows it. */
export function openPanel(name) {
  const child = (name && panelChild(name)) ?? shared(PANEL_CHILD) ?? "show";
  setShared(PANELED, true);
  setShared(PANEL_CHILD, child);
  run("layout.select", { stack: "panel-body", child });
  run("layout.show", { id: "panel" });
  // The panel only shows beside the agent, so opening it brings that screen up in whichever layout is on.
  if (shared("flow.app") !== screens().work) showWork();
}

/** Closes the side panel, and says so: the drawer on the edge takes over from the flag. */
export function closePanel() {
  setShared(PANELED, false);
  run("layout.hide", { id: "panel" });
}

/** Opens the side panel on that child, or closes it when it already shows it. */
export function togglePanel(name) {
  const child = name && panelChild(name);
  const showing = nodeOf("panel-body")?.active ?? shared(PANEL_CHILD);
  if (panelOpen() && (!child || showing === child)) closePanel();
  else openPanel(child);
}

// ---------------------------------------------------------------------------------------------------------------------
// Overlays

const PALETTE = { mod: "flow", kind: "popup", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 } };

/** When an open palette last answered `flow.palette` or `flow.keys` itself, so the runner opens none then. */
export const ANSWERED = "flow.palette.closed";

/** Opens the palette over the window (or its keys sheet), unless an open one answers the same command by itself. */
export function togglePalette(cx, sheet = null) {
  // `popup: true` tells front.js the copy is a popup, so keys pressed from outside reach it first.
  const open = () => openOverlay({ ...PALETTE, props: sheet ? { app: "palette", sheet, popup: true } : { app: "palette", popup: true } });
  if (!cx) return open();
  const asked = Date.now();
  cx.timer.after(80, () => {
    if ((shared(ANSWERED) ?? 0) < asked) open();
  });
}

/** The recap of every agent, on one of its tabs. */
export function openRecap(tab) {
  openOverlay({ mod: "flow", props: { app: "recap", popup: true, ...(tab ? { tab } : {}) }, kind: "dialog", width: 0.8, height: 0.8 });
}

// ---------------------------------------------------------------------------------------------------------------------
// Agents

/**
 * Copies of the window that follow the agents view and lend it, each as a `() => value | null` with the load of hub.js
 * it runs: a load that stopped running (a reload left its views behind) lends nothing.
 */
const lenders = () => (globalThis.flowAgentLent ??= new Map());

/** Lends a copy's agents view to the window's commands until the returned function is called. */
export function lend(fn) {
  lenders().set(fn, hub.LOAD);
  return () => lenders().delete(fn);
}

/** The agents view some running copy follows now, the newest load's first, else null. */
export function lent() {
  for (const [fn, load] of [...lenders()].sort((x, y) => y[1] - x[1])) {
    if (!hub.liveLoad(load)) continue;
    try {
      const value = fn();
      if (value) return value;
    } catch {}
  }
  return null;
}

/** The agents now, to `then(list, cx)`: the runner's own or another copy's when one follows them, else the hub's. */
function withAgents(cx, ctx, then) {
  const rows = ctx?.rows ?? lent();
  if (rows) return then(fleet(rows, ctx?.home ?? null), cx);
  cx.spawn(async (cx) => {
    let rows = null;
    try {
      rows = await hub.view("agents", { frontend: "app" });
    } catch {}
    then(fleet(rows, null), cx);
    cx.notify();
  });
}

/** The agent the person looks at: the focused pane's. */
function looking() {
  const f = focused();
  return f?.agent ?? f?.terminal ?? null;
}

/** The agents at a stage of Home's (null: needs you), the one waiting longest first. */
function atStage(list, stage) {
  return list.filter((a) => (stage ? a.stage === stage || a.status === stage : a.stage === "needs")).sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

/**
 * The first agent after `here` at a stage that `reachable` says can be brought up, going round once, and the ones it
 * passed on the way. Needs you falls back to done when nobody needs you.
 */
export function nextOf(list, stage, here, reachable = () => true) {
  const ring = atStage(list, stage);
  const at = ring.length || stage !== null ? ring : atStage(list, "done");
  const i = at.findIndex((a) => a.address === here || a.handle === here);
  const passed = [];
  for (let k = 1; k <= at.length; k++) {
    const a = at[(i + k) % at.length];
    if (reachable(a)) return { agent: a, passed };
    passed.push(a);
  }
  return { agent: null, passed };
}

/** Whether an agent can be brought up here: a terminal must be running, and a session cockpit drives has none. */
function reachableNow() {
  let live = null;
  try {
    const all = terminals();
    if (Array.isArray(all) && all.length) live = new Set(all.filter((t) => t?.state === "live").map((t) => t.address));
  } catch {}
  return (a) => a.driven !== true && (!live || live.has(a.address));
}

/** Where the last jump went from and to: a press soon after, while the focus never left `from`, goes on from `to`. */
let jumped = null;

/** The agent in view, as the status bar names it. */
const current = (list) => agentInView(list);

/**
 * Brings the next agent at a stage into view. An agent with no running terminal is passed (a session cockpit drives has
 * none), and so is one the last press could not bring up, and the person is told.
 */
const next = (stage) => (_arg, cx, ctx) =>
  withAgents(cx, ctx, (list) => {
    const here = looking();
    const from = jumped && jumped.stage === stage && jumped.from === here && Date.now() - jumped.at < 30_000 ? jumped.to : here;
    const { agent, passed } = nextOf(list, stage, from, reachableNow());
    const names = passed.map((a) => a.title || a.address).join(", ");
    const stays = agent && (agent.handle === here || agent.address === here);
    const onTo = !agent ? "Nobody else waits." : stays ? "The one in front is the only one waiting you can reach." : `On to ${agent.title || agent.address}.`;
    if (passed.length) notify({ title: passed.length === 1 ? `${names} has no running terminal` : `${passed.length} agents have no running terminal`, body: `${onTo}${passed.length > 1 ? ` Passed: ${names}.` : ""}`, level: "info", timeout: 5000 });
    else if (from !== here && agent) notify({ title: "That agent did not come up", body: `On to ${agent.title || agent.address}.`, level: "info", timeout: 4000 });
    if (!agent) return;
    jumped = { stage, from: here, to: agent.handle ?? agent.address, at: Date.now() };
    goToAgent(agent, ctx?.person);
  });

const openLink = (pick) => (_arg, cx, ctx) =>
  withAgents(cx, ctx, (list, cx) => {
    const url = pick(current(list));
    if (url) cx.spawn(async () => hub.openUrl(url));
  });

// ---------------------------------------------------------------------------------------------------------------------
// The commands

/** The agents view's row for this key, null when it lists none, undefined when the view cannot be read. */
async function rowOf(key) {
  const rows = lent()?.agents ?? (await hub.view("agents", { frontend: "app" }).catch(() => null))?.agents;
  return rows ? (rows.find((r) => r.terminal === key || r.address === key || r.terminal === `app:${key}`) ?? null) : undefined;
}

/** Says what went wrong with a hub action the person asked for. */
function said(r, title) {
  if (r?.error) notify({ title, body: String(r.error).replace(/^[a-z_]+: /, ""), level: "warning", timeout: 5000 });
}

/**
 * Sets an agent aside until it asks something new, or brings it back (`back`): the one `named`, else the one the person
 * looks at, `wait` the wait a menu showed. Asked by a window command, a key binding or a toast's click included, it
 * opens a menu naming the agent, which the person picks from.
 */
function setAside(cx, person, back, named = null, wait = null) {
  const key = named || looking();
  if (!key) return notify({ title: "No agent in front", level: "info", timeout: 3000 });
  const terminal = String(key).includes(":") ? String(key) : `app:${key}`;
  cx.spawn(async () => {
    const row = await rowOf(key);
    const title = row?.title ?? "the agent";
    if (!person) {
      const item = back
        ? { label: `Bring ${title} back to Needs you`, icon: "undo", command: `dismiss:back:${terminal}` }
        : { label: `Dismiss ${title} until it asks again`, icon: "x", command: `dismiss:at:${terminal}|${row?.wait ?? ""}` };
      return openMenu([item], { width: 340, clickOnly: true });
    }
    const named = wait ?? (back ? null : row?.wait ?? null);
    const r = await hub.act("agents", "dismiss", [{ terminal, undo: back, ...(named ? { wait: named } : {}) }]).catch((e) => ({ error: String(e?.message ?? e) }));
    said(r, back ? "Could not bring it back" : "Could not dismiss it");
    if (r?.error) return;
    if (back) notify({ title: `${row?.title ?? "The agent"} is back in Needs you`, level: "success", timeout: 3000 });
    else undoToast(terminal, row?.title ?? "the agent");
  });
}

/** The window's commands; a name ending in ":" takes the rest of the command as its argument. */
const WINDOW = {
  palette: (_a, cx) => togglePalette(cx),
  keys: (_a, cx) => togglePalette(cx, "keys"),
  recap: () => openRecap(),
  "recap:": (tab) => openRecap(tab),
  "next-waiting": next(null),
  "next:blocked": next("needs"),
  "next:done": next("done"),
  panel: () => togglePanel(null),
  "panel:": (name) => togglePanel(name),
  "doc:": (name, _cx, ctx) => {
    openPanel("show");
    run(ctx.person ? keyed(`flow.show:go:${name}`) : `flow.show:go:${name}`);
  },
  // `go:work` is where you deal with an agent: its panes.
  "go:": (child) => show(child === "work" ? screens().work : child),
  // The agent in front leaves what needs you until it asks something new; `dismiss:back[:<terminal>]` brings it back.
  dismiss: (_a, cx, ctx) => setAside(cx, ctx.person, false),
  // `dismiss:at:<terminal>|<wait>` from its menu, `dismiss:back[:<terminal>]`, and a toast's `dismiss:undo:<terminal>`,
  // which only opens the menu that brings it back.
  "dismiss:": (arg, cx, ctx) => {
    const [what, ...rest] = arg.split(":");
    const named = rest.join(":");
    if (what === "back") setAside(cx, ctx.person, true, named || null);
    else if (what === "undo" && named) setAside(cx, false, true, named);
    else if (what === "at" && named.includes("|")) setAside(cx, ctx.person, false, named.slice(0, named.indexOf("|")), named.slice(named.indexOf("|") + 1) || null);
  },
  pr: openLink((me) => me?.pr?.url),
  ticket: openLink((me) => me?.ticketUrl),
  resume: (_a, cx) => cx.spawn(async () => hub.act("home", "resume", [])),
  // A web page only: `open` given a file or an app would run it.
  "link:": (url, cx) => /^https?:\/\//.test(url) && cx.spawn(async () => hub.openUrl(url)),
  // A notification's row, a URL or a space: it only ever navigates (notify.js).
  "target:": (target, cx) => follow(target, cx),
  update: (_a, _cx, ctx) => openUpdate({ person: ctx.person }),
  // Opened by a menu, the palette or a key of the window's, the sheet counts what it shows as seen; by a bare command, not.
  settings: (_a, _cx, ctx) => openSettings({ person: ctx.person }),
  "settings:": (tab, _cx, ctx) => openSettings({ tab, person: ctx.person }),
  // The name the sheet had: a key bound to it still opens it, on the checks it showed.
  diagnostics: (_a, _cx, ctx) => openSettings({ tab: "health", person: ctx.person }),
  usage: () => openUsage(),
  gitlab: () => openGitlabForm(),
  start: () => openStart(),
  thread: () => openThreadForm(),
  // A thread's menus: `thread:new|<kind>` opens the dialog on that kind, `edit[|<space>]` opens it on that thread (the
  // shown space's when none is named) and `confirm|<space>` asks before resolving it;
  // `kind|<space>|<kind>` changes a thread's kind or makes a space a thread, `release|<space>` leaves the space among the
  // other ones, `resolve|<space>` marks it done and closes its panes, and `forget|<space|*>` takes it off the resolved
  // list, on the person's pick only.
  "thread:": (arg, _cx, ctx) => threadCommand(arg, Boolean(ctx.person)),
  kit: () => openOverlay({ mod: "flow", props: { app: "kit" }, kind: "window", key: "flow-kit", width: 0.85, height: 0.9 }),
  "kit:": (tab) => openOverlay({ mod: "flow", props: { app: "kit", tab }, kind: "window", key: "flow-kit", width: 0.85, height: 0.9 }),
  "code:open:": (path) => openCode(path),
  // The Spaces folders' menus: `folder:fold|<id>` folds one; changing them (`new[|<machine>]`, `rename|<id>`,
  // `space|<machine>` (a new space there), `delete|<id>`, `move|<id>|<machine>`, `out|<machine>`) takes the person's own pick, never a command from outside.
  "folder:": (arg, _cx, ctx) => folderCommand(arg, Boolean(ctx.person)),
  // A pane's splits onto another machine (termmenu.js): `split:on|<right|down>|<pane>` opens the dropdown of machines;
  // `to|<direction>|<pane>|<machine|local>` splits there and `again|<pane>` reconnects a bridge pane, on the person's pick only;
  // `route|<direction|none>|<pane>` opens the form that says how the pane's machine reaches the others, the same.
  "split:": (arg, _cx, ctx) => splitCommand(arg, Boolean(ctx.person)),
};

const DIRECTIONS = new Set(["right", "down"]);
/** A form opened from the pane header's dropdown, which lists both directions, makes no split after: `none`. */
const FORM_DIRECTIONS = new Set([...DIRECTIONS, "none"]);

/** Runs a pane's split command from its menus; only opening the dropdown goes without the person's pick. */
function splitCommand(arg, person) {
  const [verb, ...rest] = arg.split("|");
  if (verb === "on" && DIRECTIONS.has(rest[0]) && rest[1]) return void openMachineMenu(rest[0], rest[1]);
  if (!person) return;
  if (verb === "to" && DIRECTIONS.has(rest[0]) && rest[1] && rest[2]) void splitOnto(rest[0], rest[1], rest.slice(2).join("|"));
  else if (verb === "again" && rest[0]) void reconnect(rest[0]);
  else if (verb === "route" && FORM_DIRECTIONS.has(rest[0]) && rest[1]) void openRouteForm(rest[0], rest.slice(1).join("|"));
}

const KIND_NAMES = new Set(KINDS.map(([k]) => k));

/** Runs a thread command from a menu; anything but opening the dialog needs the person's pick. */
function threadCommand(arg, person) {
  const [verb, ...rest] = arg.split("|");
  if (verb === "new") return openThreadForm({ kind: KIND_NAMES.has(rest[0]) ? rest[0] : "fix" });
  if (verb === "edit") return editThread(rest[0] || focused()?.space);
  if (verb === "confirm" && rest[0]) return askResolve(rest[0]);
  if (!person || !rest[0]) return;
  const space = spaces().find((s) => s.id === rest[0]);
  if (verb === "kind" && space && KIND_NAMES.has(rest[1])) setShared(THREADS, mark(shared(THREADS), space, rest[1]));
  else if (verb === "release") setShared(THREADS, release(shared(THREADS), rest[0]));
  else if (verb === "forget") setShared(THREADS, forget(shared(THREADS), rest[0]));
  else if (verb === "resolve" && space && shared(THREADS)?.threads?.[space.id]) {
    // Out of the threads first, so the space closing doesn't read as a thread lost; then its panes and terminals go.
    setShared(THREADS, resolve(shared(THREADS), space));
    run("space.close", { id: space.id, confirmed: true });
  }
}

/** Opens the dialog on the thread of a space; says so when that space isn't a thread. */
function editThread(id) {
  if (id && shared(THREADS)?.threads?.[id]) return openThreadForm({ edit: id });
  notify({ title: "This space isn't a thread", body: "Make it one from its menu in the sidebar, or open a new thread.", level: "info", timeout: 4000 });
}

/** Asks before resolving a thread, saying what closes with it: a menu whose Resolve the person picks, Cancel first. */
export function askResolve(id) {
  const space = spaces().find((s) => s.id === id);
  if (!space) return;
  const n = activity(space, panes()).panes;
  const closes = n === 0 ? "It has no panes open." : `Closes its ${n === 1 ? "pane" : `${n} panes`} and the terminals in ${n === 1 ? "it" : "them"}.`;
  openMenu(
    [
      { info: true, icon: "circle-check", label: `Resolve “${space.name}”?` },
      { info: true, label: closes },
      "separator",
      { label: "Cancel", icon: "x" },
      { label: "Resolve and close", icon: "circle-check", destructive: true, command: `thread:resolve|${id}` },
    ],
    { width: 340, clickOnly: true },
  );
}

/** Runs a Spaces folder command from a menu; anything but folding needs the person's pick. */
function folderCommand(arg, person) {
  const [verb, ...rest] = arg.split("|");
  const groups = shared(FOLDERS);
  if (verb === "fold" && rest[0]) return setShared(FOLDERS, toggleFolder(groups, rest[0]));
  if (!person) return;
  if (verb === "space" && rest[0]) run("space.new", { machine: rest[0] === "local" ? "" : rest.join("|") });
  else if (verb === "new") openFolderName({ machine: rest[0] || null });
  else if (verb === "rename" && rest[0]) openFolderName({ id: rest[0] });
  else if (verb === "delete" && rest[0]) setShared(FOLDERS, deleteFolder(groups, rest[0]));
  else if (verb === "move" && rest[0] && rest[1]) setShared(FOLDERS, moveMachine(groups, rest.slice(1).join("|"), rest[0]));
  else if (verb === "out" && rest[0]) setShared(FOLDERS, moveMachine(groups, rest.join("|"), null));
}

/** What only the Flow layout's runner has: Home and the lone agent. */
const OWN = {
  flow: {
    home: () => show((shared("flow.app") ?? "home") === "home" ? "work" : "home"),
    "agent-view": () => {
      const on = shared("flow.view") === "agent";
      run("layout.select", { stack: "view", child: on ? "main" : "agent" });
      setShared("flow.view", on ? "main" : "agent");
      if ((shared("flow.app") ?? "home") !== "work") show("work");
    },
  },
};

const has = (table, name) => Object.prototype.hasOwnProperty.call(table, name);

/** Whether a layout has this screen. */
const hasScreen = (layout, child) => Boolean(screensOf(layout)?.list.some((s) => s.child === child));

/** Whether an argument names something the layout has: a screen of its own for `go:`, a panel for `panel:`. */
function argOk(name, arg, layout) {
  if (name === "go:") return arg === "work" || hasScreen(layout, arg);
  if (name === "panel:") return has(PANELS, arg);
  return true;
}

/** The handler a command reaches in a layout, with its argument; null when the runner has none. */
function lookup(c, layout) {
  const tables = [OWN[layout] ?? {}, WINDOW];
  for (const t of tables) if (has(t, c)) return { fn: t[c], arg: undefined };
  for (const t of tables) {
    for (const name of Object.keys(t)) {
      if (!name.endsWith(":") || !c.startsWith(name) || c.length <= name.length) continue;
      const arg = c.slice(name.length);
      return argOk(name, arg, layout) ? { fn: t[name], arg } : null;
    }
  }
  return null;
}

/** The names the runner of a layout handles; one ending in ":" takes the rest of the command as its argument. */
export const runnerCommands = (layout) => [...Object.keys(OWN[layout] ?? {}), ...Object.keys(WINDOW)];

/** Whether the runner of a layout handles `flow.<c>`. */
export const handles = (layout, c) => Boolean(lookup(c, layout));

/** Whether `flow.<c>` does something in a layout: its runner handles it, or a view of that layout does. */
export function available(layout, c) {
  const e = CATALOGUE.find((x) => x.command === `flow.${c}`);
  return handles(layout, c) || Boolean(e?.layouts?.includes(layout));
}

/** Puts `flow.app` back on a screen of the shown layout: one carried over from the other layout names none of its. */
export function settle() {
  const s = screens();
  const valid = (child) => s.list.some((x) => x.child === child);
  if (valid(shared("flow.app"))) return;
  const shown = shownScreen();
  setShared("flow.app", valid(shown) ? shown : s.first);
}

/**
 * Runs a window command from the runner of `layout`, only while that layout shows; true when it was one. `ctx.key` is
 * the key a menu, the palette or a click sent it with: the handler gets `ctx.person`, true when it names this command.
 */
export function runCommand(c, cx, layout, ctx = {}) {
  if (layoutName() !== layout) return false;
  const found = lookup(c, layout);
  if (!found) return false;
  found.fn(found.arg, cx, { ...ctx, person: take(c, ctx.key ?? null) });
  return true;
}
