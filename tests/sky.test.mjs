// Daylight's sky: which Daylight theme the window shows, which twin the agents' state calls for, and that twins share
// their terminal colours so a swap never repaints a terminal.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const native = { theme: () => ({}), themes: () => [], run: () => {} };
globalThis.skyNative = native;
const source = (await read("../mods/flow/sky.js")).replace(
  /^import \{[^}]+\} from "herdr";$/m,
  "const { theme, themes, run } = { theme: () => globalThis.skyNative.theme(), themes: () => globalThis.skyNative.themes(), run: (...a) => globalThis.skyNative.run(...a) };",
);
const sky = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const NAMES = Object.keys(sky.TWINS);
const files = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, JSON.parse(await read(`../themes/${n}.json`))])));
const list = NAMES.map((name) => ({ name, light: name.includes("-light"), colors: { ...files[name].colors } }));

test("each Daylight theme has its twin, and twins share their terminal colours", () => {
  for (const [name, twin] of Object.entries(sky.TWINS)) {
    assert.equal(sky.TWINS[twin], name, `${twin} points back to ${name}`);
    for (const key of ["background", "foreground", "selection", "cursor"]) assert.equal(files[name][key], files[twin][key], `${name} and ${twin} share ${key}`);
    assert.deepEqual(files[name].ansi, files[twin].ansi, `${name} and ${twin} share their ANSI colours`);
    assert.notEqual(files[name].colors.chrome + files[name].colors.canvas, files[twin].colors.chrome + files[twin].colors.canvas, "the skies differ");
  }
});

test("the shown Daylight theme is known by its colours; any other theme is not one", () => {
  for (const { name, colors } of list) assert.equal(sky.shownSky(colors, list), name);
  assert.equal(sky.shownSky({ canvas: "#0c1012", chrome: "#0c1012", accent: "#5fd4c4" }, list), null);
  assert.equal(sky.shownSky({ ...files["flow-daylight"].colors, accent: "#5fd4c4ff" }, list), null);
});

test("dawn while an agent waits on you, night otherwise, in both appearances", () => {
  assert.equal(sky.skyFor("flow-daylight", true), "flow-daylight-dawn");
  assert.equal(sky.skyFor("flow-daylight", false), "flow-daylight");
  assert.equal(sky.skyFor("flow-daylight-dawn", false), "flow-daylight");
  assert.equal(sky.skyFor("flow-daylight-light", true), "flow-daylight-light-dawn");
  assert.equal(sky.skyFor("flow-daylight-light-dawn", true), "flow-daylight-light-dawn");
});

test("the sky asks for its twin once, and leaves every other theme alone", () => {
  const calls = [];
  native.run = (...a) => calls.push(a);
  native.themes = () => list;
  native.theme = () => files["flow-daylight"].colors;
  sky.followSky(1);
  sky.followSky(2);
  assert.deepEqual(calls, [["app.theme", { name: "flow-daylight-dawn" }]], "one request while it applies");
  native.theme = () => files["flow-daylight-dawn"].colors;
  sky.followSky(1);
  sky.followSky(0);
  assert.deepEqual(calls.at(-1), ["app.theme", { name: "flow-daylight" }], "back to night once nothing waits");
  const before = calls.length;
  native.theme = () => ({ canvas: "#0c1012", chrome: "#0c1012", accent: "#5fd4c4" });
  sky.followSky(3);
  assert.equal(calls.length, before, "another theme stays as the person picked it");
  native.themes = () => {
    throw new Error("no themes");
  };
  assert.doesNotThrow(() => sky.followSky(1));
});
