// The Notion screen's data: what it asks Notion's MCP server, and the pages, lists and boards it makes of each answer.
// Fixtures are the acme world; these tests read no Notion.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SERVER, LIMITS, callArgs, loginArgs, listArgs, searchArgs, fetchArgs, rowsArgs, parseAnswer, errorOf,
  listItems, propertiesOf, titleOf, parentOf, databaseTitle, viewOf, contentOf, boardOf, markdownOf, plainMark,
  viewsOf, boardViewOf, blocksOf, pagePropertiesOf, parentSourceOf, pinnedItems, pinItem, pinCurrent,
  doneColumn, openColumn, shownColumns, withCards, withDone, moveInBoard,
} from "../mods/flow/notion-data.js";
import { moveArgs, createArgs, shapeOf } from "../mods/flow/board-data.js";

const PAGE = "https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHILD = "https://app.notion.com/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DB = "https://app.notion.com/p/cccccccccccccccccccccccccccccccc";
const SOURCE = "collection://11111111-1111-1111-1111-111111111111";

const SCHEMA = {
  name: "Acme Tasks",
  schema: {
    Task: { name: "Task", type: "title" },
    Status: {
      name: "Status",
      type: "status",
      groups: {
        to_do: [{ name: "Backlog", color: "gray" }],
        in_progress: [{ name: "Doing", color: "blue" }],
        complete: [{ name: "Done", color: "green" }],
      },
    },
    Priority: { name: "Priority", type: "select", options: [{ name: "High", color: "red" }] },
    Tags: { name: "Tags", type: "multi_select", options: [{ name: "bug", color: "orange" }] },
  },
};

const DATABASE = `Here is the result of "fetch" for the Page with URL ${DB} as of 2026-11-27T12:00:00.000Z:
<database url="${DB}" inline="true" icon="🗂️">
The title of this Database is: 🗂️ Acme Tasks
<data-sources>
<data-source url="{{${SOURCE}}}">
The title of this Data Source is: Acme Tasks
<data-source-state>
${JSON.stringify(SCHEMA)}
</data-source-state>
</data-source>
</data-sources>
</database>`;

const PAGE_FETCH = `Here is the result of "fetch" for the Page with URL ${PAGE} as of 2026-11-27T12:00:00.000Z:
<page url="${PAGE}" icon="📄">
<ancestor-path>
<parent-page url="${DB}" title="Acme" />
</ancestor-path>
<properties>
{"title":"Acme plan"}
</properties>
<iconMetadata>{"type":"emoji","emoji":"📄"}</iconMetadata>
<content>
<callout icon="💡" color="gray_bg">
Read **this** first
</callout>

# Plan

Some <b>bold</b> text &amp; more.<br />A line.

- one
- two

<page url="${CHILD}">
<b>Runbook</b>
</page>

<table header-row="true">
<colgroup><col width="10" /></colgroup>
<tr><td><b>Owner</b></td><td>Who</td></tr>
<tr><td>Maya</td><td>Sam</td></tr>
</table>

<image source="notion-file-block://acme" />

<unknown url="${PAGE}#alias" alt="alias" />
</content>
</page>`;

test("the calls the screen makes", () => {
  assert.deepEqual(callArgs("notion-search", { query: "plan" }), ["connector", "call", SERVER, "notion-search", '{"query":"plan"}']);
  assert.deepEqual(loginArgs, ["connector", "login", SERVER]);
  assert.deepEqual(listArgs(), { limit: LIMITS.recent });
  assert.deepEqual(listArgs(3), { limit: 3 });
  assert.deepEqual(searchArgs("  plan  "), { query: "plan", page_size: LIMITS.search });
  assert.deepEqual(fetchArgs(PAGE), { id: PAGE });
  assert.equal(SERVER, "https://mcp.notion.com/mcp");
});

test("an answer must be JSON", () => {
  assert.deepEqual(parseAnswer('{"results":[]}'), { results: [] });
  assert.deepEqual(parseAnswer(""), {});
  assert.throws(() => parseAnswer("cockpit: no"), /not JSON/);
});

