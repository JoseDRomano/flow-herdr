import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { test } from "node:test";

// The mod loaded in a VM with Herdr's natives stubbed: `shown` is the screen in front, `acts` every hub action sent.
async function fixture({ layout = "flow", shown = null, answers = {}, down = false } = {}) {
  const acts = [], notices = [], calls = [], overlays = [];
  const shared = { layout, "flow.app": shown };
  // The shown layout as Herdr gives it: the screens' stack with its active child.
  const tree = () => {
    const now = shared["flow.app"];
    return { id: "root", children: [{ id: "center", type: "stack", active: now, children: [{ id: "home" }] }] };
  };
  const context = createContext({ console });
  const imports = {
    herdr: {
      agents: () => [],
      spaces: () => [],
      run: (...args) => calls.push(args),
      setShared: (key, value) => (shared[key] = value),
      shared: (key) => shared[key] ?? null,
      notify: (notice) => notices.push(notice),
      theme: () => ({}),
      layout: () => tree(),
      openOverlay: (overlay) => overlays.push(overlay),
    },
    "./hub.js": {
      act: async (app, action, args) => {
        acts.push({ app, action, args });
        if (down) throw new Error("connect ECONNREFUSED 127.0.0.1");
        return answers[`${app} ${action}`] ?? { note: "ok", error: null };
      },
      openUrl: () => {},
      isUnconfirmed: (e) => Boolean(e?.unconfirmed),
    },
  };
  const sources = new Map(), modules = new Map();
  const folder = new URL("../mods/flow/", import.meta.url);
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".js")) continue;
    const text = await readFile(new URL(name, folder), "utf8");
    sources.set(`./${name}`, text);
    for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(herdr|gpui-kit|gpui-base)"/g)) {
      const exports = imports[match[2]] ??= {};
      for (const word of match[1].split(",")) {
        const key = word.trim().split(/\s+as\s+/)[0];
        exports[key] ??= () => { throw new Error(`unexpected native call: ${key}`); };
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
  const entry = 'export * from "./fleet.js"; export * from "./front.js"; export { AgentsModel, openPlan, planTitle, planNumber } from "./agentsui.js"; export { default as Home } from "./home.js"; export { keyed, unkey } from "./person.js";';
  const module = new SourceTextModule(entry, { context });
  await module.link(load);
  await module.evaluate();
  return { mod: module.namespace, acts, notices, calls, shared, overlays };
}

// The VM's objects as plain data, so they compare with this realm's.
const plain = (value) => JSON.parse(JSON.stringify(value));

// A context whose spawned work runs at once and whose promises can be awaited.
function context() {
  const work = [];
  const cx = { notify() {}, stop_propagation() {}, spawn: (f) => work.push(f(cx)) };
  return { cx, settled: () => Promise.all(work) };
}

const driven = {
  terminal: "claude:demo-421", address: "claude:demo-421", frontend: "app", driven: true, stage: "needs_you", status: "blocked", since: 1,
  question: { text: "May it run Bash: mix test?", kind: "single", permission: true, cursor: null, ask: "toolu_demo_421", choices: [{ n: 1, label: "Allow once" }, { n: 2, label: "Deny" }] },
};
const terminal = {
  terminal: "app:t41", address: "t41", frontend: "app", stage: "needs_you", status: "blocked", since: 2,
  question: { text: "Which limit?", kind: "single", permission: false, cursor: 1, asked: "0123456789abcdef", choices: [{ n: 1, label: "The plan's default" }, { n: 2, label: "Their peak" }] },
};

test("a question keeps what names it, and a permission has nothing picked", async () => {
  const { mod } = await fixture();
  const q = mod.questionOf(driven);
  assert.equal(q.ask, "toolu_demo_421");
  assert.equal(q.cursor, -1, "no choice is drawn as the one under the cursor");
  const t = mod.questionOf(terminal);
  assert.equal(t.asked, "0123456789abcdef");
  assert.equal(t.cursor, 0, "a plain question keeps its cursor");
});

