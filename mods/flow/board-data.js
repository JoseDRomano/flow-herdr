// The Notion board's data as plain functions: what Notion's MCP server answers (a database's fetch, a data source's
// rows) turned into the board's columns and cards, and the arguments of the calls that change it. No imports, so the
// view, the sidebar and the tests share them.

/** Notion's hosted MCP server, reached through `cockpit connector call` with cockpit's own login. */
export const SERVER = "https://mcp.notion.com/mcp";

/** Shared-state keys: the board the person picked, and the last read of it. */
export const CONFIG = "flow.board.config";
export const DATA = "flow.board";

/** Read again after this long; a read under way is trusted this long before another starts. */
export const FRESH_MS = 60 * 1000;
export const FETCH_MS = 45 * 1000;

/** The status groups in the order a board shows them; `complete` holds the done columns. */
const GROUP_ORDER = ["to_do", "current", "future", "in_progress", "complete"];

/** Notion's option colors in the theme's terms, for the column dots and the chips. */
export const COLORS = {
  default: "#8a8f98", gray: "#8a8f98", brown: "#a27763", orange: "#d9730d", yellow: "#cb912f", green: "#448361",
  blue: "#337ea9", purple: "#9065b0", pink: "#c14c8a", red: "#d44c47",
};
export const colorOf = (name) => COLORS[name] ?? COLORS.default;

/** The data sources in a `notion-fetch` answer's text: `[{ url, name, schema }]`, each with its schema read. */
export function parseSources(text) {
  const out = [];
  const re = /<data-source url="\{\{(collection:\/\/[0-9a-f-]+)\}\}">([\s\S]*?)<\/data-source>/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const state = /<data-source-state>\s*(\{[\s\S]*?\})\s*<\/data-source-state>/.exec(m[2]);
    let parsed = null;
    try {
      parsed = state ? JSON.parse(state[1]) : null;
    } catch {
      parsed = null;
    }
    out.push({ url: m[1], name: parsed?.name ?? "", schema: parsed?.schema ?? null });
  }
  // A data source fetched by its own collection:// URL has its state alone, outside a <data-source> tag.
  if (!out.length) {
    const state = /<data-source-state>\s*(\{[\s\S]*?\})\s*<\/data-source-state>/.exec(String(text ?? ""));
    try {
      const parsed = state && JSON.parse(state[1]);
      if (parsed?.url) out.push({ url: parsed.url.replace(/^\{\{|\}\}$/g, ""), name: parsed.name ?? "", schema: parsed.schema ?? null });
    } catch {
      // Not a data source.
    }
  }
  return out;
}

/** The data-source id a collection:// URL names. */
export const sourceId = (url) => String(url ?? "").replace(/^collection:\/\//, "");

/**
 * How a schema becomes a board: the title property, the property the columns come from (the first status, else the
 * first select), the columns in order (done ones flagged), and the other properties a card shows. Null without a
 * property to make columns of.
 */
export function shapeOf(schema) {
  const props = Object.values(schema ?? {});
  const title = props.find((p) => p.type === "title")?.name ?? null;
  const by = props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select");
  if (!title || !by) return null;
  let columns;
  if (by.type === "status") {
    const groups = by.groups ?? {};
    const order = [...GROUP_ORDER.filter((g) => g in groups), ...Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g))];
    columns = order.flatMap((g) => (groups[g] ?? []).map((o) => ({ name: o.name, color: o.color ?? "default", done: g === "complete" })));
  } else {
    columns = (by.options ?? []).map((o) => ({ name: o.name, color: o.color ?? "default", done: /^(done|complete|completed|closed)$/i.test(o.name) }));
  }
  const extras = props
    .filter((p) => p.name !== title && p.name !== by.name && ["select", "multi_select", "text", "rich_text", "date", "people", "person"].includes(p.type))
    .map((p) => ({ name: p.name, type: p.type, colors: Object.fromEntries((p.options ?? []).map((o) => [o.name, o.color ?? "default"])) }));
  return { title, by: by.name, kind: by.type, columns, extras };
}

