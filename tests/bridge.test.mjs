import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTACH_SCRIPT, bridgeArgv, bridgeLine, quote, machineChoices, stateWords, normalize, remember, bridgeOf, lost, paneItems, machineItems, parseRoute, routeFor, routeArgv, reconnectLine, validHost, sshRule, sshFields, setRoute, sshCheck, machineWords } from "../mods/flow/bridge.js";

// The acme machines `hc machine ls --json` lists: a build box, a database box asleep, and an agent's short-lived one.
const listed = {
  machines: [
    { name: "acme-db", state: "asleep", temporary: false },
    { name: "acme-build", state: "connected", temporary: false },
    { name: "sandbox-3f2a", state: "connected", temporary: true },
    { state: "connected" },
  ],
};

test("a bridge pane starts the machine's own shell there and attaches to it, in a folder there when given", () => {
  assert.deepEqual(bridgeArgv("acme-build"), ["sh", "-c", ATTACH_SCRIPT, "flow-bridge", "acme-build"]);
  assert.deepEqual(bridgeArgv("acme-build", "/srv/acme/api").slice(3), ["flow-bridge", "acme-build", "/srv/acme/api"]);
  assert.match(ATTACH_SCRIPT, /run --bg --json --no-notify --on "\$m"/, "hc run alone waits and shows nothing");
  assert.match(ATTACH_SCRIPT, /exec "\$h" attach "\$a"$/);
  assert.match(ATTACH_SCRIPT, /\$HOME\/\.local\/bin\/hc/, "Herdr's terminals have no ~/.local/bin on PATH");
  assert.ok(!ATTACH_SCRIPT.includes("\n"), "one line, so Reconnect can type it");
});

test("the attach script runs: it starts the shell, attaches to its address, and keeps an error on screen", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/flow-bridge-`);
  // A stand-in hc that logs its calls: `run` answers as hc does, with the address on its own machine.
  writeFileSync(`${dir}/hc`, `#!/bin/sh\nprintf '%s|' "$@" >> "${dir}/calls"; echo >> "${dir}/calls"\n[ "$1" = run ] && echo '{"address":"t7","state":"live"}'\nexit 0\n`);
  chmodSync(`${dir}/hc`, 0o755);
  const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir };
  execFileSync("sh", bridgeArgv("acme-build", "/srv/Maya's notes").slice(1), { env, input: "" });
  assert.deepEqual(readFileSync(`${dir}/calls`, "utf8").trim().split("\n"), [
    "run|--bg|--json|--no-notify|--on|acme-build|--cwd|/srv/Maya's notes|",
    "attach|acme-build/t7|",
  ]);
  writeFileSync(`${dir}/hc`, "#!/bin/sh\necho 'acme-build is unreachable' >&2; exit 2\n");
  let shown = "";
  try {
    execFileSync("sh", bridgeArgv("acme-build").slice(1), { env, input: "\n", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    shown = `${e.stdout}`;
    assert.equal(e.status, 1);
  }
  assert.match(shown, /Could not start a shell on acme-build\. Press Enter to close\./);
});