test("every answer names the question it answers and where it came from", async () => {
  const { mod } = await fixture();
  assert.deepEqual(plain(mod.answerPayload("claude:demo-421", driven.question, { choice: 1 }, "chat:click")), { terminal: "claude:demo-421", choice: 1, ask: "toolu_demo_421", source: "chat:click" });
  assert.deepEqual(plain(mod.answerPayload("app:t41", terminal.question, { choices: [1, 2] }, "needs:click")), { terminal: "app:t41", choices: [1, 2], asked: "0123456789abcdef", source: "needs:click" });
  assert.deepEqual(plain(mod.answerPayload("app:t41", null, { text: "later" }, "home:key")), { terminal: "app:t41", text: "later", source: "home:key" }, "nothing shown: nothing named, so the hub refuses it");
});

test("the question card's answer goes out with its ask, and a refusal says the question changed", async () => {
  const refused = { "agents answer": { note: "", error: "answer: The question changed — look again" } };
  const { mod, acts, notices } = await fixture({ answers: refused });
  const model = Object.create(mod.AgentsModel.prototype);
  Object.assign(model, { view: "needs", busy: new Map(), picks: new Map(), value: { agents: [driven] } });
  const { cx, settled } = context();
  model.answer(cx, driven, 1);
  model.answer(cx, driven, 7);
  await settled();
  assert.equal(acts.length, 1, "a number the question does not offer sends nothing");
  assert.deepEqual(plain(acts[0].args[0]), { terminal: "claude:demo-421", choice: 1, ask: "toolu_demo_421", source: "needs:click" });
  assert.equal(notices[0].title, "The question changed — look again");
});

test("a choice that runs every tool unasked is confirmed only from the step its menu opened, once", async () => {
  const { mod, acts, overlays, notices } = await fixture();
  const full = {
    terminal: "app:t42", address: "t42", frontend: "app", stage: "needs_you", status: "blocked", since: 3,
    question: { text: "Select Approval Mode", kind: "single", permission: true, cursor: null, asked: "fedcba9876543210", preview: "Select Approval Mode", unasked: [3],
      choices: [{ n: 1, label: "Read Only" }, { n: 2, label: "Ask" }, { n: 3, label: "Full Access" }] },
  };
  const model = Object.create(mod.AgentsModel.prototype);
  Object.assign(model, { view: "needs", busy: new Map(), picks: new Map(), value: { agents: [full] } });
  model.row = (t) => [full].find((r) => r.terminal === t);
  const { cx, settled } = context();
  model.answer(cx, full, 3);
  await settled();
  assert.equal(acts.length, 0, "the hub's unasked choice asks first");
  const items = overlays.at(-1).props.items;
  assert.equal(items[0].label, "Cancel", "Cancel first");
  // A window command from outside, in the shape the menu once used, answers nothing.
  model.command("agents|unasked|app:t42|3/fedcba9876543210", cx);
  await settled();
  assert.equal(acts.length, 0, "no key, no answer");
  model.answer(cx, full, 3);
  // As main.js hands it on: the menu's own key for its opening comes off, the confirm's stays in the command.
  const { command: confirm, key } = mod.unkey(overlays.at(-1).props.items[1].command);
  model.command(confirm, cx, key);
  model.command(confirm, cx, key);
  await settled();
  assert.equal(acts.length, 1, "the menu's own key, used once");
  assert.deepEqual(plain(acts[0].args[0]), { terminal: "app:t42", choice: 3, asked: "fedcba9876543210", confirm: true, source: "needs:confirm" });
  // A permission cockpit cannot show in full is answered in its terminal, in the hub's words.
  const cut = { ...full, terminal: "app:t43", question: { ...full.question, unasked: [], cut: true, terminal_only: "Part of what it would run is off its screen: answer it in its terminal" } };
  model.answer(cx, cut, 1);
  await settled();
  assert.equal(acts.length, 1, "nothing sent");
  assert.equal(notices.at(-1).title, cut.question.terminal_only);
});

test("a hub that does not answer allows nothing and says so", async () => {
  const { mod, acts, notices } = await fixture({ down: true });
  const model = Object.create(mod.AgentsModel.prototype);
  Object.assign(model, { view: "sidebar", busy: new Map(), picks: new Map(), value: { agents: [driven] } });
  const { cx, settled } = context();
  model.answer(cx, driven, 1);
  await settled();
  assert.equal(acts.length, 1, "one try, never repeated");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "The cockpit hub did not answer");
  assert.equal(model.busy.size, 0, "the card is free again, still asking");
});

