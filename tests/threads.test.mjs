import assert from "node:assert/strict";
import { test } from "node:test";
import { THREADS, KINDS, kindOf, mainMachine, normalize, folderPath, problem, spaceArgs, begin, settle, mark, release, split, PENDING_MS, targetChoices, unbridged, bridged, folderOn, resolve, forget, activity, ago, RESOLVED_KEPT, LIST_SCRIPT, parseListing, childOf, parentOf } from "../mods/flow/threads.js";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spaces as Herdr lists them, on this computer and on acme-dev.
const space = (id, name, machine = null) => ({ id, name, machine, tabs: [] });
const api = space("s1", "api");
const web = space("s2", "web");

test("the store keeps its name and the kinds are fix, feature and bug", () => {
  assert.equal(THREADS, "flow.threads");
  assert.deepEqual(KINDS.map(([k]) => k), ["fix", "feature", "bug"]);
  assert.equal(kindOf("bug")[2], "bug");
  assert.equal(kindOf("chore")[0], "fix", "a kind it doesn't know reads as a fix");
});

test("the main machine is flow.json's `main`, this computer when unset, empty or local", () => {
  assert.equal(mainMachine({}), null);
  assert.equal(mainMachine(null), null);
  assert.equal(mainMachine({ main: "" }), null);
  assert.equal(mainMachine({ main: "local" }), null);
  assert.equal(mainMachine({ main: 3 }), null);
  assert.equal(mainMachine({ main: " acme-dev " }), "acme-dev");
});

test("the form needs a kind and a title, and a folder as a full path", () => {
  assert.equal(problem({ kind: "fix", title: "Login loops on SSO", folder: "" }), null);
  assert.equal(problem({ kind: "bug", title: "ENG-412", folder: "/Users/maya/src/acme" }), null);
  assert.match(problem({ kind: "chore", title: "x" }), /fix, feature or bug/);
  assert.match(problem({ kind: "fix", title: "  " }), /Name/);
  assert.match(problem({ kind: "fix", title: "x", folder: "src/acme" }), /full path/);
  assert.equal(folderPath("~", "/Users/maya"), "/Users/maya");
  assert.equal(folderPath(" ~/src/acme ", "/Users/maya"), "/Users/maya/src/acme");
  assert.equal(folderPath("/srv/acme", "/Users/maya"), "/srv/acme");
  assert.equal(folderPath("maya/scope", "/home/maya/"), "/home/maya/maya/scope", "a bare path is in the home folder");
  assert.equal(folderPath("./scope", "/home/maya"), "/home/maya/scope");
  assert.equal(folderPath("", "/home/maya"), "");
});

test("a thread opens as a named, shown space on the main machine", () => {
  assert.deepEqual(spaceArgs({ title: " Export to CSV ", main: null }), { name: "Export to CSV", machine: "", focus: true });
  assert.deepEqual(spaceArgs({ title: "ENG-412", folder: "/srv/acme", main: "acme-dev" }), { name: "ENG-412", machine: "acme-dev", focus: true, folder: "/srv/acme" });
});

test("a pending thread takes the first new space with its name on its machine", () => {
  let store = begin({}, { kind: "bug", title: "api", main: null, before: ["s1"], at: 1000 });
  assert.equal(store.pending.length, 1);
  // The space that was there already, and one with the name on another machine, aren't it.
  const remote = space("acme-dev/s9", "api", "acme-dev");
  assert.equal(settle(store, [api, remote], { now: 2000 }), store, "nothing changed while it waits");
  const made = space("s3", "api");
  store = settle(store, [api, remote, made], { now: 2000 });
  assert.deepEqual(store, { threads: { s3: { kind: "bug", title: "api", machine: null, at: 1000, where: null } }, pending: [], resolved: [] });
});

test("a thread on a remote main machine is found there", () => {
  const store = settle(begin({}, { kind: "feature", title: "ENG-412", main: "acme-dev", before: [], at: 1 }), [space("acme-dev/s4", "ENG-412", "acme-dev")], { now: 2 });
  assert.deepEqual(store.threads["acme-dev/s4"], { kind: "feature", title: "ENG-412", machine: "acme-dev", at: 1, where: null });
});

test("a thread whose space never shows is given up", () => {
  const store = begin({}, { kind: "fix", title: "gone", before: [], at: 0 });
  assert.equal(settle(store, [], { now: PENDING_MS - 1 }), store);
  assert.deepEqual(settle(store, [], { now: PENDING_MS + 1 }).pending, []);
});

test("a closed thread is dropped, unless its machine isn't loaded yet", () => {
  const store = { threads: { s1: { kind: "fix", title: "api", machine: null, at: 1 }, "acme-dev/s4": { kind: "bug", title: "db", machine: "acme-dev", at: 1 } }, pending: [] };
  const asleep = settle(store, [api], { loaded: (m) => m === null });
  assert.equal(asleep, store, "acme-dev's spaces aren't listed while it loads");
  assert.deepEqual(Object.keys(settle(store, [api], { loaded: () => true }).threads), ["s1"]);
  assert.deepEqual(Object.keys(settle(store, [], { loaded: (m) => m === null }).threads), ["acme-dev/s4"]);
});

