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

/** The views a database's fetch answer gives, each `{ url, name, type, groupBy, displayProperties, cardSize }`. */
export function viewsOf(text) {
  const out = [];
  for (const found of String(text ?? "").matchAll(/<view\b([^>]*)>([\s\S]*?)<\/view>/gi)) {
    let value;
    try {
      value = JSON.parse(found[2].trim());
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const url = /url\s*=\s*"\{\{(view:\/\/[^}]+)\}\}"/i.exec(found[1])?.[1] ?? null;
    out.push({
      url,
      name: String(value.name ?? "").trim(),
      type: String(value.type ?? "").trim(),
      groupBy: value.groupBy && typeof value.groupBy === "object" ? value.groupBy : null,
      displayProperties: Array.isArray(value.displayProperties) ? value.displayProperties.map(String) : null,
      cardSize: String(value.cardSize ?? "").trim() || null,
    });
  }
  return out;
}

/** The view a database's board follows: its first board view, which Notion names Kanban in most workspaces. */
export const boardViewOf = (views) => (views ?? []).find((v) => v.type === "board") ?? null;

/**
 * How a schema becomes a board: the title property, the property the columns come from (the board view's, else the
 * first status, else the first select), the columns in order (done ones flagged), and the other properties a card
 * shows (the view's own when it says). Null without a property to make columns of.
 */
export function shapeOf(schema, view = null) {
  const props = Object.values(schema ?? {});
  const title = props.find((p) => p.type === "title")?.name ?? null;
  const grouped = view?.groupBy?.property ? props.find((p) => p.name === view.groupBy.property && (p.type === "status" || p.type === "select")) : null;
  const by = grouped ?? props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select");
  if (!title || !by) return null;
  let columns;
  if (by.type === "status") {
    const groups = by.groups ?? {};
    const order = [...GROUP_ORDER.filter((g) => g in groups), ...Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g))];
    columns = order.flatMap((g) => (groups[g] ?? []).map((o) => ({ name: o.name, color: o.color ?? "default", done: g === "complete" })));
  } else {
    columns = (by.options ?? []).map((o) => ({ name: o.name, color: o.color ?? "default", done: /^(done|complete|completed|closed)$/i.test(o.name) }));
  }
  if (view?.groupBy?.sort?.type === "descending") columns = [...columns].reverse();
  const listed = Boolean(view?.displayProperties?.length);
  const shown = new Set((view?.displayProperties ?? []).filter((name) => name !== title && name !== by.name));
  const extras = props
    .filter((p) => p.name !== title && p.name !== by.name && ["select", "multi_select", "text", "rich_text", "date", "people", "person"].includes(p.type))
    .filter((p) => !listed || shown.has(p.name))
    .sort((a, b) => (view?.displayProperties ?? []).indexOf(a.name) - (view?.displayProperties ?? []).indexOf(b.name))
    .map((p) => ({ name: p.name, type: p.type, colors: Object.fromEntries((p.options ?? []).map((o) => [o.name, o.color ?? "default"])) }));
  return { title, by: by.name, kind: by.type, columns, extras, view: view ? { name: view.name, type: view.type, url: view.url } : null };
}

/** The first column that counts as done, and the first that does not: where a card is marked done and reopened. */
export const doneColumn = (shape) => (shape?.columns ?? []).find((c) => c.done)?.name ?? null;
export const openColumn = (shape) => (shape?.columns ?? []).find((c) => !c.done)?.name ?? null;
export const isDoneColumn = (shape, name) => Boolean((shape?.columns ?? []).find((c) => c.name === name && c.done));

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

/** The board's columns as shown, done ones included only when `showDone`: from its open cards and its read done ones. */
export function shownColumns(board, showDone = false) {
  const cards = showDone ? [...(board?.cards ?? []), ...(board?.doneCards ?? [])] : (board?.cards ?? []);
  const columns = columnsOf(board?.shape ?? { columns: [] }, cards);
  return showDone ? columns : columns.filter((c) => !c.done);
}

/** A board with the open cards a read answer gives, its done cards kept, and its columns read again. */
export function withCards(board, cards) {
  return { ...board, cards, count: cards.length, columns: columnsOf(board.shape, cards) };
}

/** A board with the done cards a read answer gives. */
export function withDone(board, cards) {
  return { ...board, doneCards: cards, doneCount: cards.length };
}

/** A board with one card moved to a column, drawn at once before Notion answers. */
export function moveInBoard(board, cardId, column) {
  const all = [...(board?.cards ?? []), ...(board?.doneCards ?? [])];
  const card = all.find((c) => c.id === cardId);
  if (!card || card.status === column) return board;
  const moved = { ...card, status: column };
  const open = (board.cards ?? []).filter((c) => c.id !== cardId);
  const done = (board.doneCards ?? []).filter((c) => c.id !== cardId);
  if (isDoneColumn(board.shape, column)) done.push(moved);
  else open.push(moved);
  return { ...withCards(board, open), doneCards: done, doneCount: done.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// The boards the person pinned, kept in the window's shared state

/** A pinned page or database as Flow lists it: `{ key, url, title, icon, type }`, from what the shared state holds. */
export function pinnedItems(value) {
  const list = Array.isArray(value?.boards) ? value.boards : [];
  const out = [];
  const seen = new Set();
  for (const board of list) {
    const url = String(board?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      key: url,
      url,
      title: String(board?.title ?? "").trim() || "(untitled)",
      icon: typeof board?.icon === "string" && board.icon.trim() ? board.icon.trim() : null,
      type: board?.type === "database" ? "database" : "page",
    });
  }
  return out;
}

/** The shared state with `item` pinned (`on`) or unpinned; unpinning the current one clears it. */
export function pinItem(value, item, on = true) {
  const config = value && typeof value === "object" ? value : {};
  const items = pinnedItems(config);
  const key = String(item?.key ?? item?.url ?? "");
  const boards = on
    ? items.some((b) => b.key === key)
      ? items.map((b) => (b.key === key ? { ...b, ...item, key } : b))
      : [...items, { key, url: String(item?.url ?? key), title: String(item?.title ?? "").trim() || "(untitled)", icon: item?.icon ?? null, type: item?.type === "database" ? "database" : "page" }]
    : items.filter((b) => b.key !== key);
  const current = boards.some((b) => b.key === config.current) ? config.current : null;
  return { ...config, boards, current };
}

/** The shared state with `key` as the board the Notion screen opens, when it is pinned. */
export function pinCurrent(value, key) {
  const config = value && typeof value === "object" ? value : {};
  const current = pinnedItems(config).some((b) => b.key === key) ? key : null;
  return { ...config, current };
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
  return { parent: { type: "data_source_id", data_source_id: sourceId(source) }, pages: [{ properties }], allow_async: false };
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