test("a key from outside reaches the view in front and no other", async () => {
  const { mod } = await fixture();
  const inbox = { app: "inbox", keys: true, at: 1 }, home = { app: "home", keys: true, at: 2 }, recap = { app: "recap", keys: true, overlay: true, at: 3 };
  const panel = { app: "runbook", keys: true, scoped: true, at: 4 }, show = { app: "show", keys: true, at: 5 }, sidebar = { app: "sidebar", keys: false, at: 0 };
  const all = [sidebar, inbox, home, panel, show];
  const apps = (list) => list.map((c) => c.app).join(" ");
  assert.equal(apps(mod.front(all, "inbox")), "inbox", "the inbox in front: Home, hidden, hears nothing");
  assert.equal(apps(mod.front([...all, recap], "inbox")), "recap", "a popup over it takes the key alone");
  assert.equal(apps(mod.front(all, "home")), "home");
  assert.equal(apps(mod.front(all, "todo")), "", "a screen with no copy here");
  assert.equal(apps(mod.front(all, "work")), "runbook show", "an agent's terminal in front: only the panes and the panel beside it");
});

test("a copy a layout switch dropped without a word stops counting once it stops beating", async () => {
  const { mod } = await fixture({ shown: "home" });
  const dropped = { app: "home", keys: true, at: 1, beat: Date.now() - 60_000 };
  const live = { app: "home", keys: true, at: 2, beat: Date.now() };
  mod.enter(dropped);
  mod.enter(live);
  const shown = mod.front();
  assert.equal(shown.length, 1);
  assert.equal(shown[0], live, "the live Home takes the key, not the one left behind");
});

test("Home's keys answer nothing while another screen is in front", async () => {
  const { mod } = await fixture({ shown: "inbox" });
  const home = Object.create(mod.Home.prototype);
  Object.assign(home, { confirm: null, replying: null });
  assert.equal(home.key({ keystroke: "1" }, context().cx), false);
});

test("Home answers a driven session by its own handle", async () => {
  const { mod, acts } = await fixture({ layout: "flow", shown: "home" });
  const [agent] = mod.fleet({ agents: [driven] }, {});
  assert.equal(agent.handle, "claude:demo-421");
  const home = Object.create(mod.Home.prototype);
  Object.assign(home, { busy: new Map(), picks: new Map(), replying: null, toasts: { push() {} }, flashes: { start() {} } });
  const { cx, settled } = context();
  home.answer(cx, agent, { choice: 2 }, "key");
  await settled();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(plain(acts[0].args[0]), { terminal: "claude:demo-421", choice: 2, ask: "toolu_demo_421", source: "home:key" });
});

test("a plan opens in the side panel of its session, and its card names it in one line", async () => {
  const { mod, calls, shared } = await fixture({ layout: "flow" });
  assert.equal(mod.planTitle("Intro line\n\n## Must-have **fixes**\n\n1. One"), "Must-have fixes");
  assert.equal(mod.planTitle(""), "");
  assert.equal(mod.planNumber("plan-9d2e0000-12"), 12);
  assert.equal(mod.planNumber(null), null);
  mod.openPlan({ terminal: "app:t41", address: "t41" }, "plan-9d2e0000-2");
  const pending = shared["flow.show.pending"];
  assert.deepEqual([pending.terminal, pending.name], ["t41", "plan-9d2e0000-2"], "the panel opens on it once it follows the agent");
  assert.equal(JSON.stringify(calls.find((c) => c[0] === "agent.focus")), JSON.stringify(["agent.focus", { terminal: "t41" }]));
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(["flow.doc:plan-9d2e0000-2"]));
  const q = mod.questionOf({ question: { text: "Proceed?", kind: "single", permission: true, markdown: true, view: "plan-9d2e0000-2", preview: "# P", choices: [] } });
  assert.equal(q.view, "plan-9d2e0000-2");
});