test("a browse answer becomes rows, an uploaded icon becoming none", () => {
  const answer = {
    results: [
      { title: "Acme plan", type: "page", url: PAGE, icon: "📄", path: "Acme / Docs" },
      { title: "Acme Tasks", type: "database", url: DB, icon: "attachment:acme:icon.png" },
      { title: "Acme plan again", type: "page", url: PAGE },
    ],
  };
  assert.deepEqual(
    listItems(answer).map((i) => [i.title, i.type, i.icon, i.path]),
    [
      ["Acme plan", "page", "📄", "Acme / Docs"],
      ["Acme Tasks", "database", null, ""],
    ],
  );
  assert.equal(listItems({ results: [{ title: "", url: CHILD }] })[0].title, "(untitled)");
  assert.deepEqual(listItems({}), []);
});

test("a search highlight is plain words", () => {
  assert.equal(plainMark("The **roadmap** is `here`"), "The roadmap is here");
});

test("a page's properties, title and parent read from the fetch answer", () => {
  assert.equal(titleOf(PAGE_FETCH), "Acme plan");
  assert.equal(titleOf(`<properties>{"Name":"A row"}</properties>`), "A row");
  assert.equal(titleOf(`<properties>{"url":"https://acme.example","userDefined:ID":4}</properties>`), "Untitled");
  assert.deepEqual(propertiesOf(`<properties>{"title":"T"}</properties>`), { title: "T" });
  assert.deepEqual(propertiesOf(`<properties>not json</properties>`), {});
  assert.equal(parentOf(PAGE_FETCH), "Acme");
  assert.equal(databaseTitle(DATABASE), "🗂️ Acme Tasks");
});

test("a fetched page becomes Markdown, its tags and tables read", () => {
  const view = viewOf({ metadata: { type: "page" }, text: PAGE_FETCH });
  assert.equal(view.kind, "page");
  assert.equal(view.title, "Acme plan");
  assert.equal(view.icon, "📄");
  assert.equal(view.parent, "Acme");
  assert.equal(view.url, PAGE);
  assert.match(view.markdown, /> Read \*\*this\*\* first/);
  assert.match(view.markdown, /^# Plan$/m);
  assert.match(view.markdown, /Some \*\*bold\*\* text & more\./);
  assert.match(view.markdown, /A line\./);
  assert.match(view.markdown, /- one\n- two/);
  assert.ok(view.markdown.includes(`[**Runbook**](${CHILD})`), view.markdown);
  assert.match(view.markdown, /- \*\*Owner:\*\* Maya · \*\*Who:\*\* Sam/);
  assert.ok(view.markdown.includes("_[image]_"));
  assert.ok(!view.markdown.includes("<unknown"));
  assert.ok(!view.markdown.includes("<table"));
  assert.ok(!view.markdown.includes("&#"));
});

test("a fetched database becomes sources with a board shape", () => {
  const view = viewOf({ metadata: { type: "database" }, text: DATABASE });
  assert.equal(view.kind, "database");
  assert.equal(view.title, "🗂️ Acme Tasks");
  assert.equal(view.icon, "🗂️");
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0].url, SOURCE);
  assert.equal(view.sources[0].name, "Acme Tasks");
  assert.deepEqual(view.sources[0].shape.columns.map((c) => [c.name, c.done]), [["Backlog", false], ["Doing", false], ["Done", true]]);

  const args = rowsArgs(view.sources[0].url, view.sources[0].shape, false);
  assert.equal(args.data.mode, "rows");
  assert.equal(args.data.data_source_url, SOURCE);
  assert.equal(args.data.filter.operator, "and");
  assert.deepEqual(args.data.filter.filters[0].value, { type: "is_option", value: "Done" });

  const rows = {
    results: [
      { Task: "Ship it", Status: "Doing", Priority: "High", Tags: '["bug"]', url: PAGE },
      { Task: "Loose", Status: "Something else", url: CHILD },
    ],
    has_more: false,
  };
  const board = boardOf(view, rows);
  assert.equal(board.count, 2);
  assert.deepEqual(board.columns.map((c) => [c.name, c.cards.length]), [["No status", 1], ["Backlog", 0], ["Doing", 1], ["Done", 0]]);
  assert.equal(board.cards[0].title, "Ship it");
  assert.deepEqual(board.cards[0].fields.map((f) => [f.name, f.values]), [["Priority", ["High"]], ["Tags", ["bug"]]]);
  assert.equal(board.cards[0].fields[0].colors.High, "red");
});

