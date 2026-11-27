// Notion for Flow: the calls the Notion screen makes to Notion's hosted MCP server through cockpit's connector, and the
// pages, search results and boards it makes of each answer. `callArgs` builds the caller's call; nothing here has side
// effects.

import {
  SERVER, parseSources, shapeOf, cardsOf, columnsOf, queryArgs, failure, viewsOf, boardViewOf, pinnedItems, pinItem, pinCurrent,
  doneColumn, openColumn, isDoneColumn, shownColumns, withCards, withDone, moveInBoard, words,
} from "./board-data.js";

export {
  SERVER, viewsOf, boardViewOf, pinnedItems, pinItem, pinCurrent,
  doneColumn, openColumn, isDoneColumn, shownColumns, withCards, withDone, moveInBoard,
};

/** How much the screen reads at a time. */
export const LIMITS = { favorites: 8, recent: 20, search: 20 };

/** cockpit's command line that calls one tool of Notion's MCP server. */
export const callArgs = (tool, args = {}) => ["connector", "call", SERVER, tool, JSON.stringify(args)];

/** cockpit's command line that signs in to Notion in the browser. */
export const loginArgs = ["connector", "login", SERVER];

/** The arguments of the reads the screen makes. */
export const listArgs = (limit = LIMITS.recent) => ({ limit });
export const searchArgs = (query) => ({ query: String(query ?? "").trim(), page_size: LIMITS.search });
export const fetchArgs = (url) => ({ id: String(url ?? "") });

/** The arguments of a database's open cards, through board-data's board shape. */
export const rowsArgs = (source, shape, done = false) => queryArgs(source, shape, done);

/** An answer as an object; `{}` for an empty one, and a thrown reason for one that is not JSON. */
export function parseAnswer(stdout, tool = "Notion") {
  const text = String(stdout ?? "").trim();
  if (!text) return {};
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new Error(`${tool}: Notion's answer was not JSON`);
  }
  return answer && typeof answer === "object" ? answer : {};
}

/** A failed call's reason, and whether signing in again is the fix. */
export function errorOf(result) {
  const text = [result?.stderr, result?.stdout].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
  const found = failure(text);
  if (found.login) return found;
  if (/(not signed in|no stored login|login required|not authenticated|reconnect)/i.test(text)) {
    return { login: true, message: "cockpit isn't signed in to Notion." };
  }
  if (/(read-only|remote cockpit|another machine)/i.test(text)) {
    return { login: false, remote: true, message: "This window shows a cockpit on another machine: connect Notion there." };
  }
  return found;
}

const text = (s) => String(s ?? "").trim();

/** A list icon: an emoji, or null for an uploaded image and none. */
const iconOf = (icon) => {
  if (typeof icon === "string") {
    const value = icon.trim();
    return value && !value.startsWith("attachment:") ? value : null;
  }
  return icon?.emoji ?? icon?.custom_emoji?.name ?? null;
};

/** Markdown's marks out of a search result's highlight, on one line. */
export function plainMark(s) {
  return text(s)
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The lists in a search or browse answer as rows, each page or database once. */
export function listItems(answer) {
  const raw = Array.isArray(answer) ? answer : Array.isArray(answer?.results) ? answer.results : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const url = text(item?.url);
    const id = text(item?.id);
    const key = url || id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      id: id || null,
      url: url || null,
      title: (typeof item?.title === "string" ? item.title.trim() : "") || "(untitled)",
      type: item?.type === "database" || item?.type === "data_source" ? "database" : "page",
      icon: iconOf(item?.icon),
      path: text(item?.path),
      highlight: plainMark(item?.highlight).slice(0, 240),
    });
  }
  return out;
}