test("a space becomes a thread, changes kind, and goes back among the other spaces", () => {
  let store = mark({}, web, "feature", 5);
  assert.deepEqual(store.threads.s2, { kind: "feature", title: "web", machine: null, at: 5, where: null });
  store = mark(store, { ...web, name: "web v2" }, "bug", 9);
  assert.deepEqual(store.threads.s2, { kind: "bug", title: "web", machine: null, at: 5, where: null }, "a new kind keeps its title and age");
  assert.deepEqual(mark(store, web, "chore").threads.s2.kind, "bug", "a kind it doesn't know changes nothing");
  assert.deepEqual(release(store, "s2").threads, {});
});

test("the sidebar's threads follow Herdr's order and the space's name now; the rest are other spaces", () => {
  const store = { threads: { s2: { kind: "bug", title: "old name", at: 1 } }, pending: [] };
  const out = split(store, [api, { ...web, name: "web" }]);
  assert.deepEqual(out.threads.map((t) => [t.space.id, t.thread.kind, t.thread.title]), [["s2", "bug", "web"]]);
  assert.deepEqual(out.others.map((s) => s.id), ["s1"]);
});

test("a malformed store reads as empty", () => {
  assert.deepEqual(normalize(null), { threads: {}, pending: [], resolved: [] });
  assert.deepEqual(normalize({ threads: { s1: { title: "" }, s2: { kind: "nope", title: "x" } }, pending: [{ title: "y" }] }), { threads: { s2: { kind: "fix", title: "x", machine: null, at: 0, where: null } }, pending: [], resolved: [] });
});

test("a thread works on the main machine first, then this computer, then the other machines", () => {
  assert.deepEqual(targetChoices(null, ["acme-db", "acme-build", "acme-build"]), [["local", "This computer · main"], ["acme-build", "acme-build"], ["acme-db", "acme-db"]]);
  assert.deepEqual(targetChoices("acme-dev", ["acme-dev", "acme-db"]), [["acme-dev", "acme-dev · main"], ["local", "This computer"], ["acme-db", "acme-db"]]);
});

test("a thread on another machine opens on the main machine running the bridge there, never in a folder of its own", () => {
  const argv = ["sh", "-c", "…", "flow-bridge", "acme-build", "/srv/acme/scope"];
  assert.deepEqual(spaceArgs({ title: "Scope", folder: "/srv/acme/scope", main: null, argv }), { name: "Scope", machine: "", focus: true, argv });
});

test("a thread on another machine keeps where it works, and its first pane becomes its bridge once", () => {
  const where = { machine: "acme-build", folder: "/srv/acme/scope", argv: ["sh", "-c", "…"] };
  let store = settle(begin({}, { kind: "feature", title: "Scope", main: null, before: [], at: 1, where }), [{ ...space("s5", "Scope"), tabs: [{ id: "t1" }] }], { now: 2 });
  assert.deepEqual(store.threads.s5.where, { ...where, pane: null });
  const spaces = [{ ...space("s5", "Scope"), tabs: [{ id: "t1" }, { id: "t2" }] }];
  const panes = [{ pane: "p9", tab: "t2" }, { pane: "p1", tab: "t1" }, { pane: "p2", tab: "t1" }];
  assert.deepEqual(unbridged(store, spaces, panes), [{ id: "s5", pane: "p1", where: { ...where, pane: null } }], "the first pane of its first tab");
  assert.deepEqual(unbridged(store, spaces, []), [], "not shown yet: later");
  store = bridged(store, "s5", "p1");
  assert.equal(store.threads.s5.where.pane, "p1");
  assert.deepEqual(unbridged(store, spaces, panes), [], "taken once");
  assert.deepEqual(unbridged({ threads: { s1: { kind: "fix", title: "api" } } }, [{ ...api, tabs: [{ id: "t3" }] }], [{ pane: "p3", tab: "t3" }]), [], "a thread on the main machine has no bridge");
});

test("a split onto the thread's machine starts in the thread's folder there; onto another one, in none of its", () => {
  const store = { threads: { s5: { kind: "feature", title: "Scope", where: { machine: "acme-build", folder: "/srv/acme/scope" } }, s1: { kind: "fix", title: "api" } } };
  assert.equal(folderOn(store, "s5", "acme-build"), "/srv/acme/scope");
  assert.equal(folderOn(store, "s5", "acme-db"), null);
  assert.equal(folderOn(store, "s1", "acme-build"), null, "a thread on the main machine");
  assert.equal(folderOn(store, "s9", "acme-build"), null, "a space that isn't a thread");
  assert.equal(folderOn(store, null, "acme-build"), null);
});

