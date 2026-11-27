// Threads: a fix, a feature or a bug being worked on, each a space on the machine it works on (the main machine,
// flow.json's `main`, this computer by default). A thread on another machine (`where`) is a Herdr space there, in its
// folder there, so Herdr pastes images and drops files onto that machine; a split onto that machine starts in that folder
// too. A thread whose `where` has an `argv` lives on the main machine instead, its first pane a bridge there. The sidebar
// lists threads in place of spaces. Pure helpers only: the dialog (thread-form.js), the sidebar and the splits
// (termmenu.js) run them in Herdr.

/**
 * The shared-state key holding the threads: `{ threads: { [space id]: { kind, title, machine, at, where, folder? } },
 * pending, resolved }`. `machine` is the space's (null for this computer); `where` is `{ machine, folder, argv, pane }`
 * when the thread works on a machine other than the main one (`local` for this computer), else null; `argv` and `pane`
 * only for a bridge thread. `folder`, kept only when set, is the folder of a thread without `where` on its own machine.
 * `resolved` lists the threads marked done, newest first, whose spaces were closed:
 * `[{ id, kind, title, where, at, resolvedAt }]`.
 */
export const THREADS = "flow.threads";

/** What a thread is about: [kind, label, icon]. */
export const KINDS = [
  ["fix", "Fix", "wrench"],
  ["feature", "Feature", "sparkles"],
  ["bug", "Bug", "bug"],
];

const KIND_SET = new Set(KINDS.map(([k]) => k));

/** A kind's label and icon, Fix's for one it doesn't know. */
export const kindOf = (kind) => KINDS.find(([k]) => k === kind) ?? KINDS[0];

/** How long a thread waits for its space to show before it is given up, ms. */
export const PENDING_MS = 120_000;

/** How many resolved threads the list keeps. */
export const RESOLVED_KEPT = 50;

/** The main machine flow.json names (`main`), null for this computer: unset, empty and `local` all mean this one. */
export function mainMachine(config) {
  const m = config?.main;
  return typeof m === "string" && m.trim() && m.trim() !== "local" ? m.trim() : null;
}

/** A thread's `where` as kept: a machine, its folder there, the program its first pane ran and that pane; else null. */
export function whereOf(w) {
  if (!w || typeof w.machine !== "string" || !w.machine) return null;
  const argv = Array.isArray(w.argv) && w.argv.length && w.argv.every((x) => typeof x === "string") ? w.argv : null;
  return { machine: w.machine, folder: typeof w.folder === "string" && w.folder ? w.folder : null, argv, pane: typeof w.pane === "string" && w.pane ? w.pane : null };
}

/** A folder as kept: a full path, else null. */
const fullPath = (f) => (typeof f === "string" && f.startsWith("/") ? f : null);

/** The store as kept, cleaned: threads with a known kind and a title, pending ones well formed. */
export function normalize(stored) {
  const threads = {};
  for (const [id, t] of Object.entries(stored?.threads ?? {})) {
    if (!id || !t || typeof t.title !== "string" || !t.title.trim()) continue;
    const machine = typeof t.machine === "string" && t.machine ? t.machine : null;
    const folder = fullPath(t.folder);
    threads[id] = { kind: KIND_SET.has(t.kind) ? t.kind : "fix", title: t.title.trim(), machine, at: Number(t.at) || 0, where: whereOf(t.where), ...(folder ? { folder } : {}) };
  }
  const pending = (Array.isArray(stored?.pending) ? stored.pending : []).filter(
    (p) => p && typeof p.title === "string" && p.title.trim() && KIND_SET.has(p.kind) && Array.isArray(p.before),
  );
  const resolved = (Array.isArray(stored?.resolved) ? stored.resolved : [])
    .filter((r) => r && typeof r.id === "string" && r.id && typeof r.title === "string" && r.title.trim())
    .map((r) => ({ id: r.id, kind: KIND_SET.has(r.kind) ? r.kind : "fix", title: r.title.trim(), where: whereOf(r.where), at: Number(r.at) || 0, resolvedAt: Number(r.resolvedAt) || 0 }))
    .slice(0, RESOLVED_KEPT);
  return { threads, pending, resolved };
}