/** A page's properties, as the fetch answer writes them. */
export function propertiesOf(source) {
  const found = /<properties>\s*([\s\S]*?)\s*<\/properties>/i.exec(String(source ?? ""));
  if (!found) return {};
  try {
    const value = JSON.parse(found[1]);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** A page's title: its title property, else the first plain text property. */
export function titleOf(source, fallback = "Untitled") {
  const props = propertiesOf(source);
  for (const key of ["title", "Name", "name"]) {
    if (typeof props[key] === "string" && props[key].trim()) return props[key].trim();
  }
  const first = Object.entries(props).find(([key, value]) => typeof value === "string" && value.trim() && !/^https?:\/\//i.test(value) && !key.includes(":"));
  return first ? first[1].trim() : fallback;
}

/** An attribute of a tag's text. */
function attribute(attrs, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(String(attrs ?? ""));
  return found ? decode(found[1]) : "";
}

/** A page's or database's icon, as an emoji; an inline database's icon is not the page's. */
function iconIn(source) {
  const tag = /<(page|database)\b([^>]*)>/i.exec(String(source ?? ""));
  const icon = tag && iconOf(attribute(tag[2], "icon"));
  if (icon) return icon;
  const metadata = /<iconMetadata>\s*(\{[\s\S]*?\})\s*<\/iconMetadata>/i.exec(String(source ?? ""));
  if (metadata) {
    try {
      const value = JSON.parse(metadata[1]);
      if (value?.type === "emoji" && value.emoji) return String(value.emoji);
    } catch {}
  }
  return null;
}

/** The page's or database's URL, from its first tag. */
function urlIn(source) {
  const page = /<page\b([^>]*)>/i.exec(String(source ?? ""));
  if (page) return attribute(page[1], "url");
  const database = /<database\b([^>]*)>/i.exec(String(source ?? ""));
  return database ? attribute(database[1], "url") : "";
}

/** The name of the page or database this one sits under, when the answer says. */
export function parentOf(source) {
  const s = String(source ?? "");
  const dataSource = /<parent-data-source\b[^>]*\bname="([^"]*)"/i.exec(s);
  if (dataSource?.[1]) return decode(dataSource[1]);
  const parent = /<parent-page\b[^>]*\btitle="([^"]*)"/i.exec(s);
  if (parent?.[1]) return decode(parent[1]);
  const ancestor = /<ancestor-2-(?:page|database)\b[^>]*\b(?:title|name)="([^"]*)"/i.exec(s);
  return ancestor?.[1] ? decode(ancestor[1]) : "";
}

/** The database's name: the fetch answer's title line, else its source's name. */
export function databaseTitle(source, sources = []) {
  const named = /The title of this (?:Database|Data Source) is:\s*([^\n<]+)/i.exec(String(source ?? ""));
  if (named?.[1]) return named[1].trim();
  const tag = /<database\b[^>]*>([\s\S]*?)<\/database>/i.exec(String(source ?? ""));
  const inner = tag && stripTags(tag[1]).trim().split("\n")[0].trim();
  return inner || sources[0]?.name || "Untitled database";
}

/** A fetch answer as a page or a database: its title, icon, parent, URL and content or data sources. */
export function viewOf(answer) {
  const source = String(answer?.text ?? "");
  const type = text(answer?.metadata?.type);
  const views = viewsOf(source);
  const boardView = boardViewOf(views);
  const sources = parseSources(source)
    .filter((s) => s.url)
    .map((s) => ({ ...s, shape: shapeOf(s.schema, boardView) }));
  const first = /<(page|database)\b/i.exec(source)?.[1]?.toLowerCase() ?? "";
  if (type === "database" || type === "data_source" || (type !== "page" && first === "database")) {
    return {
      kind: "database",
      title: text(answer?.title) || databaseTitle(source, sources),
      icon: iconIn(source),
      parent: parentOf(source),
      url: text(answer?.url) || urlIn(source),
      sources,
      views,
      boardView,
      markdown: "",
    };
  }
  const content = contentOf(source);
  const blocks = content ? blocksOf(content) : [];
  const title = text(answer?.title) || titleOf(source);
  const properties = pagePropertiesOf(source).filter((p) => !(p.values.length === 1 && p.values[0] === title));
  return {
    kind: "page",
    title,
    icon: iconIn(source),
    parent: parentOf(source),
    url: text(answer?.url) || urlIn(source),
    markdown: content ? markdownOf(blocks.filter((b) => b.kind === "markdown").map((b) => b.text).join("\n\n")) : "",
    blocks,
    properties,
    parentSource: parentSourceOf(source),
    sources: [],
  };
}

