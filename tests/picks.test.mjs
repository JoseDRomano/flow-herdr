import assert from "node:assert/strict";
import { test } from "node:test";
import { startPicks, keptPicks } from "../mods/flow/picks.js";

// An agent's `picks` as the hub sends them: Claude Code's table and Codex's, whose fast mode is a toggle in its terminal.
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const claude = {
  agent: "Claude Code", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }, { id: "fable", label: "Fable" }],
  efforts: LEVELS, fast: true, start: { model: true, effort: true, fast: true }, live: ["model", "effort", "fast"],
  applies: { model: "call", effort: "turn", fast: "turn" },
  typed: { model: { command: "/model {model}" }, effort: { command: "/effort {effort}" }, fast: { command: "/fast {fast}" } },
};
const codex = {
  agent: "Codex", models: [{ id: "gpt-acme-1", label: "GPT Acme 1", efforts: ["low", "high"], fast: true }, { id: "gpt-acme-mini", label: "GPT Acme mini", efforts: [], fast: false }],
  efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], fast: true, start: { model: true, effort: true, fast: true }, live: [],
  typed: { model: { command: "/model {model}" }, effort: { command: "/model --reasoning={effort}" }, fast: { byHand: "/fast" } },
};
const plain = { agent: "OpenCode", models: [], efforts: [], fast: false, start: { model: true, effort: false, fast: false }, live: [], typed: { model: null, effort: null, fast: null } };

test("a Start work form offers what the agent takes at start, its own default first", () => {
  const offered = startPicks({ picks: claude });
  assert.deepEqual(offered.models[0], ["", "Its default"]);
  assert.equal(offered.efforts.length, LEVELS.length + 1);
  assert.deepEqual(offered.fast.map(([v]) => v), ["", "on", "off"]);
  assert.deepEqual(startPicks({ picks: plain }), { models: [], efforts: [], fast: [] });
  assert.deepEqual(startPicks({ picks: codex }, "gpt-acme-mini").efforts, [], "a model without levels offers none");
  assert.deepEqual(keptPicks({ picks: codex }, { model: "gpt-acme-mini", effort: "high", fast: "on" }), { model: "gpt-acme-mini", effort: "", fast: "" });
  assert.deepEqual(keptPicks({ picks: claude }, { model: "gpt-acme-1", effort: "max", fast: "on" }), { model: "", effort: "max", fast: "on" }, "another agent's model goes");
  assert.deepEqual(keptPicks({ picks: plain }, { model: "acme/large", effort: "", fast: "" }).model, "acme/large", "typed for an agent that lists none");
});

