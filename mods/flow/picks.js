// What a person picks beside a prompt (a model, an effort level, fast mode) as the hub's `picks` describe an agent: the
// Start work form reads it. No natives, so tests load it as it is.

/** An effort level as the form says it: "xhigh" is "Extra high". */
export function effortName(level) {
  const named = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" }[level];
  return named ?? (level ? `${level[0].toUpperCase()}${level.slice(1)}` : "");
}

/**
 * What a Start work form offers for an agent beside its prompt, as its `picks` say: `{models, efforts, fast}`, each a list
 * of [value, label] whose first is the agent's own default (""); a list is empty where the agent takes no such setting at
 * start. `model` is the model picked, whose own effort levels and fast mode count.
 */
export function startPicks(agent, model = "") {
  const p = agent?.picks;
  if (!p) return { models: [], efforts: [], fast: [] };
  const offers = p.start?.model ? (p.models ?? []) : [];
  const offer = offers.find((m) => m.id === model);
  const levels = p.start?.effort ? (offer?.efforts ?? p.efforts ?? []) : [];
  const fast = Boolean(p.start?.fast) && offer?.fast !== false;
  return {
    models: offers.length ? [["", "Its default"], ...offers.map((m) => [m.id, m.label])] : [],
    efforts: levels.length ? [["", "Its default"], ...levels.map((l) => [l, effortName(l)])] : [],
    fast: fast ? [["", "Its default"], ["on", "Fast"], ["off", "Standard"]] : [],
  };
}

/** A form's picks once the agent or the model changed: what the new one does not take goes back to its default. */
export function keptPicks(agent, s) {
  const offered = startPicks(agent, s.model);
  const has = (list, v) => !v || list.some(([x]) => x === v);
  // A model typed by hand stays for an agent that lists none.
  const model = offered.models.length && !has(offered.models, s.model) ? "" : s.model;
  const now = startPicks(agent, model);
  return { model, effort: has(now.efforts, s.effort) ? s.effort : "", fast: has(now.fast, s.fast) ? s.fast : "" };
}
