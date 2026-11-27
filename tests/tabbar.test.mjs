// Flow's tab bar (tabbar.js): a tab's name, each space's own side panel kept across space switches, and the wheel
// stepping through tabs one at a time.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

const world = { ran: [], shared: {}, store: {}, tree: null };
const node = (id, extra = {}) => ({ id, ...extra });
const treeWith = (panel) => ({ id: "root", children: [node("panel", { hidden: !panel, children: [node("panel-body", { active: panel ?? "show" })] })] });

const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const stub = () => new Proxy(function () {}, { get: () => stub(), apply: () => stub() });
const findNode = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => findNode(c, id)).find(Boolean) ?? null);
const imports = {
  "gpui-kit": { div: stub() },
  "gpui-base": { h_flex: stub(), ScrollHandle: { new: () => ({ scroll_to_item() {} }) } },
  herdr: {
    spaces: () => [],
    panes: () => [],
    run: (command, args) => world.ran.push([command, args]),
    openOverlay: () => {},
    window: () => null,
    shared: (k) => world.shared[k] ?? null,
    setShared: (k, v) => (world.shared[k] = v),
    layout: () => world.tree,
  },
  "./status.js": { findNode },
  "./ui.js": { tokens: stub(), TEXT: {}, Icon: stub(), Spinner: stub() },
};
const localStorage = { getItem: (k) => world.store[k] ?? null, setItem: (k, v) => (world.store[k] = v) };
const context = createContext({ console, Date, JSON, Math, String, Number, Boolean, Object, Array, Error, localStorage });
const source = await readFile(new URL("../mods/flow/tabbar.js", import.meta.url), "utf8");
const mod = new SourceTextModule(source, { context, identifier: "tabbar.js" });
await mod.link(async (name) => new SyntheticModule(Object.keys(imports[name]), function () {
  for (const [k, v] of Object.entries(imports[name])) this.setExport(k, v);
}, { context }));
await mod.evaluate();
const { TabBar, tabName, panelToShow } = mod.namespace;

test("a tab is named as the person named it, else after its agent or program", () => {
  assert.equal(tabName({ named: true, name: "acme-web" }, { program: { name: "Claude" } }), "acme-web");
  assert.equal(tabName({ named: false, name: "3" }, { program: { name: "Claude" } }), "Claude");
  assert.equal(tabName({ named: false, name: "3" }, null), "Terminal");
});

test("a space shows the panel it had, only among those the bar may restore", () => {
  assert.equal(panelToShow({ s1: "files" }, "s1", ["files", "changes"]), "files");
  assert.equal(panelToShow({ s1: "web" }, "s1", ["files", "changes"]), null);
  assert.equal(panelToShow({}, "s2", ["files"]), null);
});

test("switching spaces restores each one's panel, and opening or closing it is remembered", () => {
  world.shared["workspace.panels"] = ["files", "changes"];
  const bar = new TabBar();
  bar.init();
  // The first space seen: the panel already shown is its own, nothing is run.
  world.tree = treeWith("files");
  bar.keepPanel({ id: "s1" }, world.tree);
  assert.deepEqual(plain(world.ran), []);
  assert.deepEqual(JSON.parse(world.store["flow.tabs.panels"]), { s1: "files" });
  // A space never seen opens with no panel.
  bar.keepPanel({ id: "s2" }, world.tree);
  assert.deepEqual(plain(world.ran.at(-1)), ["layout.hide", { id: "panel" }]);
  // While that restore lands, the panel still shown is not recorded as s2's.
  bar.keepPanel({ id: "s2" }, world.tree);
  assert.equal(JSON.parse(world.store["flow.tabs.panels"]).s2, undefined);
  world.tree = treeWith(null);
  bar.keepPanel({ id: "s2" }, world.tree);
  assert.equal(JSON.parse(world.store["flow.tabs.panels"]).s2, null);
  // Back on s1, its Files panel comes back.
  world.ran = [];
  bar.keepPanel({ id: "s1" }, world.tree);
  assert.deepEqual(plain(world.ran), [["layout.select", { stack: "panel-body", child: "files" }], ["layout.show", { id: "panel" }]]);
});

test("the wheel steps one tab per notch, and a swipe one tab per stretch", () => {
  const bar = new TabBar();
  bar.init();
  world.ran = [];
  bar.wheel({ delta_lines: { y: -1 } });
  assert.deepEqual(plain(world.ran), [["tab.next", null]]);
  world.ran = [];
  for (let i = 0; i < 3; i++) bar.wheel({ delta: { y: 10 } });
  assert.deepEqual(plain(world.ran), [], "a short swipe is not yet a step");
  bar.wheel({ delta: { y: 15 } });
  assert.deepEqual(plain(world.ran), [["tab.prev", null]]);
});
