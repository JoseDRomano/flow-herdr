import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

const app = new URL("../", import.meta.url);
const folder = new URL("mods/flow/", app);
const read = (url) => readFile(url, "utf8");
const json = async (url) => JSON.parse(await read(url));

/** A layout tree whose stacks show these screens, as Herdr's layout() reads (front.js's shownScreen). */
const tree = (stack, active, inner = null) => ({ id: "root", children: [{ id: stack, active, children: [] }, ...(inner ? [{ id: "view", active: inner, children: [] }] : [])] });

// The mod loaded in a VM with Herdr's natives stubbed: `shared` holds the layout, `bound` is what keys() returns, `shown`
// the layout tree layout() returns, `hub` the views the hub answers; `calls` records every command run and hub act.
async function fixture({ layout = "flow", bound = [], agents = [], focused = {}, hub = {}, shown = null, app: appShown = null, terms = null } = {}) {
  const calls = [];
  const views = [];
  const shared = { layout, "flow.app": appShown };
  const context = createContext({ console });
  const imports = {
    herdr: {
      keys: () => bound,
      commands: () => [{ name: "pane.split", args: [{ name: "direction" }] }, { name: "tab.select", args: [{ name: "index" }] }],
      agents: () => agents,
      spaces: () => [],
      layouts: () => [],
      window: () => ({ platform: "macos" }),
      layout: () => shown,
      focused: () => focused,
      run: (...args) => calls.push(args),
      openOverlay: (spec) => calls.push(["overlay", spec]),
      shared: (key) => shared[key] ?? null,
      setShared: (key, value) => (shared[key] = value),
      notify: (n) => calls.push(["notify", n]),
      ...(terms ? { terminals: () => terms } : {}),
    },
    "./hub.js": {
      view: async (name, args) => (views.push([name, args]), hub[name] ?? null),
      act: async (...args) => (calls.push(["act", ...args]), {}),
      openUrl: () => {},
      install: async () => ({}),
      sleep: async () => {},
      subscribe: () => ({ stop() {} }),
      remoteMachine: () => null,
      LOAD: 1,
      liveLoad: () => true,
    },
  };
  const sources = new Map(), modules = new Map();
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".js")) continue;
    const text = await read(new URL(name, folder));
    sources.set(`./${name}`, text);
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(herdr|gpui-kit|gpui-base)"/g)) {
      const exports = (imports[match[2]] ??= {});
      for (const word of match[1].split(",")) {
        const key = word.trim().split(/\s+as\s+/)[0];
        exports[key] ??= () => {
          throw new Error(`unexpected native call: ${key}`);
        };
      }
    }
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const native = imports[name];
    const module = native
      ? new SyntheticModule(Object.keys(native), function () {
          for (const [key, value] of Object.entries(native)) this.setExport(key, value);
        }, { context })
      : new SourceTextModule(sources.get(name), { context, identifier: name });
    modules.set(name, module);
    return module;
  }
  const entry = [
    'export * from "./commands.js";',
    'export { emptyRows, keepSelection, PALETTE_KEYS, default as Palette } from "./palette.js";',
    'export { default as Sidebar } from "./sidebar.js";',
    'export { baseOf, screens, screensOf, layoutName } from "./screens.js";',
  ].join(" ");
  const module = new SourceTextModule(entry, { context });
  await module.link(load);
  await module.evaluate();
  return { mod: module.namespace, calls, shared, views };
}

// The VM's objects as plain data, so they compare with this realm's.
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A context whose timers run at once and whose spawned work can be awaited. */
function context() {
  const work = [];
  const cx = { notify() {}, stop_propagation() {}, spawn: (f) => work.push(f(cx)), timer: { after: (_ms, f) => f(cx), every: () => {} } };
  return { cx, settled: () => Promise.all(work) };
}

/** keys.json as Herdr's keys() lists it, with Herdr's global keys this test leans on. */
async function bound() {
  const keys = await json(new URL("keys.json", app));
  const global = { "cmd-/": "app.help", "cmd-b": "layout.toggle:sidebar", "cmd-n": "space.new", "cmd-shift-p": "app.palette" };
  return [...Object.entries({ global, ...keys }).flatMap(([section, map]) => Object.entries(map).map(([k, action]) => ({ section, keys: k, action })))];
}

// ---------------------------------------------------------------------------------------------------------------------
// What each view handles, read from its source