test("a data source opened on its own still becomes a board", () => {
  const state = { ...SCHEMA, url: SOURCE };
  const text = `<data-source url="{{${SOURCE}}}"><data-source-state>${JSON.stringify(state)}</data-source-state></data-source>`;
  const view = viewOf({ metadata: { type: "data_source" }, title: "Acme Tasks", text });
  assert.equal(view.kind, "database");
  assert.equal(view.title, "Acme Tasks");
  assert.equal(view.sources[0].url, SOURCE);
  assert.deepEqual(view.sources[0].shape.columns.map((c) => c.name), ["Backlog", "Doing", "Done"]);
});

test("a database without a status or select property has no board", () => {
  const schema = { name: "Notes", schema: { Name: { name: "Name", type: "title" }, Body: { name: "Body", type: "rich_text" } } };
  const text = `<database url="${DB}"><data-source url="{{${SOURCE}}}"><data-source-state>${JSON.stringify(schema)}</data-source-state></data-source></database>`;
  const view = viewOf({ metadata: { type: "database" }, text });
  assert.equal(view.sources[0].shape, null);
  assert.equal(boardOf(view, { results: [] }), null);
});

test("a failed call says whether signing in again is the fix", () => {
  assert.equal(errorOf({ code: 1, stderr: "connector login required for https://mcp.notion.com/mcp" }).login, true);
  assert.equal(errorOf({ code: 1, stderr: "Notion: not signed in" }).login, true);
  assert.equal(errorOf({ code: 1, stderr: "the remote cockpit client is read-only" }).remote, true);
  assert.equal(errorOf({ code: 1, stderr: "object_not_found: no such page" }).login, false);
  assert.match(errorOf({ code: 1, stderr: "" }).message, /did not answer/);
});

test("the content is the body under its page, not the answer's preamble", () => {
  assert.equal(contentOf(PAGE_FETCH).startsWith("\n<callout"), true);
  assert.equal(markdownOf("<p>One</p><p>Two</p>"), "One\n\nTwo");
  assert.equal(markdownOf("<ul><li>One</li><li>Two</li></ul>"), "- One\n- Two");
  assert.equal(markdownOf("<callout>One<br />Two</callout>"), "> One\n> Two");
});

test("the answer's own title and URL come before the properties", () => {
  const text = `<page url="${PAGE}"><properties>{"Status":"Doing","Task":"Ship it"}</properties><content># Ship it</content></page>`;
  const named = viewOf({ title: "Ship it", url: CHILD, metadata: { type: "page" }, text });
  assert.equal(named.title, "Ship it");
  assert.equal(named.url, CHILD);
  const fallback = viewOf({ metadata: { type: "page" }, text });
  assert.equal(fallback.title, "Doing");
  assert.equal(fallback.url, PAGE);
});

test("icons and titles that arrive as objects stay readable", () => {
  const [item] = listItems({ results: [{ title: "D", url: PAGE, icon: { type: "emoji", emoji: "X" } }] });
  assert.equal(item.icon, "X");
  const [none] = listItems({ results: [{ title: { plain_text: "D" }, url: CHILD }] });
  assert.equal(none.title, "(untitled)");
});

test("an id-only list item still has a key and a target", () => {
  const [item] = listItems([{ id: "123", title: "By id", type: "data_source" }]);
  assert.equal(item.key, "123");
  assert.equal(item.url, null);
  assert.equal(item.type, "database");
});

test("markdown reads self-closing mentions, inline databases, ordered lists and header-only tables", () => {
  const source = `See <page url="${CHILD}" /> now.

<database url="${DB}"><data-source url="{{${SOURCE}}}"><data-source-state>${JSON.stringify(SCHEMA)}</data-source-state></data-source>
Acme Tasks
</database>

<ol><li>One</li><li>Two</li></ol>

<table header-row="true"><tr><td><b>Owner</b></td><td><b>Who</b></td></tr></table>`;
  const md = markdownOf(source);
  assert.ok(md.includes(`See [Page](${CHILD}) now.`), md);
  assert.ok(md.includes(`[Acme Tasks](${DB})`), md);
  assert.ok(!md.includes("<data-source"), md);
  assert.match(md, /1\. One\n2\. Two/);
  assert.match(md, /- Owner · Who/);
});

test("entities decode safely, decimal and hex", () => {
  assert.equal(markdownOf("Tom &#x27;n&#39; Jerry"), "Tom 'n' Jerry");
  assert.equal(markdownOf("&#1114112;"), "&#1114112;");
});

