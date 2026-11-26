// Folders of machines in the sidebar's Spaces list: a person's own grouping (a "Scope" folder holding scope and
// scope-dev), kept in shared state under FOLDERS. Plain functions over the list, so the sidebar, the menu commands and
// the name dialog change it the same way and tests run them without a window.

/** The shared-state key holding the folders: `[{ id, name, machines: [<machine key>], folded }]`. */
export const FOLDERS = "flow.spaces.groups";

/** A machine's key in a folder: its name, or "local" for this computer (whose machine is null). */
export const machineKey = (m) => m ?? "local";

/** The machine a key names: null for this computer. */
export const machineOfKey = (key) => (key === "local" ? null : key);

/** The folders as stored, cleaned: unnamed or malformed entries dropped, each machine in its first folder only. */
export function normalize(groups) {
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g.id !== "string" || !g.id || typeof g.name !== "string" || !g.name.trim()) continue;
    const machines = (Array.isArray(g.machines) ? g.machines : []).filter((m) => typeof m === "string" && m && !seen.has(m));
    machines.forEach((m) => seen.add(m));
    out.push({ id: g.id, name: g.name.trim(), machines, folded: Boolean(g.folded) });
  }
  return out;
}

/** A fresh folder id, unique among the given folders. */
export function newId(groups, now = Date.now()) {
  const ids = new Set(normalize(groups).map((g) => g.id));
  let n = now;
  while (ids.has(`f${n.toString(36)}`)) n++;
  return `f${n.toString(36)}`;
}

/** The folder holding a machine key, or null. */
export const folderOf = (groups, key) => normalize(groups).find((g) => g.machines.includes(key)) ?? null;

/** Takes a machine out of every folder. */
const without = (groups, key) => groups.map((g) => ({ ...g, machines: g.machines.filter((m) => m !== key) }));

/** Adds a folder named `name`, with `key`'s machine moved into it when given; returns the folders and the new id. */
export function addFolder(groups, name, key = null, id = newId(groups)) {
  const clean = String(name ?? "").trim();
  if (!clean) return { groups: normalize(groups), id: null };
  const rest = key ? without(normalize(groups), key) : normalize(groups);
  return { groups: [...rest, { id, name: clean, machines: key ? [key] : [], folded: false }], id };
}

/** Renames a folder; an empty name leaves it as it was. */
export function renameFolder(groups, id, name) {
  const clean = String(name ?? "").trim();
  return normalize(groups).map((g) => (g.id === id && clean ? { ...g, name: clean } : g));
}

/** Removes a folder; its machines go back to the top level. */
export const deleteFolder = (groups, id) => normalize(groups).filter((g) => g.id !== id);

/** Folds a folder away, or opens it again. */
export const toggleFolder = (groups, id) => normalize(groups).map((g) => (g.id === id ? { ...g, folded: !g.folded } : g));

/** Moves a machine into a folder, out of any other; a null or unknown id takes it out of every folder. */
export function moveMachine(groups, key, id) {
  const rest = without(normalize(groups), key);
  return rest.map((g) => (g.id === id ? { ...g, machines: [...g.machines, key] } : g));
}

/**
 * The Spaces list's order for these machine keys (this computer first, then by name, as the sidebar has them): a
 * machine in no folder stands alone; a folder takes the place of its first machine shown, with its shown machines in
 * the list's order. Folders with no machine shown (new, or all their machines gone) come last. Machines a folder holds
 * that aren't shown stay in it, so a sleeping machine keeps its place.
 */
export function arrange(groups, keys) {
  const folders = normalize(groups);
  const shown = new Set(keys);
  const placed = new Set();
  const out = [];
  for (const key of keys) {
    const g = folders.find((f) => f.machines.includes(key));
    if (!g) out.push({ kind: "machine", key });
    else if (!placed.has(g.id)) {
      placed.add(g.id);
      out.push({ kind: "folder", folder: g, members: keys.filter((k) => g.machines.includes(k)) });
    }
  }
  for (const g of folders) if (!placed.has(g.id)) out.push({ kind: "folder", folder: g, members: g.machines.filter((k) => shown.has(k)) });
  return out;
}

/** Machine keys in the sidebar's order: this computer, then by name, each folder's machines together where it stands. */
export function machineOrder(groups, keys) {
  const sorted = [...new Set(keys)].sort((a, b) => (a === "local" ? -1 : b === "local" ? 1 : a.localeCompare(b)));
  return arrange(groups, sorted).flatMap((x) => (x.kind === "machine" ? [x.key] : x.members));
}

/** Items in a box per machine, the boxes in `order` (any key it misses after it), each keeping the items' own order. */
export function byMachine(items, keyOf, order = []) {
  const boxes = new Map(order.map((key) => [key, []]));
  for (const item of items) {
    const key = keyOf(item);
    if (!boxes.has(key)) boxes.set(key, []);
    boxes.get(key).push(item);
  }
  return [...boxes].filter(([, list]) => list.length).map(([key, list]) => ({ key, items: list }));
}