const sources = async () => {
  const out = new Map();
  for (const name of await readdir(folder)) if (name.endsWith(".js")) out.set(name, await read(new URL(name, folder)));
  return out;
};

/** The body of every `command(` method in a source, braces matched. */
function commandBodies(source) {
  const out = [];
  for (const m of source.matchAll(/\n\s+command\(c\b[^)]*\)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push(source.slice(m.index, i));
  }
  return out;
}

/** The commands a view's `command()` names exactly (`c === "x"`), and whether it hands them to commands.js. */
function handledBy(file, files) {
  const exact = new Set();
  let runner = false;
  for (const body of commandBodies(files.get(file))) {
    for (const m of body.matchAll(/\bc === "([^"]+)"/g)) exact.add(m[1]);
    if (/\brunCommand\(c\b/.test(body)) runner = true;
  }
  return { exact, runner };
}

/** Each view of main.js's VIEWS, by name, as the source file that defines it. */
async function viewFiles() {
  const main = await read(new URL("main.js", folder));
  const fileOf = new Map();
  for (const m of main.matchAll(/import\s+([\w\s,{}]+?)\s+from\s+"\.\/([\w-]+\.js)"/g)) for (const id of m[1].match(/\w+/g)) fileOf.set(id, m[2]);
  const views = main.match(/const VIEWS = \{([^}]+)\}/)[1];
  return new Map([...views.matchAll(/"?([\w-]+)"?\s*:\s*(\w+)/g)].map(([, name, cls]) => [name, fileOf.get(cls)]));
}

/** Nodes a key hides with the views in them: Herdr's own ⌘B toggles the sidebar in every layout. */
const HIDEABLE = new Set(["sidebar"]);

/**
 * The cockpit views a layout shows, one per block that holds one (floating blocks too). A hidden copy takes no
 * commands, so views a key can hide are left out unless `all`.
 */
function appsOf(node, out = [], all = false) {
  if (!node || typeof node !== "object" || (!all && HIDEABLE.has(node.id))) return out;
  if (node.content?.mod === "flow" && node.content.props?.app) out.push(node.content.props.app);
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) appsOf(c, out, all);
  return out;
}

/** The views of a layout with what each handles. */
async function layoutViews(layout) {
  const files = await sources();
  const fileOf = await viewFiles();
  return appsOf(await json(new URL(`layouts/${layout}.json`, app))).map((a) => ({ app: a, ...handledBy(fileOf.get(a), files) }));
}

/** Who runs `flow.<c>` in a layout: its runner when commands.js takes it, and each view that names it exactly. */
function handlersOf(c, layout, views, mod) {
  const out = [];
  for (const v of views) {
    if (v.runner && v.app === mod.RUNNER[layout] && mod.handles(layout, c)) out.push(`${v.app} (commands.js)`);
    if (v.exact.has(c)) out.push(v.app);
  }
  return out;
}

/**
 * Every `layout:<name>` binding no handler or more than one runs in its layout: [{layout, keys, action, handlers}]. A
 * look (`flow-mist`) shows its own file's views and runs window commands as the layout it copies, as the mod does.
 */
async function check(keys, mod) {
  const problems = [];
  for (const [section, map] of Object.entries(keys)) {
    if (!section.startsWith("layout:")) continue;
    const layout = section.slice(7);
    const base = Object.keys(mod.RUNNER).find((n) => layout === n || layout.startsWith(`${n}-`)) ?? layout;
    const views = await layoutViews(layout);
    for (const [k, action] of Object.entries(map)) {
      if (!action.startsWith("flow.")) continue;
      const handlers = handlersOf(action.slice(5), base, views, mod);
      if (handlers.length !== 1) problems.push({ layout, keys: k, action, handlers });
    }
  }
  return problems;
}