test("reconnecting types a line the shell reads back word for word", () => {
  assert.equal(bridgeLine("acme-build", "/srv/acme/api"), `exec sh -c ${quote(ATTACH_SCRIPT)} flow-bridge acme-build /srv/acme/api`);
  assert.ok(bridgeLine("acme-build", "/srv/Maya's notes").endsWith(`flow-bridge acme-build '/srv/Maya'\\''s notes'`));
  assert.equal(quote("a b"), "'a b'");
  assert.equal(quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
});

test("the machines to split onto are the named, lasting ones, by name", () => {
  assert.deepEqual(machineChoices(listed), [{ name: "acme-build", state: "connected" }, { name: "acme-db", state: "asleep" }]);
  assert.deepEqual(machineChoices(listed.machines).map((m) => m.name), ["acme-build", "acme-db"], "a bare list reads the same");
  assert.deepEqual(machineChoices(null), []);
  assert.equal(stateWords("connected"), "");
  assert.equal(stateWords("needs_login"), "needs login");
});

test("bridges are remembered per pane, and panes that went are forgotten", () => {
  let stored = remember(null, "p2", "acme-build", "/srv/acme/api", new Set(["p1", "p2"]));
  stored = remember(stored, "p3", "acme-db", null, new Set(["p2", "p3"]));
  assert.deepEqual(stored, { p2: { machine: "acme-build", folder: "/srv/acme/api" }, p3: { machine: "acme-db", folder: null } });
  stored = remember(stored, "p4", "acme-db", null, new Set(["p3", "p4"]));
  assert.deepEqual(Object.keys(stored), ["p3", "p4"], "p2 closed, so it goes");
  assert.equal(bridgeOf(stored, "p3").machine, "acme-db");
  assert.equal(bridgeOf(stored, "p1"), null);
  assert.deepEqual(normalize({ p1: { machine: "" }, p2: "acme-db", p3: null }), {}, "malformed entries are dropped");
  assert.deepEqual(normalize([1, 2]), {});
});

test("a bridge pane is lost once its terminal runs a shell again", () => {
  const bridge = { machine: "acme-build", folder: null };
  assert.equal(lost(bridge, { program: { key: "program", shell: false } }), false, "hc holds the remote shell");
  assert.equal(lost(bridge, { program: { key: "zsh", shell: true } }), true, "Herdr gave it a local shell after a reboot");
  assert.equal(lost(null, { program: { shell: true } }), false, "a plain shell pane is no bridge");
});

const labels = (items) => items.map((i) => (i === "separator" ? "—" : i.label));

test("a pane's menu has Herdr's items and the splits onto another machine", () => {
  const items = paneItems({ pane: "p2", terminal: "t3", inTab: true });
  assert.deepEqual(labels(items), ["Rename", "—", "Split right", "Split down", "Split right on…", "Split down on…", "—", "Zoom", "Send right-clicks to pane", "—", "Close pane"]);
  assert.deepEqual(items.find((i) => i.label === "Split right").run, ["pane.split", { direction: "right", pane: "p2" }]);
  assert.equal(items.find((i) => i.label === "Split down on…").command, "split:on|down|p2");
  assert.ok(items.find((i) => i.label === "Close pane").destructive);
});

test("a terminal without a pane (a layout block, a window) gets no pane items", () => {
  const items = paneItems({ pane: "block-1", terminal: "t3", inTab: false, parent: "t1", toProgram: true });
  assert.deepEqual(labels(items), ["Use Herdr right-click menu", "Send back to t1"]);
  assert.deepEqual(items[1].run, ["terminal.park", { terminal: "t3" }]);
});

test("a lost bridge pane offers to reconnect to its machine", () => {
  const bridge = { machine: "acme-build", folder: null };
  assert.ok(!labels(paneItems({ pane: "p2", terminal: "t3", inTab: true, bridge })).includes("Reconnect to acme-build"));
  const items = paneItems({ pane: "p2", terminal: "t3", inTab: true, bridge, reconnect: true });
  assert.equal(items.find((i) => i.label === "Reconnect to acme-build").command, "split:again|p2");
});

test("the dropdown lists this computer and each machine, with its state when it isn't connected", () => {
  const machines = machineChoices(listed);
  const items = machineItems("right", "p2", machines);
  assert.deepEqual(labels(items), ["This computer", "acme-build", "acme-db · asleep", "—", "Add a machine…"]);
  assert.deepEqual(items.map((i) => i.command).filter(Boolean), ["split:to|right|p2|local", "split:to|right|p2|acme-build", "split:to|right|p2|acme-db"]);
  assert.deepEqual(items.at(-1).run, ["mod.open", { name: "machine-add" }], "Herdr's own dialog adds it");
  const both = machineItems(null, "p2", machines);
  assert.deepEqual(labels(both), ["Split right on", "This computer", "acme-build", "acme-db · asleep", "—", "Split down on", "This computer", "acme-build", "acme-db · asleep", "—", "Add a machine…"]);
  assert.ok(both[0].info && both[5].info, "the headings are no picks");
  const none = machineItems("down", "p2", []);
  assert.deepEqual(labels(none), ["This computer", "—", "Add a machine…"]);
});

test("in a thread that works on another machine, the dropdown lists that machine first, once", () => {
  const machines = machineChoices(listed);
  const items = machineItems("right", "p2", machines, null, "acme-build");
  assert.deepEqual(labels(items), ["acme-build · this thread's machine", "This computer", "acme-db · asleep", "—", "Add a machine…"]);
  assert.equal(items[0].command, "split:to|right|p2|acme-build");
  assert.deepEqual(labels(machineItems("right", "p2", machines, null, "local")), ["This computer", "acme-build", "acme-db · asleep", "—", "Add a machine…"], "the pane's own machine: nothing moves");
  const fromDev = machineItems("down", "p2", machines, "acme-dev", "local");
  assert.deepEqual(labels(fromDev).slice(0, 3), ["This computer · this thread's machine", "acme-dev · this pane's machine", "acme-build"]);
});

// flow.json for the acme machines: acme-build is reached from acme-dev by ssh, through a jump host from anywhere else
// but this computer; this computer is reached from acme-dev by ssh, and acme-db by a command of its own.
const ROUTES = {
  routes: {
    "acme-build": { "acme-dev": "ssh", "*": { ssh: "build.acme.example", jump: "bastion.acme.example" } },
    local: { "acme-dev": "ssh:maya@laptop.acme.example" },
    "acme-db": { "acme-dev": { argv: ["fly", "ssh", "console", "-a", "acme-db", "--cwd", "{folder}"] }, "acme-web": "hc:db" },
  },
};

test("a split reaches its machine as flow.json says for the pane's machine, else by hc from this computer", () => {
  assert.deepEqual(routeFor(ROUTES, "acme-db", null), { kind: "hc", name: "acme-db" }, "this computer's hc knows every machine");
  assert.deepEqual(routeFor(ROUTES, "local", null), { kind: "split" }, "this computer onto itself is Herdr's own split");
  assert.deepEqual(routeFor(ROUTES, "acme-dev", "acme-dev"), { kind: "split" }, "so is a machine onto itself");
  assert.deepEqual(routeFor(ROUTES, "acme-build", "acme-dev"), { kind: "ssh", dest: "acme-build", jump: null, options: [] });
  assert.deepEqual(routeFor(ROUTES, "acme-build", "acme-web"), { kind: "ssh", dest: "build.acme.example", jump: "bastion.acme.example", options: [] }, "* covers the rest");
  assert.deepEqual(routeFor(ROUTES, "acme-build", null), { kind: "ssh", dest: "build.acme.example", jump: "bastion.acme.example", options: [] }, "* covers this computer too");
  assert.deepEqual(routeFor(ROUTES, "acme-db", "acme-web"), { kind: "hc", name: "db" }, "that machine's hc knows it by another name");
  assert.deepEqual(routeFor(ROUTES, "local", "acme-dev"), { kind: "ssh", dest: "maya@laptop.acme.example", jump: null, options: [] });
  assert.equal(routeFor(ROUTES, "acme-db", "acme-build"), null, "no rule from another machine: ask its hc");
  assert.equal(routeFor({}, "local", "acme-dev"), null);
  assert.equal(routeFor(null, "acme-db", "acme-dev"), null);
});

test("a route flow.json can't use counts as none", () => {
  assert.equal(parseRoute("hc:local", "local"), null, "hc can't reach this computer by name");
  assert.equal(parseRoute("telnet", "acme-db"), null);
  assert.equal(parseRoute({ ssh: "" }, "acme-db"), null);
  assert.equal(parseRoute({ argv: [] }, "acme-db"), null);
  assert.equal(parseRoute({ argv: ["ssh", 3] }, "acme-db"), null);
  assert.equal(parseRoute(["ssh"], "acme-db"), null);
  assert.deepEqual(parseRoute({ ssh: "acme-db", options: ["-p", "2222"] }, "acme-db").options, ["-p", "2222"]);
});

test("each route opens the machine's shell, in the folder there when given", () => {
  assert.deepEqual(routeArgv({ kind: "hc", name: "acme-db" }, "/srv/acme/api"), bridgeArgv("acme-db", "/srv/acme/api"));
  const ssh = routeFor(ROUTES, "acme-build", "acme-web");
  assert.deepEqual(routeArgv(ssh), ["ssh", "-t", "-J", "bastion.acme.example", "build.acme.example"]);
  assert.deepEqual(routeArgv(ssh, "/srv/Maya's notes"), ["ssh", "-t", "-J", "bastion.acme.example", "build.acme.example", `cd '/srv/Maya'\\''s notes' && exec "$SHELL" -l`]);
  assert.deepEqual(routeArgv({ kind: "ssh", dest: "acme-db", jump: null, options: ["-p", "2222"] }), ["ssh", "-t", "-p", "2222", "acme-db"]);
  const fly = routeFor(ROUTES, "acme-db", "acme-dev");
  assert.deepEqual(routeArgv(fly, "/srv/acme/api"), ["fly", "ssh", "console", "-a", "acme-db", "--cwd", "/srv/acme/api"]);
  assert.deepEqual(routeArgv(fly), ["fly", "ssh", "console", "-a", "acme-db", "--cwd"], "{folder} alone goes when there is none");
});

test("a bridge pane reconnects the way it was opened", () => {
  const argv = routeArgv(routeFor(ROUTES, "acme-build", "acme-dev"), "/srv/acme/api");
  const stored = remember(null, "p2", "acme-build", "/srv/acme/api", new Set(["p2"]), argv);
  assert.deepEqual(stored.p2.argv, argv);
  assert.equal(reconnectLine(bridgeOf(stored, "p2")), `exec ssh -t acme-build 'cd /srv/acme/api && exec "$SHELL" -l'`);
  assert.equal(reconnectLine({ machine: "acme-db", folder: null }), bridgeLine("acme-db"), "one remembered before routes: hc");
  assert.equal(reconnectLine({ machine: "acme-db", folder: "/srv", argv: ["hc", "run", "--on", "acme-db", "--no-notify"] }), bridgeLine("acme-db", "/srv"), "one opened with a bare hc run attaches now");
  assert.deepEqual(normalize({ p2: { machine: "acme-db", argv: ["hc", 1] } }).p2, { machine: "acme-db", folder: null }, "a malformed argv is dropped");
});

test("the route form takes an ssh host as one word, never an option", () => {
  for (const ok of ["acme-build", "me@10.0.0.7", "acme.example.com"]) assert.ok(validHost(ok), ok);
  for (const bad of ["", "  ", "-oProxyCommand=x", "me@host extra", null]) assert.ok(!validHost(bad), String(bad));
  assert.equal(machineWords("local"), "this computer");
  assert.equal(machineWords(null), "this computer");
  assert.equal(machineWords("acme-db"), "acme-db");
});

test("the route form writes the pair it asks about into flow.json and keeps the rest", () => {
  assert.equal(sshRule("acme-db"), "ssh:acme-db");
  assert.deepEqual(sshRule("me@acme-db", "bastion"), { ssh: "me@acme-db", jump: "bastion" });
  assert.equal(sshRule(""), null);
  assert.equal(sshRule("acme-db", "-x"), null);
  const before = { theme: "kept", routes: { "acme-db": { local: "hc", "acme-build": "ssh:db" }, local: { "acme-dev": "ssh:mac" } } };
  const after = setRoute(before, "acme-db", "acme-dev", sshRule("db.internal", "bastion"));
  assert.deepEqual(after, { theme: "kept", routes: { "acme-db": { local: "hc", "acme-build": "ssh:db", "acme-dev": { ssh: "db.internal", jump: "bastion" } }, local: { "acme-dev": "ssh:mac" } } });
  assert.deepEqual(before.routes["acme-db"], { local: "hc", "acme-build": "ssh:db" }, "the config read stays as it was");
  assert.deepEqual(setRoute(null, "local", null, "ssh:x"), { routes: { local: { local: "ssh:x" } } });
  assert.deepEqual(routeFor(after, "acme-db", "acme-dev"), { kind: "ssh", dest: "db.internal", jump: "bastion", options: [] }, "a split reads back what the form saved");
  assert.deepEqual(sshFields(after, "acme-db", "acme-dev"), { host: "db.internal", jump: "bastion" });
  assert.deepEqual(sshFields(after, "acme-db", "acme-build"), { host: "db", jump: "" });
  assert.deepEqual(sshFields(after, "acme-db", null), { host: "", jump: "" }, "an hc route is no ssh host to fill in");
  assert.deepEqual(sshFields({}, "acme-db", "acme-dev"), { host: "", jump: "" });
  assert.deepEqual(sshCheck("db", "bastion"), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-J", "bastion", "db", "true"]);
});

test("from another machine's pane, the dropdown starts with that machine, then this computer, then the rest", () => {
  const machines = [{ name: "acme-build", state: "connected" }, { name: "acme-dev", state: "connected" }, { name: "acme-db", state: "asleep" }];
  const items = machineItems("right", "acme-dev/p2", machines, "acme-dev");
  assert.deepEqual(labels(items), ["acme-dev · this pane's machine", "This computer", "acme-build", "acme-db · asleep", "—", "Add a machine…", "How acme-dev reaches the others…"]);
  assert.equal(items.at(-1).command, "split:route|right|acme-dev/p2");
  assert.deepEqual(items.slice(0, 2).map((i) => i.command), ["split:to|right|acme-dev/p2|acme-dev", "split:to|right|acme-dev/p2|local"]);
});
