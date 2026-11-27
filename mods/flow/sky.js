// Daylight's sky follows the agents: dawn while one of them waits on you, night otherwise. It only ever swaps a
// Daylight theme for its twin, so on any other theme it does nothing.

import { theme, themes, run } from "herdr";

/** Each Daylight theme and its twin for the other state, in both appearances. */
export const TWINS = {
  "flow-daylight": "flow-daylight-dawn",
  "flow-daylight-dawn": "flow-daylight",
  "flow-daylight-light": "flow-daylight-light-dawn",
  "flow-daylight-light-dawn": "flow-daylight-light",
};

const hex = (c) => String(c ?? "").toLowerCase().slice(0, 7);

/** The Daylight theme the window shows, known by its sky and accent, or null on any other theme. */
export function shownSky(now, list) {
  const same = (colors) => ["canvas", "chrome", "accent"].every((k) => hex(colors?.[k]) === hex(now?.[k]));
  return (list ?? []).find((t) => t?.name in TWINS && same(t.colors))?.name ?? null;
}

/** The Daylight theme for this state: the dawn twin while an agent waits on you, the night one otherwise. */
export function skyFor(name, waiting) {
  return name.endsWith("-dawn") === Boolean(waiting) ? name : TWINS[name];
}

let asked = null;

/** Swaps the shown Daylight theme for its twin when the number of agents waiting on you calls for the other one. */
export function followSky(waiting) {
  try {
    const shown = shownSky(theme(), themes());
    if (!shown) return;
    const want = skyFor(shown, waiting > 0);
    if (want === shown) {
      asked = null;
      return;
    }
    if (asked === want) return;
    asked = want;
    run("app.theme", { name: want });
  } catch {}
}