/** A page's id from its Notion URL: the last 32 hex digits. */
export function pageId(url) {
  const m = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(String(url ?? "").replace(/-/g, ""));
  return m ? m[1] : null;
}

/** A property's value from a rows-mode answer, as a list of words (a multi-select comes as a JSON array in text). */
export function words(value) {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value);
  if (text.startsWith("[")) {
    try {
      const list = JSON.parse(text);
      if (Array.isArray(list)) return list.map(String).filter(Boolean);
    } catch {
      // Plain text that starts with a bracket.
    }
  }
  return [text];
}

/** The rows of a rows-mode answer as cards: `{ id, url, title, status, fields: [{ name, type, values, colors }] }`. */
export function cardsOf(rows, shape) {
  return (rows ?? [])
    .map((r) => ({
      id: pageId(r.url),
      url: r.url,
      title: String(r[shape.title] ?? "").trim() || "Untitled",
      status: r[shape.by] || null,
      fields: shape.extras.map((x) => ({ name: x.name, type: x.type, values: words(r[x.name]).map((v) => v.replace(/\\([{}])/g, "$1")), colors: x.colors })).filter((f) => f.values.length),
    }))
    .filter((c) => c.id);
}

/** The board's columns with their cards; cards with no status get a "No status" column first, when there are any. */
export function columnsOf(shape, cards) {
  const known = new Set(shape.columns.map((c) => c.name));
  const loose = cards.filter((c) => !c.status || !known.has(c.status));
  const cols = shape.columns.map((c) => ({ ...c, cards: cards.filter((x) => x.status === c.name) }));
  return loose.length ? [{ name: "No status", color: "default", done: false, none: true, cards: loose }, ...cols] : cols;
}

/** The filter on the column property that keeps the open cards (`done: false`) or the done ones (`done: true`). */
export function filterFor(shape, done) {
  const names = shape.columns.filter((c) => c.done).map((c) => c.name);
  const one = (name) => ({
    type: "property",
    property: shape.by,
    propertyType: shape.kind,
    operator: shape.kind === "status" ? (done ? "status_is" : "status_is_not") : done ? "enum_is" : "enum_is_not",
    value: { type: shape.kind === "status" ? "is_option" : "exact", value: name },
  });
  if (!names.length) return null;
  return { type: "group", operator: done ? "or" : "and", filters: names.map(one) };
}

/** The `notion-query-data-sources` arguments for the open cards or the done ones. */
export function queryArgs(source, shape, done) {
  const filter = filterFor(shape, done);
  if (done && !filter) return null;
  return { data: { mode: "rows", data_source_url: source, ...(filter ? { filter } : {}), limit: 100 } };
}

/** The `notion-update-page` arguments that move a card to a column. */
export const moveArgs = (card, shape, column) => ({ page_id: card.id, command: "update_properties", properties: { [shape.by]: column }, allow_async: false });

/** The `notion-create-pages` arguments for a new card in a column. */
export function createArgs(source, shape, title, column) {
  const properties = { [shape.title]: title };
  if (column) properties[shape.by] = column;
  return { parent: { type: "data_source_id", data_source_id: sourceId(source) }, pages: [{ properties }] };
}

/** What a failed call says, in a line a person reads, and whether signing in again is the fix. */
export function failure(text) {
  const t = String(text ?? "").trim();
  if (/stored login unreadable/i.test(t)) {
    return { login: true, unreadable: true, message: "cockpit can't read its saved Notion login: it holds a character outside plain ASCII (often an emoji workspace icon)." };
  }
  if (/connector login|auth required|unauthori[sz]ed|invalid_grant|401/i.test(t)) return { login: true, message: "cockpit isn't signed in to Notion." };
  if (/object_not_found|could not find|not found/i.test(t)) return { login: false, message: "Notion can't find that board, or your login can't see it." };
  return { login: false, message: t.split("\n")[0].slice(0, 240) || "Notion did not answer." };
}
