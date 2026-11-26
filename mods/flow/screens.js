// Which screen the window shows in the Flow layout: its screens stack under `center`, and `work` is where you deal
// with an agent, its panes.

import { run, shared, setShared, layout, focused, agents, notify } from "herdr";

/** The cockpit apps the layout stacks after its own screens: [child, label, icon]. */
const APPS = [
  ["inbox", "Inbox", "inbox"],
  ["runbook", "Runbook", "book"],
  ["todo", "To-do", "list-todo"],
  ["meetings", "Meetings", "calendar"],
  ["monitor", "Monitor", "activity"],
  ["routines", "Routines", "clock"],
  ["mail", "Mail", "mail"],
];

/** A screen as the palette, the app strip and the keys sheet name it, with the command its key is bound to. */
const screen = ([child, label, icon], command = `flow.go:${child}`) => ({ child, label, icon, command });

const LAYOUTS = {
  flow: {
    stack: "center",
    work: "work",
    first: "home",
    list: [screen(["home", "Home", "layout-dashboard"], "flow.home"), screen(["work", "Work", "terminal"]), ...APPS.map((a) => screen(a))],
  },
};

/**
 * The Flow layout a layout is, or is a copy of: its own name, the name its file says it was cloned from, else the
 * longest known name it starts with (`flow-copy`); `flow` for any other layout.
 */
export function baseOf(name, readTree = () => layout()) {
  if (LAYOUTS[name]) return name;
  let from = null;
  try {
    from = readTree()?.cloned_from?.name ?? null;
  } catch {}
  if (LAYOUTS[from]) return from;
  return Object.keys(LAYOUTS).filter((n) => String(name ?? "").startsWith(`${n}-`)).sort((a, b) => b.length - a.length)[0] ?? "flow";
}

/** The Flow layout shown, a copy of one counting as the one it copies. */
export function layoutName() {
  return baseOf(shared("layout"));
}

/** The shown layout's own name, whose `layout:<name>` section of keys.json is the one that applies. */
export function shownLayout() {
  return shared("layout") ?? "flow";
}

/** The shown layout's screens; Flow's when it is some other layout. */
export function screens() {
  return LAYOUTS[layoutName()];
}

/** A named layout's screens, or null when Flow has no such layout. */
export function screensOf(name) {
  return LAYOUTS[name] ?? null;
}

/** Shows a screen of the shown layout and gives that app the keyboard. */
export function show(child) {
  const s = screens();
  run("layout.select", { stack: s.stack, child });
  setShared("flow.app", child);
  if (child !== s.work) run(`flow.show:${child}`);
}

/** A node of the shown layout by id, or null. */
export function nodeOf(id, tree = layout()) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.id === id) return tree;
  for (const c of [...(tree.children ?? []), ...(tree.floating ?? [])]) {
    const found = nodeOf(id, c);
    if (found) return found;
  }
  return null;
}

/** Whether a block showing one agent alone (`{agent: "focused"}`) is on screen: not hidden, nor a stack's other child. */
function agentBlockShown(node, visible = true) {
  if (!visible || !node || typeof node !== "object" || node.hidden) return false;
  if (node.content?.agent) return true;
  const active = node.type === "stack" ? (node.active ?? node.children?.[0]?.id) : null;
  return (node.children ?? []).some((c) => agentBlockShown(c, node.type !== "stack" || c.id === active));
}

/**
 * The agent of `list` (rows with `address` and `tab`) the window shows: the agent block's while one is on screen, else
 * the focused pane's, else one in the tab in front. Herdr names a first agent for its blocks even when the tab in front
 * runs none; that one never counts.
 */
export function agentInView(list, f = focused(), tree = layout()) {
  if (!f || !list?.length) return null;
  const at = (address) => (address ? (list.find((a) => a.address === address) ?? null) : null);
  if (f.agent && agentBlockShown(tree)) return at(f.agent);
  return at(f.shown ?? f.terminal) ?? (f.tab ? (list.find((a) => a.tab === f.tab) ?? null) : null);
}

/**
 * The address of the agent in view among Herdr's agents and `more` (rows the hub lists, with `address` and `tab`): null
 * on a tab no agent runs in.
 */
export function frontAgent(f = focused(), more = []) {
  return agentInView([...agents(), ...more], f)?.address ?? null;
}

/** Shows where you deal with the agent: its panes. */
export function showWork() {
  show(screens().work);
}

/** A view the side panel opens on once it follows that view's terminal: `{terminal, name, at}`, for a few seconds. */
export const PENDING_VIEW = "flow.show.pending";

/** Says a session cockpit drives can't be shown: it runs without a terminal, and Flow shows agents in theirs. */
export function noTerminal(title = null) {
  notify({ title: `${title ?? "This session"} runs without a terminal`, body: "Flow shows agents in their terminals, and cockpit drives this one by itself.", level: "info", timeout: 6000 });
}