/** A source without its comments, URLs kept: `//` after a colon is part of a string. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------------------------------------------------
// Tests

test("every layout binding reaches exactly one handler in its layout", async () => {
  const { mod } = await fixture();
  assert.deepEqual(await check(await json(new URL("keys.json", app)), mod), []);
});

test("a binding no view of its layout handles fails the check, and so does a screen the layout does not have", async () => {
  const { mod } = await fixture();
  const keys = await json(new URL("keys.json", app));
  keys["layout:flow"]["cmd-alt-9"] = "flow.go:needs";
  keys["layout:flow"]["cmd-alt-x"] = "flow.nothing-here";
  keys["layout:flow"]["cmd-alt-y"] = "flow.panel:nowhere";
  const problems = (await check(keys, mod)).map((p) => `${p.layout} ${p.action} ${p.handlers.length}`).sort();
  assert.deepEqual(problems, ["flow flow.go:needs 0", "flow flow.nothing-here 0", "flow flow.panel:nowhere 0"]);
});

test("each layout has its runner, and every palette entry reaches exactly one handler there", async () => {
  const { mod } = await fixture();
  for (const layout of ["flow"]) {
    const file = await json(new URL(`layouts/${layout}.json`, app));
    assert.equal(appsOf(file).filter((a) => a === mod.RUNNER[layout]).length, 1, `${layout} shows its runner once`);
    assert.equal(appsOf(file, [], true).filter((a) => a === mod.RUNNER[layout]).length, 1, "and nowhere a key hides it");
    assert.deepEqual(await paletteProblems(mod, layout), [], `${layout}: every palette entry runs once`);
  }
});

/** The palette entries of a layout that reach no handler there, or more than one, as `<action> <handlers>`. */
async function paletteProblems(mod, layout) {
  const views = await layoutViews(layout);
  const commands = [
    ...mod.screensOf(layout).list.map((s) => `flow.go:${s.child}`),
    ...mod.CATALOGUE.filter((e) => !["flow.palette", "flow.keys"].includes(e.command) && mod.available(layout, e.command.slice(5), { driven: true })).map((e) => mod.paletteAction(e)),
  ];
  const out = [];
  for (const action of commands) {
    const c = action.slice(5);
    if (c.startsWith("via:")) {
      const [screen, inner] = [c.slice(4, c.indexOf("|")), c.slice(c.indexOf("|") + 1)];
      if (!mod.handles(layout, c) || !views.some((v) => v.app === screen && v.exact.has(inner))) out.push(`${action} 0`);
    } else if (handlersOf(c, layout, views, mod).length !== 1) out.push(`${action} ${handlersOf(c, layout, views, mod).length}`);
  }
  return out;
}

