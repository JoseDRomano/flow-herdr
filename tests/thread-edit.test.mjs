import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, mark, edit, threadFolder, folderOn, split } from "../mods/flow/threads.js";

// A thread on this computer, and one on acme-build reached from it.
const local = { kind: "fix", title: "ENG-412", machine: null, at: 1, where: null };
const away = { kind: "feature", title: "Scope", machine: "acme-build", at: 2, where: { machine: "acme-build", folder: "/srv/acme/scope", argv: null, pane: null } };
const store = { threads: { s1: local, "acme-build/s5": away }, pending: [], resolved: [] };

test("editing a thread changes its kind and title, and keeps the rest", () => {
  const next = edit(store, "s1", { kind: "bug", title: "  Login loops on SSO ", folder: "" });
  assert.deepEqual(next.threads.s1, { kind: "bug", title: "Login loops on SSO", machine: null, at: 1, where: null });
  assert.deepEqual(next.threads["acme-build/s5"], away, "the other thread stays as it was");
});

test("an unknown kind or an empty title leaves that one as it was, and an unknown thread changes nothing", () => {
  const next = edit(store, "s1", { kind: "chore", title: "  " });
  assert.equal(next.threads.s1.kind, "fix");
  assert.equal(next.threads.s1.title, "ENG-412");
  assert.deepEqual(edit(store, "nope", { kind: "bug", title: "x" }).threads, normalize(store).threads);
});

test("a thread on its own machine keeps its folder on itself, and splits onto that machine start there", () => {
  const next = edit(store, "s1", { kind: "fix", title: "ENG-412", folder: "/Users/maya/src/acme" });
  assert.equal(next.threads.s1.folder, "/Users/maya/src/acme");
  assert.equal(threadFolder(next.threads.s1), "/Users/maya/src/acme");
  assert.equal(folderOn(next, "s1", "local"), "/Users/maya/src/acme");
  assert.equal(folderOn(next, "s1", "acme-build"), null, "a split onto another machine doesn't take it");
  assert.equal(normalize(next).threads.s1.folder, "/Users/maya/src/acme", "the store keeps it");
  assert.equal(split(next, [{ id: "s1", name: "ENG-412" }]).threads[0].thread.folder, "/Users/maya/src/acme");
});

test("a thread working on another machine keeps its folder in where it works", () => {
  const next = edit(store, "acme-build/s5", { kind: "feature", title: "Scope", folder: "/srv/acme/web" });
  assert.equal(next.threads["acme-build/s5"].where.folder, "/srv/acme/web");
  assert.equal("folder" in next.threads["acme-build/s5"], false);
  assert.equal(folderOn(next, "acme-build/s5", "acme-build"), "/srv/acme/web");
});

test("an empty folder clears it, and a folder that isn't a full path isn't kept", () => {
  const set = edit(store, "s1", { kind: "fix", title: "ENG-412", folder: "/Users/maya/src/acme" });
  assert.equal("folder" in edit(set, "s1", { kind: "fix", title: "ENG-412", folder: "" }).threads.s1, false);
  assert.equal(edit(store, "acme-build/s5", { kind: "feature", title: "Scope", folder: "" }).threads["acme-build/s5"].where.folder, null);
  assert.equal("folder" in normalize({ threads: { s1: { ...local, folder: "src/acme" } } }).threads.s1, false);
  assert.equal(threadFolder(local), null);
});

test("changing a thread's kind from its menu keeps its folder", () => {
  const set = edit(store, "s1", { kind: "fix", title: "ENG-412", folder: "/Users/maya/src/acme" });
  assert.equal(mark(set, { id: "s1", name: "ENG-412", machine: null }, "bug").threads.s1.folder, "/Users/maya/src/acme");
});