test("a board reports more rows, and a shape without a done column has no filter", () => {
  const view = viewOf({ metadata: { type: "database" }, text: DATABASE });
  const board = boardOf(view, { results: [], has_more: true });
  assert.equal(board.hasMore, true);
  assert.equal(board.count, 0);
  const schema = { name: "Notes", schema: { Name: { name: "Name", type: "title" }, Kind: { name: "Kind", type: "select", options: [{ name: "Idea" }] } } };
  const text = `<database url="${DB}"><data-source url="{{${SOURCE}}}"><data-source-state>${JSON.stringify(schema)}</data-source-state></data-source></database>`;
  const plain = viewOf({ metadata: { type: "database" }, text });
  assert.equal(rowsArgs(plain.sources[0].url, plain.sources[0].shape, false).data.filter, undefined);
  assert.equal(rowsArgs(plain.sources[0].url, plain.sources[0].shape, true), null);
});

test("a stored login that cannot be read says so", () => {
  const found = errorOf({ code: 1, stderr: "stored login unreadable: non-ASCII" });
  assert.equal(found.login, true);
  assert.equal(found.unreadable, true);
  assert.match(found.message, /saved Notion login/);
  assert.match(errorOf({ code: 1, stdout: "notion-search: Mcp error: boom" }).message, /boom/);
});