/** The data source a page in a database sits in, from its fetch answer. */
export function parentSourceOf(source) {
  const found = /<parent-data-source(?:-schema)?\b[^>]*\burl="(collection:\/\/[0-9a-f-]+)"/i.exec(String(source ?? ""));
  return found ? found[1] : null;
}

/** Notion's content split around the databases it embeds, as Markdown blocks and database blocks in order. */
export function blocksOf(content) {
  const out = [];
  const source = String(content ?? "");
  let last = 0;
  for (const found of source.matchAll(/<database\b([^>]*)>([\s\S]*?)<\/database>/gi)) {
    const attrs = found[1];
    const url = attribute(attrs, "url");
    const dataSource = attribute(attrs, "data-source-url");
    if (!url && !dataSource) continue;
    const before = source.slice(last, found.index);
    if (before.trim()) out.push({ kind: "markdown", text: before });
    out.push({
      kind: "database",
      url: url || null,
      source: dataSource || null,
      title: blockLabel(attrs, found[2], "Database"),
      icon: attribute(attrs, "icon") || null,
    });
    last = found.index + found[0].length;
  }
  const tail = source.slice(last);
  if (tail.trim()) out.push({ kind: "markdown", text: tail });
  return out.length ? out : [{ kind: "markdown", text: source }];
}

/** A page's properties as rows of `{ name, values }`, without the answer's own links and ids. */
export function pagePropertiesOf(source) {
  const props = propertiesOf(source);
  const out = [];
  for (const [name, value] of Object.entries(props)) {
    if (["url", "title", "id", "createdTime"].includes(name) || name.includes(":") || value === null || value === undefined || value === "") continue;
    let values = words(value).filter((v) => v && v !== "[object Object]");
    if (!Array.isArray(value) && typeof value === "object") {
      const one = value?.name ?? value?.title ?? value?.plain_text ?? null;
      values = one ? [String(one)] : [];
    }
    if (values.length) out.push({ name, values });
  }
  return out;
}

/** The body inside a fetch answer's `<content>`. */
export function contentOf(source) {
  const found = /<content>([\s\S]*?)<\/content>/i.exec(String(source ?? ""));
  return found ? found[1] : "";
}