/** A folder as typed, read from `home`: `~` is the home folder, `~/x` and a bare `x/y` are in it; empty when none. */
export function folderPath(text, home) {
  const t = String(text ?? "").trim();
  if (!t || t.startsWith("/")) return t;
  if (t === "~") return home;
  if (t.startsWith("~/")) return `${home}${t.slice(1)}`;
  return `${home.replace(/\/+$/, "")}/${t.replace(/^\.\//, "")}`;
}

/**
 * The machines a thread can work on, as [key, label]: the main machine first (`main` null: this computer, key `local`),
 * then this computer when the main machine is another one, then the others `hc machine ls` lists, by name.
 */
export function targetChoices(main, names = []) {
  const mainKey = main ?? "local";
  const label = (key) => (key === "local" ? "This computer" : key);
  const rest = [...(main ? ["local"] : []), ...[...new Set(names)].filter((n) => n && n !== main && n !== "local").sort()];
  return [[mainKey, `${label(mainKey)} · main`], ...rest.map((n) => [n, label(n)])];
}

/** What the form asks for, checked: an error to show, or null when a thread can start. */
export function problem({ kind, title, folder }) {
  if (!KIND_SET.has(kind)) return "Pick fix, feature or bug.";
  if (!String(title ?? "").trim()) return "Name the thread.";
  if (folder && !folder.startsWith("/")) return "The folder needs a full path, like ~/src/acme.";
  return null;
}

/** The `space.new` arguments that open a thread on `machine` (null or `local`: this computer), in `folder` there. */
export function spaceArgs({ title, folder = "", machine = null }) {
  return { name: title.trim(), machine: !machine || machine === "local" ? "" : machine, focus: true, ...(folder ? { folder } : {}) };
}

/**
 * The store with a thread waiting for its space: Herdr's `space.new` doesn't say which space it made, so the thread
 * takes the first new space on its machine with its name, among those not in `before` (the space ids when it started).
 */
export function begin(stored, { kind, title, machine = null, before = [], at = Date.now(), where = null }) {
  const s = normalize(stored);
  return { ...s, pending: [...s.pending, { kind, title: title.trim(), machine, before, at, where: whereOf(where) }] };
}

/**
 * The store once the spaces Herdr lists are read: each pending thread whose space showed becomes a thread, ones waiting
 * past PENDING_MS are dropped, and threads whose space closed are dropped, unless that space's machine isn't loaded
 * (`loaded(machine)` false), when its spaces aren't listed yet. Returns the same object when nothing changed.
 */
export function settle(stored, spaces, { now = Date.now(), loaded = () => true } = {}) {
  const s = normalize(stored);
  const ids = new Set(spaces.map((sp) => sp.id));
  const threads = { ...s.threads };
  let changed = false;
  for (const [id, t] of Object.entries(threads)) {
    if (!ids.has(id) && loaded(t.machine)) {
      delete threads[id];
      changed = true;
    }
  }
  const pending = [];
  for (const p of s.pending) {
    const before = new Set(p.before);
    const found = spaces.find((sp) => !before.has(sp.id) && !threads[sp.id] && (sp.machine ?? null) === (p.machine ?? null) && sp.name === p.title);
    if (found) {
      threads[found.id] = { kind: p.kind, title: p.title, machine: p.machine ?? null, at: p.at, where: whereOf(p.where) };
      changed = true;
    } else if (now - p.at > PENDING_MS) changed = true;
    else pending.push(p);
  }
  return changed ? { threads, pending, resolved: s.resolved } : stored;
}