test("a palette entry listed in a layout whose views do nothing with it fails the check", async () => {
  const { mod } = await fixture();
  mod.CATALOGUE.push({ command: "flow.nothing-here", title: "Nothing", group: "Window", words: "", layouts: ["flow"] });
  try {
    assert.deepEqual(await paletteProblems(mod, "flow"), ["flow.nothing-here 0"]);
  } finally {
    mod.CATALOGUE.pop();
  }
});
test("every window command a view of a layout runs by name reaches a handler there, or the view asks first", async () => {
  const { mod } = await fixture();
  const fileOf = await viewFiles();
  const files = await sources();
  for (const layout of ["flow"]) {
    const views = await layoutViews(layout);
    // The views a layout shows, with what opens over it in either layout (the palette, the terminal window's head).
    const shown = new Set([...appsOf(await json(new URL(`layouts/${layout}.json`, app)), [], true).map((a) => fileOf.get(a)), "palette.js", "agent-head.js", "agentsui.js"]);
    const dead = [];
    for (const name of shown) {
      const text = code(files.get(name));
      for (const [, c] of text.matchAll(/run\((?:keyed\()?"flow\.([^"]+)"/g)) {
        const asks = text.includes(`available(layoutName(), "${c}")`);
        const reached = c.endsWith(":") ? mod.runnerCommands(layout).includes(c) : handlersOf(c, layout, views, mod).length > 0;
        if (!reached && !asks) dead.push(`${name} flow.${c}`);
      }
    }
    assert.deepEqual(dead, [], `${layout}: commands its views run that nothing there handles`);
  }
});

test("the views' own keys stay free of window bindings", async () => {
  const { mod } = await fixture();
  const keys = await json(new URL("keys.json", app));
  const ui = await read(new URL("ui.js", folder));
  const taken = new Set([...ui.matchAll(/e\.keystroke === "([^"]+)"/g)].map((m) => m[1]));
  for (const [k] of mod.VIEW_KEYS) assert.ok(taken.has(k), `${k} is a key the page header takes`);
  for (const [section, map] of Object.entries(keys)) for (const k of Object.keys(map)) assert.ok(!mod.VIEW_KEYS.some(([v]) => v === k), `${section} binds ${k}, a view's own key`);
});

test("the keys sheet lists the shown layout's keys, grouped, Herdr's last", async () => {
  const keys = await bound();
  const flow = await fixture({ layout: "flow", bound: keys });
  const groups = plain(flow.mod.sheet("flow", keys));
  assert.equal(groups.at(-1).title, "Herdr");
  const home = groups[0].rows[0];
  assert.deepEqual([home.keys, home.title, home.action], ["cmd-alt-0", "Home", "flow.home"]);
  // keys() lists keys sorted (as an install writes keys.json): the sheet keeps the layout's own order.
  const sorted = [...keys].sort((a, b) => (a.keys < b.keys ? -1 : 1));
  assert.deepEqual(plain(flow.mod.sheet("flow", sorted)), groups);
  const all = groups.flatMap((g) => g.rows);
  assert.ok(all.some((r) => r.keys === "cmd-j" && r.title === "Next agent waiting for you"));
  assert.ok(all.some((r) => r.keys === "cmd-n" && r.action === "flow.thread"), "⌘N opens a thread");
  const herdr = groups.at(-1).rows.map((r) => r.keys);
  assert.ok(herdr.includes("cmd-b"), "Herdr's own keys stay listed");
  assert.ok(!herdr.includes("cmd-n"), "a key the layout takes over is listed once, as the layout's");
});

test("tooltips name the shown layout's keys", async () => {
  const keys = await bound();
  const flow = await fixture({ layout: "flow", bound: keys });
  assert.equal(flow.mod.hint("Home", "flow.home"), "Home  ⌘⌥0");
  assert.equal(flow.mod.hint("New thread", "flow.thread"), "New thread  ⌘N");
  assert.equal(flow.mod.hint("Its terminal", "flow.terminal"), "Its terminal");
});

test("⌘J runs once, in the layout shown, on the agents a copy already follows, and lands on the agent waiting longest", async () => {
  const agents = [
    { address: "t1", status: "blocked", title: "Quota banner", tab: "b", space: "s" },
    { address: "t2", status: "blocked", title: "Enforce daily quotas", tab: "a", space: "s" },
  ];
  const rows = { agents: [{ address: "t1", terminal: "app:t1", stage: "needs_you", since: 200 }, { address: "t2", terminal: "app:t2", stage: "needs_you", since: 100 }] };
  const { mod, calls, shared, views } = await fixture({ layout: "flow", agents });
  const { cx } = context();
  assert.equal(mod.runCommand("next-waiting", cx, "other"), false, "a runner stands down while its layout isn't shown");
  assert.equal(calls.length, 0);
  const unlend = mod.lend(() => rows);
  assert.equal(mod.runCommand("next-waiting", cx, "flow"), true);
  unlend();
  assert.equal(views.length, 0, "the hub builds nothing while a copy follows the agents");
  assert.deepEqual(plain(calls.slice(0, 2)), [["agent.focus", { terminal: "t2" }], ["layout.select", { stack: "center", child: "work" }]]);
  assert.equal(shared["flow.app"], "work");
  calls.length = 0;
  assert.equal(mod.runCommand("go:runbook", cx, "flow"), true);
  assert.deepEqual(plain(calls[0]), ["layout.select", { stack: "center", child: "runbook" }]);
  assert.equal(mod.runCommand("go:needs", cx, "flow"), false, "a screen the layout does not have");
  assert.equal(mod.runCommand("go:inbox", cx, "flow"), false, "Flow has no inbox");
});
test("⌘J passes a driven session, which Flow has no chat to read in, and goes on to the next agent", async () => {
  const agents = [{ address: "t1", status: "blocked", title: "Quota banner", tab: "b", space: "s" }];
  const key = "claude:1793611000000";
  const rows = { agents: [
    { address: key, terminal: key, title: "Driven session", frontend: "app", driven: true, stage: "needs_you", status: "blocked", since: 50 },
    { address: "t1", terminal: "app:t1", stage: "needs_you", since: 200 },
  ] };
  const flow = await fixture({ layout: "flow", agents, focused: { terminal: "t9" } });
  const { cx } = context();
  const back = flow.mod.lend(() => rows);
  flow.mod.runCommand("next-waiting", cx, "flow");
  assert.ok(!flow.calls.some((c) => c[0] === "layout.switch" || /chat:open:/.test(String(c[0]))), "never a switch to a layout Flow doesn't have");
  assert.deepEqual(plain(flow.calls.filter((c) => c[0] === "agent.focus")), [["agent.focus", { terminal: "t1" }]]);
  assert.match(flow.calls.find((c) => c[0] === "notify")?.[1]?.title ?? "", /Driven session has no running terminal/, "and says it passed it");
  back();
});

test("⌘J passes an agent with no running terminal and says so, and moves past one the last press could not bring up", async () => {
  const rows = { agents: [
    { address: "t41", terminal: "app:t41", title: "Enforce daily quotas", stage: "needs_you", since: 100 },
    { address: "t42", terminal: "app:t42", title: "Quota banner", stage: "needs_you", since: 200 },
    { address: "t43", terminal: "app:t43", title: "Retry failed CSV exports", stage: "needs_you", since: 300 },
  ] };
  const focusOf = (calls) => calls.filter((c) => c[0] === "agent.focus").map((c) => c[1].terminal);
  const noted = (calls) => calls.filter((c) => c[0] === "notify").map((c) => c[1].title);
  const f = await fixture({ layout: "flow", focused: { terminal: "t9" }, terms: [{ address: "t42", state: "live" }, { address: "t43", state: "live" }, { address: "t9", state: "live" }] });
  const { cx } = context();
  const unlend = f.mod.lend(() => rows);
  f.mod.runCommand("next-waiting", cx, "flow");
  assert.deepEqual(plain(focusOf(f.calls)), ["t42"], "the one waiting longest has no running terminal: on to the next");
  assert.deepEqual(plain(noted(f.calls)), ["Enforce daily quotas has no running terminal"]);
  // The focus never came: the window still shows t9, and the next press goes on from t42, not back to it.
  f.calls.length = 0;
  f.mod.runCommand("next-waiting", cx, "flow");
  assert.deepEqual(plain(focusOf(f.calls)), ["t43"]);
  assert.deepEqual(plain(noted(f.calls)), ["That agent did not come up"]);
  unlend();
  assert.deepEqual(plain(f.mod.nextOf(rows.agents.map((a) => ({ ...a, stage: "needs" })), null, "t9", () => false)), { agent: null, passed: rows.agents.map((a) => ({ ...a, stage: "needs" })) }, "nobody reachable: nothing to go to");
});

test("Tab and ⇧⇥ are the palette's own, from its search line too: the keyboard never leaves it for the window", async () => {
  const { mod } = await fixture();
  const bound = JSON.parse(JSON.stringify(mod.PALETTE_KEYS));
  assert.deepEqual(bound.map((b) => [b.keystroke, b.context]), [
    ["tab", "FlowPalette"],
    ["tab", "FlowPalette > Input"],
    ["shift-tab", "FlowPalette"],
    ["shift-tab", "FlowPalette > Input"],
  ]);
  assert.deepEqual([...new Set(bound.map((b) => b.action))], ["flow_palette_next", "flow_palette_prev"]);
});

/** A palette with no Herdr places, over nothing, with these agents from the hub. */
function palette(mod, jumps) {
  const p = Object.create(mod.Palette.prototype);
  Object.assign(p, { over: null, place: null, editor: "VS Code", jumps, listed: jumps.length, recent: [], sheet: null });
  return p;
}

const JUMPS = [
  { terminal: "claude:1793611000000", address: "claude:1793611000000", title: "Make the quota configurable", status: "blocked", stage: "needs_you", waiting: true, driven: true, help: "needs you" },
  { terminal: "app:t41", address: "t41", title: "Enforce daily quotas", status: "blocked", stage: "needs_you", waiting: true, driven: false, help: "needs you" },
];

test("the palette leaves out a session cockpit drives, and a jump to an agent marks it seen", async () => {
  const flow = await fixture({ layout: "flow" });
  const entries = palette(flow.mod, JUMPS).entries();
  assert.ok(!entries.some((e) => e.id === "agent:claude:1793611000000"), "it has no terminal to go to");
  await entries.find((e) => e.id === "agent:t41").act();
  assert.deepEqual(plain(flow.calls.find((c) => c[0] === "agent.focus")), ["agent.focus", { terminal: "t41" }]);
  assert.deepEqual(plain(flow.calls.find((c) => c[0] === "act")), ["act", "agents", "seen", [{ terminal: "app:t41" }]], "a jump marks the agent seen");
});
test("the palette lists what the shown layout has", async () => {
  const flow = await fixture({ layout: "flow" });
  assert.deepEqual(plain(flow.mod.screens().list).map((s) => s.child).slice(0, 3), ["home", "work", "gitlab"]);
  const ids = palette(flow.mod, []).entries().map((e) => e.id);
  assert.ok(ids.includes("flow.queue") && ids.includes("flow.agent-view") && ids.includes("flow.thread") && ids.includes("flow.resume"));
  assert.ok(flow.mod.available("flow", "queue") && !flow.mod.available("flow", "terminal") && !flow.mod.available("flow", "sidebar"));
});
test("a query nothing matches offers Start work on it, in the Start dialog", async () => {
  const f = await fixture({ layout: "flow" });
  const p = palette(f.mod, []);
  Object.assign(p, { input: { value: () => "Fix the zz-qq redirect" }, found: [] });
  const rows = p.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].head, rows[0].e.title], ["Nothing matches", "Start work: Fix the zz-qq redirect"]);
  rows[0].e.act();
  const [, spec] = plain(f.calls.find((c) => c[0] === "overlay"));
  assert.deepEqual([spec.props.app, spec.props.source], ["start", "Fix the zz-qq redirect"], "the Start dialog, prefilled");
  Object.assign(p, { input: { value: () => "recap" }, found: [] });
  assert.ok(!p.rows().some((r) => r.e.fallback), "a command matches: no Start work row");
  Object.assign(p, { input: { value: () => "zz-qq redirect" }, found: [{ kind: "session", title: "Daily quotas for ENG-412", target: {} }] });
  assert.deepEqual(plain(p.rows().map((r) => (r.e.fallback ? "start" : "found"))), ["found", "start"], "past sessions the hub found, then Start work");
});
test("an empty query lists the hub's agents first, in its order, then what was picked lately; the selection keeps its entry", async () => {
  const { mod } = await fixture();
  const e = (id, group, extra = {}) => ({ id, group, title: id, ...extra });
  const all = [
    e("fork-tab", "Session"),
    e("app:home", "Flow"),
    e("flow.recap", "Flow"),
    e("agent:t3", "Places", { waiting: false }),
    e("agent:t1", "Places", { waiting: true }),
    e("agent:t2", "Places", { waiting: true }),
    e("agent:t9", "Places", { waiting: false }),
    e("tab.new", "Tab"),
  ];
  const rows = plain(mod.emptyRows(all, ["flow.recap", "agent:t1", "gone"], ["agent:t1", "agent:t2", "agent:t3"]));
  assert.deepEqual(
    rows.map((r) => `${r.head}: ${r.e.id}`),
    ["Waiting on you: agent:t1", "Waiting on you: agent:t2", "Agents: agent:t3", "Recent: flow.recap", "Session: fork-tab", "Flow: app:home", "Places: agent:t9", "Tab: tab.new"],
  );
  assert.equal(mod.keepSelection(rows, "fork-tab", 1), 4, "the agents arrived above it: it moved, so did the selection");
  assert.equal(mod.keepSelection(rows, "gone", 20), rows.length - 1);
});

