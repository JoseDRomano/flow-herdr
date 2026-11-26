import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, addFolder, renameFolder, deleteFolder, toggleFolder, moveMachine, folderOf, arrange, newId, machineKey, machineOfKey, machineOrder, byMachine } from "../mods/flow/folders.js";

// The Spaces folders over the acme machines: this computer, acme-build, acme-db and acme-dev.
const keys = ["local", "acme-build", "acme-db", "acme-dev"];

test("a new folder takes the machine it was made from, out of any other folder", () => {
  let { groups, id } = addFolder([], "Acme", "acme-db", "f1");
  assert.equal(id, "f1");
  assert.deepEqual(groups, [{ id: "f1", name: "Acme", machines: ["acme-db"], folded: false }]);
  ({ groups } = addFolder(groups, "  Staging ", "acme-db", "f2"));
  assert.deepEqual(groups.map((g) => [g.name, g.machines]), [["Acme", []], ["Staging", ["acme-db"]]]);
});

test("a folder needs a name", () => {
  assert.deepEqual(addFolder([], "   ", "acme-db", "f1"), { groups: [], id: null });
  const groups = addFolder([], "Acme", null, "f1").groups;
  assert.deepEqual(renameFolder(groups, "f1", ""), groups, "an empty rename keeps the name");
  assert.equal(renameFolder(groups, "f1", " Build ")[0].name, "Build");
});

test("a machine moves between folders, and out of them, and is in one at most", () => {
  let groups = addFolder([], "Acme", "acme-db", "f1").groups;
  groups = addFolder(groups, "Build", null, "f2").groups;
  groups = moveMachine(groups, "acme-db", "f2");
  assert.equal(folderOf(groups, "acme-db").id, "f2");
  assert.deepEqual(groups.find((g) => g.id === "f1").machines, []);
  groups = moveMachine(groups, "acme-db", null);
  assert.equal(folderOf(groups, "acme-db"), null);
  assert.deepEqual(normalize([{ id: "a", name: "A", machines: ["x"] }, { id: "b", name: "B", machines: ["x", "y"] }]).map((g) => g.machines), [["x"], ["y"]]);
});

test("deleting a folder puts its machines back and folding toggles", () => {
  let groups = addFolder([], "Acme", "acme-db", "f1").groups;
  assert.equal(toggleFolder(groups, "f1")[0].folded, true);
  assert.equal(toggleFolder(toggleFolder(groups, "f1"), "f1")[0].folded, false);
  groups = deleteFolder(groups, "f1");
  assert.deepEqual(groups, []);
  assert.deepEqual(arrange(groups, keys).map((x) => x.key), keys);
});

test("a folder stands where its first machine is, holding its machines in the list's order", () => {
  const groups = [{ id: "f1", name: "Acme", machines: ["acme-dev", "acme-build"], folded: false }];
  const list = arrange(groups, keys);
  assert.deepEqual(list.map((x) => (x.kind === "machine" ? x.key : `[${x.folder.name}: ${x.members.join(", ")}]`)), ["local", "[Acme: acme-build, acme-dev]", "acme-db"]);
});

test("a machine not shown stays in its folder, and an empty folder comes last", () => {
  const groups = [
    { id: "f1", name: "Asleep", machines: ["acme-old"], folded: false },
    { id: "f2", name: "Acme", machines: ["acme-db", "acme-old"], folded: true },
  ];
  const list = arrange(groups, keys);
  assert.deepEqual(list.map((x) => (x.kind === "machine" ? x.key : `[${x.folder.name}: ${x.members.join(", ")}]`)), ["local", "acme-build", "[Acme: acme-db]", "acme-dev", "[Asleep: ]"]);
  assert.deepEqual(normalize(groups)[1].machines, ["acme-db"], "a machine is kept by the first folder naming it");
  assert.deepEqual(normalize(groups)[0].machines, ["acme-old"]);
});

test("malformed stored folders are dropped, and ids are fresh", () => {
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize([null, { id: "", name: "x" }, { id: "a", name: " " }, { id: "b", name: "B", machines: "nope" }]), [{ id: "b", name: "B", machines: [], folded: false }]);
  const groups = [{ id: `f${(1000).toString(36)}`, name: "A", machines: [] }];
  assert.notEqual(newId(groups, 1000), groups[0].id);
  assert.equal(machineKey(null), "local");
  assert.equal(machineOfKey("local"), null);
  assert.equal(machineOfKey("acme-db"), "acme-db");
});

test("Home's machine boxes follow the sidebar: this computer first, then by name, a folder's machines together", () => {
  assert.deepEqual(machineOrder([], ["acme-dev", "local", "acme-build", "acme-dev"]), ["local", "acme-build", "acme-dev"]);
  const groups = [{ id: "f1", name: "Acme", machines: ["acme-dev", "acme-build"], folded: true }];
  assert.deepEqual(machineOrder(groups, ["acme-db", "acme-dev", "acme-build", "local"]), ["local", "acme-build", "acme-dev", "acme-db"]);
});

test("cards go in a box per machine, keeping their order, with no empty box", () => {
  const cards = [{ id: 1, m: "acme-db" }, { id: 2, m: "local" }, { id: 3, m: "acme-db" }, { id: 4, m: "acme-new" }];
  const boxes = byMachine(cards, (c) => c.m, ["local", "acme-build", "acme-db"]);
  assert.deepEqual(boxes.map((b) => [b.key, b.items.map((c) => c.id)]), [["local", [2]], ["acme-db", [1, 3]], ["acme-new", [4]]]);
});