/** The store with a space made a thread of `kind` (an existing space, or a thread changing kind). */
export function mark(stored, space, kind, at = Date.now()) {
  const s = normalize(stored);
  if (!space?.id || !KIND_SET.has(kind)) return s;
  const was = s.threads[space.id];
  return { ...s, threads: { ...s.threads, [space.id]: { ...was, kind, title: was?.title ?? space.name, machine: space.machine ?? null, at: was?.at ?? at, where: was?.where ?? null } } };
}

/** The folder a thread works in on its machine: its `where`'s, else its own; null when it names none. */
export const threadFolder = (t) => (t?.where ? t.where.folder : t?.folder) ?? null;

/**
 * The store with a thread's kind, title and folder changed, as the edit dialog saves them: the folder goes in its
 * `where` when it has one, else on the thread itself; an empty folder clears it. A kind it doesn't know, or an empty
 * title, leaves that one as it was.
 */
export function edit(stored, id, { kind, title, folder = null }) {
  const s = normalize(stored);
  const was = s.threads[id];
  if (!was) return s;
  const { folder: _old, ...t } = was;
  const f = fullPath(folder);
  const next = {
    ...t,
    kind: KIND_SET.has(kind) ? kind : t.kind,
    title: String(title ?? "").trim() || t.title,
    ...(t.where ? { where: { ...t.where, folder: f } } : f ? { folder: f } : {}),
  };
  return { ...s, threads: { ...s.threads, [id]: next } };
}

/** The store without the thread of a space: the space stays, among the other spaces. */
export function release(stored, id) {
  const s = normalize(stored);
  const { [id]: _gone, ...threads } = s.threads;
  return { ...s, threads };
}

/**
 * The spaces split for the sidebar: `threads` (each `{ space, thread }`, in Herdr's space order, its title the space's
 * name now, so a rename shows) and `others`, the spaces that aren't threads.
 */
export function split(stored, spaces) {
  const { threads } = normalize(stored);
  const out = { threads: [], others: [] };
  for (const space of spaces) {
    const t = threads[space.id];
    if (t) out.threads.push({ space, thread: { ...t, title: space.name || t.title } });
    else out.others.push(space);
  }
  return out;
}

/** How far the pointer moves, px, before a press on a thread becomes a drag rather than a click. */
export const DRAG_PX = 4;

/**
 * Where a dragged thread would land among cards of these heights, each followed by `gap` px, the pointer `y` px below the
 * list's top: the slot before the first card whose middle is below the pointer, or after the last (0 to heights.length).
 */
export function dropSlot(heights, y, gap = 0) {
  let top = 0;
  for (let j = 0; j < heights.length; j++) {
    if (y < top + heights[j] / 2) return j;
    top += heights[j] + gap;
  }
  return heights.length;
}

/**
 * The `space.move` that puts the thread at `from` in the slot `slot` of the thread list (`list`, each `{ id, index,
 * machine }`, `index` its space's place in Herdr's list from 0): `{ id, index }`, `index` from 1. Null when it would stay
 * where it is, or when the slot is beside a thread on another machine, since a space only moves among its machine's.
 */
export function moveTo(list, from, slot) {
  const src = list[from];
  if (!src || slot < 0 || slot > list.length || slot === from || slot === from + 1) return null;
  const near = slot < from ? list[slot] : list[slot - 1];
  if ((near.machine ?? null) !== (src.machine ?? null)) return null;
  return { id: src.id, index: near.index + 1 };
}

/**
 * The first pane of each bridge thread that isn't known as its bridge yet: `[{ id, pane, where }]`, `panes` as Herdr
 * lists them. That pane is the one `space.new` opened running the bridge, the first of its space's first tab.
 */
export function unbridged(stored, spaces, panes) {
  const { threads } = normalize(stored);
  const out = [];
  for (const [id, t] of Object.entries(threads)) {
    if (!t.where?.argv || t.where.pane) continue;
    const tab = spaces.find((sp) => sp.id === id)?.tabs?.[0]?.id;
    const pane = tab ? panes.find((p) => p.tab === tab && p.pane) : null;
    if (pane) out.push({ id, pane: pane.pane, where: t.where });
  }
  return out;
}