test("the sidebar runs the agents menu's commands", async () => {
  const { mod } = await fixture({ layout: "flow", shown: tree("center", "home") });
  const sidebar = Object.create(mod.Sidebar.prototype);
  let ran = 0;
  sidebar.agents = { command: () => (ran++, true) };
  sidebar.command("agents|fork|app:t41|tab", context().cx);
  assert.equal(ran, 1);
});
test("a copy of the Flow layout is that layout, and a screen it doesn't have is put back", async () => {
  const { mod, shared } = await fixture({ layout: "flow", app: "needs" });
  assert.equal(mod.baseOf("flow-copy", () => null), "flow");
  assert.equal(mod.baseOf("reading", () => ({ cloned_from: { name: "flow" } })), "flow");
  assert.equal(mod.baseOf("main", () => null), "flow");
  mod.settle();
  assert.equal(shared["flow.app"], "home");
});
test("a keys.json value written as a number reaches Herdr as one", async () => {
  const { mod, calls } = await fixture();
  mod.runAction("tab.select:1");
  mod.runAction("pane.split:right");
  assert.deepEqual(plain(calls), [["tab.select", { index: 1 }], ["pane.split", { direction: "right" }]]);
});

test("every node of a cockpit layout has an id of its own, so Herdr finds the one a drag or a command names", async () => {
  for (const name of ["flow"]) {
    const ids = [];
    const walk = (node) => {
      if (node?.id) ids.push(node.id);
      for (const child of [...(node?.children ?? []), ...(node?.floating ?? [])]) walk(child);
    };
    walk(await json(new URL(`layouts/${name}.json`, app)));
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], name);
  }
});