test("a resolved thread leaves the threads for the resolved list, newest first, under its space's name now", () => {
  const where = { machine: "acme-build", folder: "/srv/acme/scope" };
  let store = { threads: { s1: { kind: "bug", title: "api", at: 3 }, s5: { kind: "feature", title: "Scope", at: 4, where } } };
  store = resolve(store, { ...api, name: "api login loop" }, 100);
  store = resolve(store, space("s5", "Scope"), 200);
  assert.deepEqual(Object.keys(store.threads), []);
  assert.deepEqual(store.resolved.map((r) => [r.id, r.title, r.kind, r.resolvedAt]), [["s5", "Scope", "feature", 200], ["s1", "api login loop", "bug", 100]]);
  assert.equal(store.resolved[0].where.folder, "/srv/acme/scope", "where it worked stays with it");
  assert.equal(resolve(store, web, 300).resolved.length, 2, "a space that isn't a thread resolves nothing");
  assert.deepEqual(settle(store, [], { now: 400 }), store, "its space closing changes nothing more");
  assert.deepEqual(forget(store, "s1").resolved.map((r) => r.id), ["s5"]);
  assert.deepEqual(forget(store, "*").resolved, []);
  const many = { resolved: Array.from({ length: RESOLVED_KEPT + 5 }, (_, i) => ({ id: `r${i}`, title: `t${i}` })) };
  assert.equal(normalize(many).resolved.length, RESOLVED_KEPT, "the list keeps the newest");
});

test("a thread's card counts its panes and what its terminals are doing", () => {
  const sp = { ...space("s5", "Scope"), tabs: [{ id: "t1" }, { id: "t2" }] };
  const panes = [
    { pane: "p1", tab: "t1", terminal: "a" },
    { pane: "p2", tab: "t1", terminal: "b" },
    { pane: "p3", tab: "t2", terminal: "c" },
    { pane: "p4", tab: "t2" },
    { pane: "p9", tab: "elsewhere", terminal: "z" },
  ];
  const stages = { a: "needs_you", b: "working", c: "working", z: "needs_you" };
  assert.deepEqual(activity(sp, panes, (p) => stages[p.terminal] ?? null), { tabs: 2, panes: 4, needs_you: 1, failed: 0, working: 2, done: 0 });
  assert.deepEqual(activity(space("s9", "empty"), panes), { tabs: 0, panes: 0, needs_you: 0, failed: 0, working: 0, done: 0 });
});

test("a thread's age reads in a few letters", () => {
  const now = 10 * 86_400_000;
  assert.equal(ago(now - 20_000, now), "now");
  assert.equal(ago(now - 5 * 60_000, now), "5m");
  assert.equal(ago(now - 3 * 3_600_000, now), "3h");
  assert.equal(ago(now - 2 * 86_400_000, now), "2d");
  assert.equal(ago(0, now), "", "no age known");
});

test("the folder list reads a listing and walks up and down", () => {
  assert.deepEqual(parseListing("/home/maya\nsrc\n.git-not-shown-here\nApps\nscope\n"), { path: "/home/maya", folders: [".git-not-shown-here", "Apps", "scope", "src"] });
  assert.equal(parseListing(""), null);
  assert.equal(parseListing("sh: cd: nope\n"), null, "no full path first: no listing");
  assert.deepEqual(parseListing("/srv/acme\n").folders, []);
  assert.equal(childOf("/home/maya", "scope"), "/home/maya/scope");
  assert.equal(childOf("/", "srv"), "/srv");
  assert.equal(parentOf("/home/maya/scope"), "/home/maya");
  assert.equal(parentOf("/home"), "/");
  assert.equal(parentOf("/"), null, "the root has nothing above");
});

test("the listing script lists a folder's folders, reads ~ and bare paths from home, and exits 3 for none", () => {
  const home = mkdtempSync(join(tmpdir(), "flow-list-"));
  try {
    mkdirSync(join(home, "scope", "api"), { recursive: true });
    mkdirSync(join(home, "web"));
    mkdirSync(join(home, ".hidden"));
    writeFileSync(join(home, "notes.txt"), "");
    const list = (arg) => parseListing(execFileSync("sh", ["-c", LIST_SCRIPT, "sh", arg], { env: { ...process.env, HOME: home }, encoding: "utf8" }));
    const real = list("").path;
    assert.deepEqual(list("").folders, ["scope", "web"], "folders only, hidden ones left out");
    assert.deepEqual(list("~").folders, ["scope", "web"]);
    assert.deepEqual([list("~/scope").path, list("~/scope").folders], [`${real}/scope`, ["api"]]);
    assert.deepEqual(list("scope").folders, ["api"], "a bare path is in the home folder");
    assert.deepEqual(list(join(home, "scope", "api")).folders, []);
    const missing = spawnSync("sh", ["-c", LIST_SCRIPT, "sh", "nope"], { env: { ...process.env, HOME: home } });
    assert.equal(missing.status, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