/** The store with a thread's first pane known as its bridge, so it is taken once. */
export function bridged(stored, id, pane) {
  const s = normalize(stored);
  const t = s.threads[id];
  if (!t?.where) return s;
  return { ...s, threads: { ...s.threads, [id]: { ...t, where: { ...t.where, pane } } } };
}

/**
 * The folder a split onto `target` (a machine's name, or `local`) starts in, for a pane of the thread of `spaceId`: the
 * thread's folder when it works on that machine (its `where`'s, else its space's own machine), else null.
 */
export function folderOn(stored, spaceId, target) {
  const t = spaceId ? normalize(stored).threads[spaceId] : null;
  if (!t) return null;
  const machine = t.where ? t.where.machine : (t.machine ?? "local");
  return machine === target ? threadFolder(t) : null;
}

/**
 * The store with a thread marked resolved: out of the threads, first in the resolved list under the name its space has
 * now. Closing its space (its panes and their terminals) is the caller's.
 */
export function resolve(stored, space, at = Date.now()) {
  const s = normalize(stored);
  const t = space?.id ? s.threads[space.id] : null;
  if (!t) return s;
  const { [space.id]: _done, ...threads } = s.threads;
  const entry = { id: space.id, kind: t.kind, title: space.name || t.title, where: t.where, at: t.at, resolvedAt: at };
  return { ...s, threads, resolved: [entry, ...s.resolved.filter((r) => r.id !== space.id)].slice(0, RESOLVED_KEPT) };
}

/** The store without a resolved thread (`*`: all of them). */
export function forget(stored, id) {
  const s = normalize(stored);
  return { ...s, resolved: id === "*" ? [] : s.resolved.filter((r) => r.id !== id) };
}

/**
 * What runs in a thread, for its card: its tabs and panes, and how many of its terminals are at each stage
 * (`needs_you`, `failed`, `working`, `done`). `stageOf(pane)` names a pane's stage, or null for a plain shell.
 */
export function activity(space, panes, stageOf = () => null) {
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const mine = panes.filter((p) => tabs.has(p.tab));
  const stages = { needs_you: 0, failed: 0, working: 0, done: 0 };
  for (const p of mine) {
    const stage = stageOf(p);
    if (stage in stages) stages[stage] += 1;
  }
  return { tabs: tabs.size, panes: mine.length, ...stages };
}

/** How long ago `at` was, in a few letters: "now", "5m", "3h", "2d". */
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const m = Math.floor(Math.max(0, now - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (60 * 24))}d`;
}

/**
 * The script that lists a folder's folders on a machine, its argument the folder as typed (empty: the home folder;
 * `~`, `~/x` and a bare `x` read from the home folder): its full path on the first line, then each folder in it, hidden
 * ones left out. A folder that isn't there exits 3.
 */
export const LIST_SCRIPT = [
  'd=${1:-$HOME}',
  'case $d in "~") d=$HOME ;; "~/"*) d="$HOME/${d#"~/"}" ;; /*) ;; *) d="$HOME/$d" ;; esac',
  'cd -- "$d" 2>/dev/null || exit 3',
  "pwd",
  'for f in */; do if [ -d "$f" ]; then printf "%s\\n" "${f%/}"; fi; done',
].join("\n");

/** The listing LIST_SCRIPT printed: `{ path, folders }`, the folders sorted as people read them; null when it says nothing. */
export function parseListing(stdout) {
  const lines = String(stdout ?? "").split("\n").filter((l) => l.length > 0);
  const path = lines.shift();
  if (!path || !path.startsWith("/")) return null;
  const folders = lines.filter((l) => !l.includes("/")).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  return { path, folders };
}

/** A folder inside `path`. */
export const childOf = (path, name) => `${path.replace(/\/+$/, "")}/${name}`;

/** The folder above `path`, or null at the root. */
export function parentOf(path) {
  const trimmed = String(path ?? "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const up = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return up || "/";
}
