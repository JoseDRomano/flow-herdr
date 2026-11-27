// The hub's notifications in the Herdr app: Herdr's own toast while the window is in front, its click bringing the row
// the notification is about into view (where its other buttons are); the system's notification while it is behind,
// whose click and buttons lead to the same row through `cockpit focus herdr-app:<target>`.

import { notify, window as win } from "herdr";
import * as hub from "./hub.js";
import { openUpdate } from "./update.js";
import { MR_URL } from "./gitlab.js";

const LEVEL = { "🔴": "error", "❌": "error", "⚠️": "warning", "✅": "success", "🟢": "success", "🚀": "success" };

const WHERE = { runbook: "the runbook", meeting: "Meetings", monitor: "the monitor", routine: "Routines", space: "Flow" };

/**
 * A notification from the hub, {title, body, action, row, buttons, from}: shown as fits the window. One a client sent
 * (`from` names who) is drawn plain, never with cockpit's icon or a success or failure colour its words may claim.
 */
export function deliver(n, install, cx) {
  const always = Boolean(install?.machine) || install?.env?.COCKPIT_TOASTS === "always";
  if (!win().active && !always) {
    cx.spawn(async () => hub.cockpit(["notify", "--system", n.title ?? "", n.body ?? "", n.action ?? "", ...(n.buttons ?? [])]));
    return;
  }
  const level = n.from ? "info" : (Object.entries(LEVEL).find(([mark]) => `${n.title ?? ""} ${n.body ?? ""}`.includes(mark))?.[1] ?? "info");
  const target = n.row || n.action || "";
  const labels = (n.buttons ?? []).map((b) => b.split("=")[0]).filter(Boolean);
  const where = WHERE[target.split(":")[0]];
  // The toast has one action: the other buttons wait on the row it opens, and say so.
  const more = labels.length && where ? `\n${labels.join(" · ")} in ${where}` : "";
  notify({
    title: n.title ?? "",
    body: `${n.body ?? ""}${more}`,
    level,
    ...(n.from ? {} : { icon: "mods/flow/flow.svg" }),
    timeout: level === "error" ? 12000 : 6000,
    ...(target ? { action: { name: `flow.target:${target}` } } : {}),
  });
}

/**
 * "https://github.com/acme/api/pull/4" out of that PR's URL or one of its pages, the same for a GitLab merge request's,
 * else the reference as given.
 */
const prOf = (ref) => (/^(https?:\/\/[^\s]*?\/pull\/\d+)/.exec(ref) ?? MR_URL.exec(ref))?.[1] ?? ref;

/**
 * Where a notification's button leads: `act:<review|ci|rerun|merge>:<PR>` to the PR's page, `act:plan:<ticket>` to the
 * ticket's row and `act:routine:<slug>` to the routine; any other target is itself.
 */
export function rowOf(target) {
  const found = /^(?:herdr-app:)?act:([a-z]+):(.+)$/.exec(target);
  if (!found) return target;
  const [, kind, ref] = found;
  if (kind === "routine") return `routine:${ref}`;
  if (kind === "plan") return `inbox:${ref.toUpperCase()}`;
  return prOf(ref);
}

/**
 * What a toast's click asks, which only ever navigates: a URL opens, the update its dialog, the rest goes through
 * `cockpit focus` (rows, spaces, tabs), a button's action as the row it is about.
 */
export function follow(target, cx) {
  const row = rowOf(target);
  if (/^https?:\/\//.test(row)) cx.spawn(async () => hub.openUrl(row));
  else if (target === "update") openUpdate();
  // A remote desk refuses what needs its own terminals: the click says so instead of going nowhere.
  else cx.spawn(async () => hub.cockpit(["focus", row]).catch((e) => notify({ title: "Could not follow it", body: String(e?.message ?? e), level: "warning", timeout: 5000 })));
}
