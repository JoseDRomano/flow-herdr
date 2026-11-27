// Flow's looks are layouts of their own written from layouts/flow.json by scripts/looks.py: the same tree and keys,
// their own themes, picture and the changes scripts/looks.json gives them. A look out of date fails here; run
// `python3 scripts/looks.py`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path) => access(new URL(`../${path}`, import.meta.url)).then(() => true, () => false);

const LOOKS = { "flow-mist": ["flow-mist", "flow-mist-light"], "flow-daylight": ["flow-daylight", "flow-daylight-light"] };
const flow = JSON.parse(await read("layouts/flow.json"));
const keys = JSON.parse(await read("keys.json"));
const changes = JSON.parse(await read("scripts/looks.json"));

/** Sets each key on the target, and takes out a key set to null: what looks.py does. */
function change(target, set = {}) {
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

/** Flow's layout with a look's changes: root keys, named nodes, every card and the panes' frame. */
function patched(tree, look = {}) {
  const out = structuredClone(tree);
  change(out, look.root);
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    change(node, look.nodes?.[node.id]);
    if (node.background === "background" && "radius" in node) change(node, look.cards);
    if (node.content?.pane) change(node.content.pane, look.panes);
    for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) walk(c);
  };
  walk(out);
  return out;
}

test("each look is Flow's layout with its own themes and picture", async () => {
  for (const [name, [dark, light]] of Object.entries(LOOKS)) {
    const look = JSON.parse(await read(`layouts/${name}.json`));
    assert.deepEqual(look.theme, { light, dark }, `${name} opens in its own themes`);
    assert.equal(look.preview, `layouts/${name}.svg`);
    assert.ok(name in changes, `scripts/looks.json names ${name}`);
    const want = patched(flow, changes[name]);
    assert.deepEqual({ ...look, theme: null, preview: null }, { ...want, theme: null, preview: null }, `${name} is flow.json with its changes otherwise: run scripts/looks.py`);
  }
});

test("each look has Flow's keys, its themes and its pictures", async () => {
  for (const [name, themes] of Object.entries(LOOKS)) {
    assert.deepEqual(keys[`layout:${name}`], keys["layout:flow"], `layout:${name} has layout:flow's keys: run scripts/looks.py`);
    for (const t of themes) assert.ok(await exists(`themes/${t}.json`), `themes/${t}.json`);
    for (const p of [`layouts/${name}.svg`, `mods/flow/layouts/${name}-dark.png`, `mods/flow/layouts/${name}-light.png`]) assert.ok(await exists(p), p);
  }
});

test("Flow itself opens in its classic themes", () => {
  assert.deepEqual(flow.theme, { light: "flow-light", dark: "flow" });
});

test("Daylight's cards are glass over its sky, and each of its themes names that sky", async () => {
  const look = JSON.parse(await read("layouts/flow-daylight.json"));
  const body = look.children.find((c) => c.id === "body");
  assert.deepEqual(body.background, { gradient: ["sky_rise_from", "sky_rise"], angle: 180 });
  const home = JSON.stringify(look).match(/"id":"home-board"[^}]*}[^}]*}/)?.[0] ?? "";
  assert.ok(!home.includes("shadow"), "a shadow under glass greys it");
  for (const t of ["flow-daylight", "flow-daylight-dawn", "flow-daylight-light", "flow-daylight-light-dawn"]) {
    const { colors, background } = JSON.parse(await read(`themes/${t}.json`));
    assert.match(background, /^#[0-9a-f]{6}$/, `${t}: the terminals' background stays opaque`);
    assert.match(colors.background, /^#[0-9a-f]{8}$/, `${t}: its cards are see-through`);
    for (const k of ["sky_rise_from", "sky_rise", "sky_floor", "sky_ink", "glass_line", "glass_focus", "quota", "need", "need_ring"]) assert.ok(colors[k], `${t} names ${k}`);
  }
});