test("the parser only takes objects, never null or a number", () => {
  assert.deepEqual(parseAnswer("null"), {});
  assert.deepEqual(parseAnswer("42"), {});
  assert.deepEqual(parseAnswer("[]"), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Boards as Notion itself draws them

const VIEW = (value) => `<view url="{{view://v1}}">${JSON.stringify(value)}</view>`;
const KANBAN = {
  name: "Kanban",
  type: "board",
  groupBy: { property: "Status", propertyType: "status", sort: { type: "ascending" } },
  displayProperties: ["Task", "Tags", "Priority"],
  cardSize: "medium",
};

const DATABASE_VIEWS = DATABASE.replace("</database>", `<views>${VIEW(KANBAN)}${VIEW({ name: "All tasks", type: "table" })}</views>\n</database>`);

test("a database's own board view sets its columns and the properties its cards show", () => {
  const views = viewsOf(DATABASE_VIEWS);
  assert.deepEqual(views.map((v) => [v.name, v.type, v.cardSize]), [["Kanban", "board", "medium"], ["All tasks", "table", null]]);
  assert.equal(boardViewOf(views).groupBy.property, "Status");
  assert.equal(boardViewOf(viewsOf(DATABASE)), null);

  const view = viewOf({ metadata: { type: "database" }, text: DATABASE_VIEWS });
  assert.equal(view.boardView.name, "Kanban");
  assert.deepEqual(view.sources[0].shape.extras.map((x) => x.name), ["Tags", "Priority"]);
  assert.equal(view.sources[0].shape.view.name, "Kanban");

  const byPriority = shapeOf(SCHEMA.schema, { ...KANBAN, groupBy: { property: "Priority", sort: { type: "descending" } } });
  assert.equal(byPriority.by, "Priority");
  assert.deepEqual(byPriority.columns.map((c) => c.name), ["High"]);
  assert.deepEqual(shapeOf(SCHEMA.schema, { ...KANBAN, displayProperties: ["Task"] }).extras, []);
});

test("a page's content keeps the databases it embeds, in place", () => {
  const text = `Here is the result of "fetch":
<page url="${PAGE}" icon="📄">
<properties>{"Task":"Acme plan","Status":"Doing","Tags":["bug"],"Branch":"acme/plan","url":"${PAGE}"}</properties>
<content>
<p>Before the board.</p>
<database url="${DB}" data-source-url="${SOURCE}" inline="true" icon="🗂️">
Acme Tasks
</database>
<p>After the board.</p>
</content>
</page>`;
  const view = viewOf({ metadata: { type: "page" }, text });
  assert.deepEqual(view.blocks.map((b) => b.kind), ["markdown", "database", "markdown"]);
  assert.equal(view.blocks[1].title, "Acme Tasks");
  assert.equal(view.blocks[1].url, DB);
  assert.equal(view.blocks[1].source, SOURCE);
  assert.equal(view.blocks[1].icon, "🗂️");
  assert.doesNotMatch(view.markdown, /Acme Tasks\]\(/);
  assert.match(view.markdown, /Before the board\./);
  assert.match(view.markdown, /After the board\./);
  assert.deepEqual(view.properties.map((p) => [p.name, p.values]), [
    ["Status", ["Doing"]],
    ["Tags", ["bug"]],
    ["Branch", ["acme/plan"]],
  ]);
  assert.deepEqual(pagePropertiesOf(`<properties>{"url":"${PAGE}","title":"T","x:y":1}</properties>`), []);
  assert.deepEqual(blocksOf("just words"), [{ kind: "markdown", text: "just words" }]);
  assert.equal(parentSourceOf(`<parent-data-source url="${SOURCE}" name="Acme Tasks"/>`), SOURCE);
  assert.equal(parentSourceOf(`<parent-data-source-schema url="${SOURCE}">`), SOURCE);
  assert.equal(parentSourceOf("<page></page>"), null);
});

test("pinned boards keep the one the screen opens, and unpinning it forgets it", () => {
  const page = { key: PAGE, url: PAGE, title: "Acme plan", icon: "📄", type: "page" };
  const database = { key: DB, url: DB, title: "Acme Tasks", icon: "🗂️", type: "database" };
  let config = pinItem(undefined, page, true);
  config = pinCurrent(config, PAGE);
  assert.deepEqual(pinnedItems(config).map((b) => [b.title, b.type]), [["Acme plan", "page"]]);
  assert.equal(config.current, PAGE);

  config = pinItem(config, database, true);
  config = pinCurrent(config, DB);
  assert.deepEqual(pinnedItems(config).map((b) => b.title), ["Acme plan", "Acme Tasks"]);
  assert.equal(config.current, DB);
  assert.equal(pinnedItems(config)[1].key, DB);

  config = pinItem(config, database, false);
  assert.deepEqual(pinnedItems(config).map((b) => b.title), ["Acme plan"]);
  assert.equal(config.current, null);
  assert.deepEqual(pinnedItems({ boards: [{ url: "not a url", title: "No" }, { url: PAGE, title: "Yes" }, { url: PAGE, title: "Again" }] }).map((b) => b.title), ["Yes"]);
});

test("moving a card redraws its columns before Notion answers, and can undo the move", () => {
  const view = viewOf({ metadata: { type: "database" }, text: DATABASE });
  const board = boardOf(view, { results: [{ Task: "Ship it", Status: "Doing", Priority: "High", url: PAGE }] });
  const shape = view.sources[0].shape;
  assert.equal(doneColumn(shape), "Done");
  assert.equal(openColumn(shape), "Backlog");
  assert.deepEqual(shownColumns(board, false).map((c) => c.name), ["Backlog", "Doing"]);
  assert.deepEqual(shownColumns(board, true).map((c) => c.name), ["Backlog", "Doing", "Done"]);

  const done = moveInBoard(board, board.cards[0].id, "Done");
  assert.equal(done.cards.length, 0);
  assert.equal(done.doneCards.length, 1);
  assert.equal(done.doneCards[0].status, "Done");
  assert.equal(done.doneCount, 1);
  assert.deepEqual(shownColumns(done, true).find((c) => c.name === "Done").cards.map((c) => c.title), ["Ship it"]);

  const reopened = moveInBoard(done, done.doneCards[0].id, "Backlog");
  assert.equal(reopened.cards.length, 1);
  assert.equal(reopened.cards[0].status, "Backlog");
  assert.equal(reopened.doneCards.length, 0);

  const cards = withCards(board, []).cards;
  assert.equal(cards.length, 0);
  assert.equal(withDone(board, board.cards).doneCount, 1);
});

test("the calls that move and create cards name the page, the source and the column", () => {
  const view = viewOf({ metadata: { type: "database" }, text: DATABASE });
  const shape = view.sources[0].shape;
  const card = { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", url: CHILD, title: "Ship it" };
  assert.deepEqual(moveArgs(card, shape, "Done"), {
    page_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    command: "update_properties",
    properties: { Status: "Done" },
    allow_async: false,
  });
  assert.deepEqual(createArgs(SOURCE, shape, "Ship it", "Doing"), {
    parent: { type: "data_source_id", data_source_id: "11111111-1111-1111-1111-111111111111" },
    pages: [{ properties: { Task: "Ship it", Status: "Doing" } }],
    allow_async: false,
  });
});