/** A database's board from its view and a rows answer: null without a status or select property. */
export function boardOf(view, answer) {
  const source = (view?.sources ?? []).find((s) => s.shape) ?? null;
  if (!source) return null;
  const rows = Array.isArray(answer) ? answer : Array.isArray(answer?.results) ? answer.results : [];
  const cards = cardsOf(rows, source.shape);
  return {
    source,
    shape: source.shape,
    cards,
    columns: columnsOf(source.shape, cards),
    count: cards.length,
    hasMore: Boolean(answer?.has_more),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Notion's tagged text → Markdown

const ENTITIES = [
  ["&nbsp;", " "],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&amp;", "&"],
];

function decode(value) {
  let out = String(value ?? "");
  for (const [from, to] of ENTITIES) out = out.split(from).join(to);
  out = out.replace(/&#(\d+);/g, (m, n) => {
    const code = Number(n);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
  return out.replace(/&#x([0-9a-f]+);/gi, (m, n) => {
    const code = Number.parseInt(n, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const stripTags = (value) => String(value ?? "").replace(/<[^>]*>/g, "");

/** The text inside a tag, with its inline markup and entities read. */
function inline(value) {
  let out = String(value ?? "");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\s*\/?\s*(?:b|strong)\s*>/gi, "**");
  out = out.replace(/<\s*\/?\s*(?:i|em)\s*>/gi, "*");
  out = out.replace(/<\s*\/?\s*(?:s|strike|del)\s*>/gi, "~~");
  out = out.replace(/<code\b[^>]*>/gi, "`").replace(/<\/code>/gi, "`");
  out = out.replace(/<[^>]+>/g, "");
  return decode(out);
}

/** A Notion link: the label on its URL, and the label alone without one. */
function linkOf(attrs, label, fallback) {
  const url = attribute(attrs, "url");
  const words = inline(label).replace(/\s+/g, " ").trim() || fallback;
  if (!url) return words;
  return `[${words.replace(/([\\\[\]])/g, "\\$1")}](${url})`;
}

/** A page or database block's label, without the data source tags Notion puts inside an inline database. */
function blockLabel(attrs, body, fallback) {
  const named = attribute(attrs, "title");
  if (named) return named;
  const plain = String(body ?? "")
    .replace(/<data-source\b[\s\S]*?<\/data-source>/gi, "")
    .replace(/<data-source-state>[\s\S]*?<\/data-source-state>/gi, "");
  return inline(plain).split("\n").map((line) => line.trim()).filter(Boolean)[0] || fallback;
}

/** An HTML table as bullets, one per row: the header's cells label them when the table has a header row. */
function tableOf(attrs, body) {
  const rows = [...String(body ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => inline(cell[1]).replace(/\s+/g, " ").trim()),
  );
  if (!rows.length) return "";
  const header = /header-row\s*=\s*"true"/i.test(attrs) ? rows.shift() : null;
  if (!rows.length && header) {
    const cells = header.map((cell) => cell.replace(/[*_~`]/g, "").trim()).filter(Boolean);
    return cells.length ? `\n\n- ${cells.join(" · ")}\n\n` : "";
  }
  const lines = rows
    .map((cells) => {
      const parts = cells
        .map((cell, i) => {
          const head = (header?.[i] ?? "").replace(/[*_~`]/g, "").trim();
          if (!cell) return head ? `**${head}:**` : "";
          return head ? `**${head}:** ${cell}` : cell;
        })
        .filter(Boolean);
      return parts.length ? `- ${parts.join(" · ")}` : "";
    })
    .filter(Boolean);
  return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
}

/** A callout as a blockquote, every line quoted. */
const quoteOf = (body) =>
  String(body ?? "")
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

/** Notion's content as Markdown: headings, lists, code and quotes as they arrive, its tags turned into Markdown. */
export function markdownOf(source) {
  let out = String(source ?? "");
  out = out.replace(/<image\b[^>]*\/?>/gi, "\n\n_[image]_\n\n");
  out = out.replace(/<unknown\b[^>]*\/?>/gi, "");
  out = out.replace(/<empty-block\s*\/?>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<callout\b([^>]*)>([\s\S]*?)<\/callout>/gi, (_m, _attrs, inner) => `\n\n${quoteOf(markdownOf(inner))}\n\n`);
  out = out.replace(/<page\b([^>]*)\/>/gi, (_m, attrs) => linkOf(attrs, "", "Page"));
  out = out.replace(/<database\b([^>]*)\/>/gi, (_m, attrs) => linkOf(attrs, "", "Database"));
  out = out.replace(/<page\b([^>]*)>([\s\S]*?)<\/page>/gi, (_m, attrs, inner) => `\n\n${linkOf(attrs, inner, "Page")}\n\n`);
  out = out.replace(/<database\b([^>]*)>([\s\S]*?)<\/database>/gi, (_m, attrs, inner) => `\n\n${linkOf(attrs, blockLabel(attrs, inner, "Database"), "Database")}\n\n`);
  out = out.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (_m, attrs, inner) => tableOf(attrs, inner));
  out = out.replace(/<\s*\/?\s*columns?\b[^>]*>/gi, "\n\n");
  out = out.replace(/<p\b[^>]*\/>/gi, "\n\n").replace(/<p\b[^>]*>/gi, "\n\n").replace(/<\/p>/gi, "\n\n");
  out = out.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m, i) => `${i + 1}. ${inline(m[1]).trim()}`).filter((line) => !/^\d+\.\s*$/.test(line));
    return items.length ? `\n${items.join("\n")}\n` : "";
  });
  out = out.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "").replace(/<\s*\/?\s*ul\b[^>]*>/gi, "\n\n");
  out = inline(out);
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
