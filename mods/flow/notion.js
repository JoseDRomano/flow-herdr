// The Notion screen: the person's pages, search results and their kanban boards, read and moved through Notion's hosted
// MCP server with cockpit's connector. It draws a page's own inline databases as boards, and moves or adds cards; pages
// themselves stay read-only here. Keys: j k to move, ⏎ to open in Notion, / to search, p to pin, r to read again.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { settings, shared, setShared } from "herdr";
import * as hub from "./hub.js";
import { colorOf, moveArgs, createArgs, parseSources, shapeOf, FRESH_MS, CONFIG } from "./board-data.js";
import { take } from "./person.js";
import {
  LIMITS, callArgs, loginArgs, listArgs, searchArgs, fetchArgs, rowsArgs, parseAnswer, errorOf,
  listItems, viewOf, boardOf, pinnedItems, pinItem, pinCurrent, doneColumn, openColumn,
  shownColumns, withCards, withDone, moveInBoard, markdownOf,
} from "./notion-data.js";
import {
  tokens, TEXT, RADIUS, Icon, Badge, Button, Chip, ListRow, PageHeader, SearchField, KeyHints, Empty, ErrorState,
  Skeleton, Markdown, Scroller, Hover, Spinner, SectionHeader, TextField, Toaster, openMenu, alpha, dur,
} from "./ui.js";

/** The colour a card's Notion option is drawn in. */
const optionColor = (name) => (name ? colorOf(name) : null);

export default class Notion {
  init(_p, cx) {
    this.me = null;
    this.lists = { favorites: [], recent: [], search: [] };
    this.activeQuery = "";
    this.searchError = null;
    this.searchLoading = false;
    this.searching = false;
    this.status = "loading";
    this.error = null;
    this.signing = false;
    this.signError = null;
    this.selected = null;
    this.shown = null;
    this.detail = null;
    this.back = null;
    this.loading = false;
    this.readAt = 0;
    this.listGen = 0;
    this.detailGen = 0;
    this.searchGen = 0;
    this.width = 1200;
    this.visible = true;
    this.hover = new Hover();
    this.scroller = new Scroller();
    this.toasts = new Toaster();
    this.handle = cx.focus_handle();
    const config = shared(CONFIG);
    this.pins = pinnedItems(config);
    this.currentPin = typeof config?.current === "string" ? config.current : null;
    this.boardUI = new Map();
    this.shapes = new Map();
    this.drag = null;
    this.dragMoved = false;
    this.adding = null;
    this.creating = null;
    this.busy = null;
    this.pageShape = null;

    this.query = InputState.new({ placeholder: "Search Notion…" });
    this.query.on("change", (_e, cx) => {
      if (!this.query.value().trim()) {
        this.activeQuery = "";
        this.lists.search = [];
        this.searchError = null;
        this.searchGen += 1;
        this.searchLoading = false;
      }
      cx.notify();
    });
    this.query.on("submit", (_e, cx) => this.submitSearch(cx));
    this.query.on("blur", (_e, cx) => {
      if (this.searching) {
        this.searching = false;
        cx.notify();
      }
    });

    this.newTask = InputState.new({ placeholder: "New task…" });
    this.newTask.on("submit", (_e, cx) => this.createTask(cx));

    this.reload(cx);
  }

  /** The window's clock: the header's age catches up, and the board on screen is read again after a minute. */
  tick(cx, now) {
    if (!this.visible) return;
    if (this.readAt && (!this.tickAt || now - this.tickAt > 60_000)) {
      this.tickAt = now;
      cx.notify();
    }
    const board = this.detail?.board;
    if (board && this.status === "live" && !this.busy && !this.adding && !this.drag && now - (board.at ?? 0) > FRESH_MS) this.refreshBoard(board, cx);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reading

  /** One call to Notion's MCP server, its answer as an object; a failed call throws its reason. */
  async call(tool, args = {}) {
    let r;
    try {
      r = await hub.cockpit(callArgs(tool, args), { timeout: 90_000 });
    } catch (e) {
      const message = String(e?.message ?? e);
      const remote = /read-only|remote cockpit|another machine/i.test(message);
      const error = new Error(remote ? "This window shows a cockpit on another machine: connect Notion there." : message);
      error.remote = remote;
      throw error;
    }
    if (!r || r.code !== 0) {
      const found = errorOf(r);
      const error = new Error(found.message);
      error.login = Boolean(found.login);
      error.remote = Boolean(found.remote);
      throw error;
    }
    return parseAnswer(r.stdout, tool);
  }

  /** Reads who the person is, their favourites and their recent pages; keeps what is shown when it can. */
  reload(cx) {
    if (this.loading) return;
    const config = shared(CONFIG);
    this.pins = pinnedItems(config);
    this.currentPin = typeof config?.current === "string" ? config.current : null;
    this.loading = true;
    if (this.status !== "live") this.status = "loading";
    const gen = ++this.listGen;
    const shown = this.shown;
    const back = this.back;
    const selected = this.selected;
    const intent = this.detailGen;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [me, favorites, recent] = await Promise.all([
          this.call("notion-get-self").catch((e) => {
            if (e?.login || e?.remote) throw e;
            return null;
          }),
          this.call("notion-list-favorite-pages", listArgs(LIMITS.favorites)).catch(() => null),
          this.call("notion-list-recent-pages", listArgs(LIMITS.recent)).catch(() => null),
        ]);
        if (gen !== this.listGen) return;
        this.me = me;
        this.lists.favorites = favorites ? listItems(favorites) : this.lists.favorites;
        this.lists.recent = recent ? listItems(recent) : this.lists.recent;
        this.status = "live";
        this.error = null;
        this.readAt = Date.now();
        if (this.activeQuery) {
          this.submitSearch(cx);
          return;
        }
        if (this.detailGen !== intent) return;
        if (shown) {
          if (this.shown !== shown) return;
          const kept = selected && this.items().some((i) => i.key === selected.key) ? selected : null;
          this.select(shown, cx, { back, keep: kept });
        } else {
          const preferred = this.preferredItem();
          if (preferred) this.select(preferred, cx);
        }
      } catch (e) {
        if (gen !== this.listGen) return;
        if (e?.login) {
          this.status = "login";
          this.me = null;
        } else {
          this.status = "error";
          this.error = String(e?.message ?? e);
        }
      } finally {
        this.loading = false;
        if (gen === this.listGen) cx.notify();
      }
    });
  }

  /** Reads one page or database, a database's open cards, and the boards a page embeds. */
  select(item, cx, { back = null, keep = null, shape = null } = {}) {
    const target = item?.url || item?.id;
    if (!target) return;
    this.selected = keep ?? item;
    this.shown = item;
    this.back = back;
    this.pageShape = shape;
    this.adding = null;
    this.drag = null;
    this.remember(item);
    this.detail = { kind: "loading", title: item.title, icon: item.icon, url: item.url ?? null, parent: item.path ?? "" };
    const gen = ++this.detailGen;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const answer = await this.call("notion-fetch", fetchArgs(target));
        if (gen !== this.detailGen) return;
        const view = viewOf(answer);
        if (item.title && item.title !== "(untitled)") view.title = item.title;
        view.url = view.url || item.url || null;
        view.icon = view.icon || item.icon || null;
        view.parent = view.parent || item.path || "";
        view.at = Date.now();
        view.board = null;
        if (view.kind === "database") {
          const source = view.sources.find((s) => s.shape) ?? null;
          if (source) {
            const rows = await this.call("notion-query-data-sources", rowsArgs(source.url, source.shape, false));
            if (gen !== this.detailGen) return;
            const board = boardOf(view, rows);
            if (board) view.board = this.named(board, view, source);
          }
        } else {
          view.shape = shape ?? this.shapes.get(view.parentSource) ?? null;
          for (const block of view.blocks ?? []) {
            if (block.kind !== "database") continue;
            block.loading = true;
            block.board = null;
            block.error = null;
          }
        }
        this.detail = view;
        cx.notify();
        const embedded = (view.blocks ?? []).filter((b) => b.kind === "database");
        await Promise.all([...embedded.map((block) => this.loadInline(block, view, gen, cx)), this.loadPageShape(view, gen, cx)]);
      } catch (e) {
        if (gen !== this.detailGen) return;
        this.detail = { kind: "error", title: item.title, icon: item.icon, url: item.url ?? null, message: String(e?.message ?? e), login: Boolean(e?.login), remote: Boolean(e?.remote) };
        cx.notify();
      }
    });
  }

  /** A board named after the database it belongs to, and keyed by the data source it reads. */
  named(board, view, source) {
    if (source.shape) this.shapes.set(source.url, source.shape);
    return { ...board, key: source.url, title: view.title ?? source.name ?? "Database", icon: view.icon ?? null, url: view.url ?? null, view: source.shape?.view ?? null, at: Date.now() };
  }

  /** Reads the board a page embeds, in place, and draws it when it lands. */
  async loadInline(block, view, gen, cx) {
    try {
      const target = block.url || block.source;
      const answer = await this.call("notion-fetch", fetchArgs(target));
      if (gen !== this.detailGen) return;
      const fetched = viewOf(answer);
      const parsed = fetched.sources.length
        ? fetched.sources
        : parseSources(String(answer?.text ?? "")).map((s) => ({ ...s, shape: shapeOf(s.schema) }));
      const source = parsed.find((s) => s.shape) ?? null;
      if (!source) {
        block.loading = false;
        block.error = "This database has no status or select property Flow can group into columns.";
        cx.notify();
        return;
      }
      const rows = await this.call("notion-query-data-sources", rowsArgs(source.url, source.shape, false));
      if (gen !== this.detailGen) return;
      const board = boardOf({ sources: [source] }, rows);
      if (!board) {
        block.loading = false;
        block.error = "This database has no board view.";
        cx.notify();
        return;
      }
      const title = block.title && block.title !== "Database" ? block.title : fetched.title;
      block.board = this.named(board, { ...fetched, title, icon: block.icon || fetched.icon, url: block.url || fetched.url }, source);
      block.loading = false;
      block.error = null;
      const ui = this.uiOf(block.board);
      if (ui.showDone) await this.readDone(block.board, ui, cx, gen);
    } catch (e) {
      if (gen !== this.detailGen) return;
      block.loading = false;
      block.error = String(e?.message ?? e);
    }
    cx.notify();
  }

  /** Reads the schema of the database a page sits in, so its property chips wear the same colours as its board. */
  async loadPageShape(view, gen, cx) {
    const source = view?.parentSource;
    if (!source || view.shape) return;
    const known = this.shapes.get(source);
    if (known) {
      view.shape = known;
      return;
    }
    try {
      const answer = await this.call("notion-fetch", fetchArgs(source));
      if (gen !== this.detailGen) return;
      const found = parseSources(String(answer?.text ?? "")).find((s) => s.schema);
      const shape = found ? shapeOf(found.schema) : null;
      if (!shape) return;
      this.shapes.set(source, shape);
      view.shape = shape;
      if (this.detail === view) cx.notify();
    } catch {
      // A page reads fine without its board's colours.
    }
  }

  /** Reads a board's done cards, for the columns a person chose to show. */
  async readDone(board, ui, cx, gen = this.detailGen) {
    if (ui.doneLoading) return;
    const shape = board.shape;
    if (!doneColumn(shape)) return;
    ui.doneLoading = true;
    ui.doneError = null;
    cx.notify();
    try {
      const answer = await this.call("notion-query-data-sources", rowsArgs(board.source.url, shape, true));
      if (gen !== this.detailGen || !ui.showDone) {
        ui.doneLoading = false;
        return;
      }
      const done = boardOf({ sources: [board.source] }, answer);
      if (done) Object.assign(board, withDone(board, done.cards));
      ui.doneLoading = false;
    } catch (e) {
      ui.doneLoading = false;
      if (gen !== this.detailGen) return;
      ui.doneError = String(e?.message ?? e);
    }
    cx.notify();
  }

  /** Reads a board's open cards again, and its done ones when they show, keeping the cards on screen meanwhile. */
  async refreshBoard(board, cx, gen = this.detailGen) {
    if (!board || this.busy?.source === board.key) return;
    const ui = this.uiOf(board);
    if (this.busy) return;
    this.busy = { source: board.key };
    board.at = Date.now();
    cx.notify();
    try {
      const answers = await Promise.all([
        this.call("notion-query-data-sources", rowsArgs(board.source.url, board.shape, false)),
        ui.showDone && doneColumn(board.shape) ? this.call("notion-query-data-sources", rowsArgs(board.source.url, board.shape, true)) : null,
      ]);
      if (gen !== this.detailGen) return;
      const fresh = boardOf({ sources: [board.source] }, answers[0]);
      if (fresh) {
        Object.assign(board, withCards(board, fresh.cards), { hasMore: fresh.hasMore });
        if (answers[1]) {
          const done = boardOf({ sources: [board.source] }, answers[1]);
          if (done) Object.assign(board, withDone(board, done.cards));
        } else if (!ui.showDone) {
          board.doneCards = undefined;
          board.doneCount = 0;
        }
        board.at = Date.now();
      }
      ui.doneError = null;
    } catch (e) {
      this.toasts.push(cx, "Could not read the board again", { kind: "error", description: String(e?.message ?? e) });
    } finally {
      this.busy = null;
      if (gen === this.detailGen) cx.notify();
    }
  }

  /** The recent pages a favourite does not already list. */
  recentRows() {
    const favorites = new Set(this.lists.favorites.map((i) => i.key));
    return this.lists.recent.filter((i) => !favorites.has(i.key));
  }

  /** The recent pages and favourites a pin does not already list. */
  unpinned(rows) {
    const pinned = new Set(this.pins.map((i) => i.key));
    return rows.filter((i) => !pinned.has(i.key));
  }

  /** The item the screen opens when it has shown nothing else: the pinned board, with a favourite as its fallback. */
  preferredItem() {
    const all = this.items();
    return all.find((i) => i.key === this.currentPin) ?? this.pins[0] ?? all[0] ?? null;
  }

  /** The cards the list shows: search results while a search is up, else pins and favourites and recent pages. */
  items() {
    return this.activeQuery ? this.lists.search : [...this.pins, ...this.unpinned(this.lists.favorites), ...this.unpinned(this.recentRows())];
  }

  sections() {
    if (this.activeQuery) return this.lists.search.length ? [{ label: "Results", rows: this.lists.search }] : [];
    return [
      { label: "Pinned", rows: this.pins },
      { label: "Favourites", rows: this.unpinned(this.lists.favorites) },
      { label: "Recent", rows: this.unpinned(this.recentRows()) },
    ].filter((s) => s.rows.length);
  }

  /** Whether an item is pinned to the Notion screen. */
  isPinned(item) {
    const key = item?.url || item?.key;
    return Boolean(key && this.pins.some((b) => b.key === key));
  }

  /** The board a source URL names, among the database shown and the databases its page embeds. */
  boardFor(key) {
    if (this.detail?.board?.key === key) return this.detail.board;
    const block = (this.detail?.blocks ?? []).find((b) => b.kind === "database" && b.board?.key === key);
    return block?.board ?? null;
  }

  /** Every board on screen, the database's own first. */
  boards() {
    return [this.detail?.board, ...((this.detail?.blocks ?? []).filter((b) => b.kind === "database").map((b) => b.board))].filter((b) => b?.key);
  }

  /** The card with this id on any board, and the board it sits on. */
  cardFor(id) {
    for (const board of this.boards()) {
      const card = [...(board.cards ?? []), ...(board.doneCards ?? [])].find((c) => c.id === id);
      if (card) return { board, card };
    }
    return null;
  }

  /** What the screen remembers about a board between draws: whether done cards show, and the last read of them. */
  uiOf(board) {
    if (!this.boardUI.has(board.key)) this.boardUI.set(board.key, { showDone: false, doneLoading: false, doneError: null });
    return this.boardUI.get(board.key);
  }

  /** Keeps a pinned item as the one the screen opens, and says so in the shared window state. */
  remember(item) {
    const key = item?.url || item?.key;
    if (!key || !this.pins.some((b) => b.key === key) || this.currentPin === key) return;
    this.currentPin = key;
    setShared(CONFIG, pinCurrent(shared(CONFIG), key));
  }

  /** Pins the page or database on screen, or unpins it: a pinned one opens here when the screen comes back. */
  togglePin(cx) {
    const detail = this.detail;
    if (!/^https?:\/\//.test(String(detail?.url ?? ""))) return;
    const item = { key: detail.url, url: detail.url, title: detail.title, icon: detail.icon, type: detail.kind === "database" ? "database" : "page" };
    const on = !this.isPinned(item);
    let config = pinItem(shared(CONFIG), item, on);
    if (on) config = pinCurrent(config, item.key);
    setShared(CONFIG, config);
    this.pins = pinnedItems(config);
    this.currentPin = config.current ?? null;
    this.toasts.push(cx, on ? "Pinned here" : "Unpinned", { kind: "info", description: on ? "It opens in Flow the next time." : null });
    cx.notify();
  }

  /** Shows a board's done cards, reading them the first time they are asked for. */
  toggleDone(board, cx) {
    if (!doneColumn(board?.shape)) return;
    const ui = this.uiOf(board);
    ui.showDone = !ui.showDone;
    if (!ui.showDone) {
      ui.doneError = null;
      board.doneCards = undefined;
      board.doneCount = 0;
    }
    cx.notify();
    if (ui.showDone && !board.doneCards) this.readDone(board, ui, cx);
  }

  /** Opens the small field that adds a card at the foot of a column. */
  startAdd(board, column, cx) {
    if (!board || column.none) return;
    this.adding = { source: board.key, column: column.name };
    this.newTask.set_value("");
    this.newTask.focus();
    cx.notify();
  }

  cancelAdd(cx) {
    this.adding = null;
    this.handle.focus();
    cx.notify();
  }

  /** Creates the card the new-task field holds, in the column it was opened on. */
  createTask(cx) {
    const adding = this.adding;
    const board = adding && this.boardFor(adding.source);
    const title = this.newTask.value().trim();
    if (!adding || !board || !title) return;
    this.creating = adding;
    this.adding = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.call("notion-create-pages", createArgs(board.source.url, board.shape, title, adding.column));
        this.creating = null;
        this.newTask.set_value("");
        this.toasts.push(cx, `Added to ${adding.column}`, { kind: "success" });
        await this.refreshBoard(board, cx);
      } catch (e) {
        this.creating = null;
        this.adding = adding;
        this.toasts.push(cx, "Could not add the card", { kind: "error", description: String(e?.message ?? e) });
      }
      cx.notify();
    });
  }

  /** Moves a card to a column at once, then tells Notion; a failed call puts it back. */
  moveCard(board, card, column, cx) {
    if (!board || !card || !column || card.status === column) return;
    if (this.busy) return;
    const before = { cards: board.cards, doneCards: board.doneCards, doneCount: board.doneCount, columns: board.columns, count: board.count };
    Object.assign(board, moveInBoard(board, card.id, column));
    this.busy = { source: board.key, id: card.id };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.call("notion-update-page", moveArgs(card, board.shape, column));
        this.busy = null;
        this.toasts.push(cx, `Moved to ${column}`, { kind: "success" });
        await this.refreshBoard(board, cx);
      } catch (e) {
        Object.assign(board, before);
        this.busy = null;
        this.toasts.push(cx, "Could not move the card", { kind: "error", description: String(e?.message ?? e) });
        cx.notify();
      }
    });
  }

  /** Opens a card's page in the screen, keeping the board behind it. */
  openCard(board, card, cx) {
    if (!card?.url) return;
    this.select(
      { key: card.url, url: card.url, title: card.title, type: "page", icon: null, path: board.title ?? "" },
      cx,
      { back: this.detail, keep: this.selected, shape: board.shape },
    );
  }

  /** The menu of a card: open it here or in Notion, or move it to any other column. */
  cardMenu(board, card, cx) {
    const columns = (board.shape?.columns ?? []).filter((c) => c.name !== card.status);
    openMenu(
      [
        { label: "Open here", icon: "file-text", command: `notion:card:${card.id}` },
        { label: "Open in Notion", icon: "external", command: `notion:open:${card.id}` },
        "separator",
        ...columns.map((column) => ({ label: `Move to ${column.name}`, icon: column.done ? "check" : "chevron-right", command: `notion:move:${card.id}:${encodeURIComponent(column.name)}` })),
      ],
      { width: 240 },
    );
  }

  /** A menu command chosen with its key: the person's, never a window command's alone. */
  action(c, cx) {
    const [what, ...rest] = c.split(":");
    const arg = rest.join(":");
    if (what === "pin") return this.togglePin(cx);
    if (what === "card") {
      const found = this.cardFor(arg);
      if (found) this.openCard(found.board, found.card, cx);
      return;
    }
    if (what === "open") {
      const found = this.cardFor(arg);
      if (found?.card.url) return this.open(found.card.url, cx);
      return;
    }
    if (what === "move") {
      const [id, column] = arg.split(":");
      const found = this.cardFor(id);
      if (found) this.moveCard(found.board, found.card, decodeURIComponent(column ?? ""), cx);
      return;
    }
    if (what === "done") {
      const board = this.boardFor(decodeURIComponent(arg));
      if (board) this.toggleDone(board, cx);
      return;
    }
    if (what === "refresh") {
      const board = this.boardFor(decodeURIComponent(arg));
      if (board) this.refreshBoard(board, cx);
    }
  }

  move(cx, by) {
    const all = this.items();
    if (!all.length) return;
    const at = all.findIndex((i) => i.key === this.selected?.key);
    const next = at < 0 ? all[by > 0 ? 0 : all.length - 1] : all[Math.max(0, Math.min(all.length - 1, at + by))];
    if (next) this.select(next, cx);
  }

  submitSearch(cx) {
    const query = this.query.value().trim();
    this.searching = false;
    this.handle.focus();
    if (!query) {
      this.activeQuery = "";
      this.lists.search = [];
      this.searchError = null;
      cx.notify();
      return;
    }
    this.activeQuery = query;
    this.searchLoading = true;
    this.searchError = null;
    const gen = ++this.searchGen;
    const intent = this.detailGen;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const answer = await this.call("notion-search", searchArgs(query));
        if (gen !== this.searchGen) return;
        this.lists.search = listItems(answer);
        this.searchLoading = false;
        if (this.lists.search[0] && this.detailGen === intent) this.select(this.lists.search[0], cx);
        else cx.notify();
      } catch (e) {
        if (gen !== this.searchGen) return;
        this.searchLoading = false;
        this.searchError = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  /** Signs in through cockpit, in the browser, then reads the lists again. */
  signIn(cx) {
    if (this.signing) return;
    this.signing = true;
    this.signError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hub.cockpit(loginArgs, { timeout: 300_000 });
        if (!r || r.code !== 0) throw new Error(errorOf(r).message);
        this.signing = false;
        this.status = "loading";
        this.reload(cx);
      } catch (e) {
        this.signing = false;
        this.signError = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  open(url, cx) {
    if (!/^https?:\/\//.test(String(url ?? ""))) return;
    cx.spawn(async () => hub.openUrl(url));
  }

  openSelected(cx) {
    this.open(this.detail?.url || this.shown?.url || this.selected?.url, cx);
  }

  backTo(cx) {
    if (!this.back) return false;
    this.detailGen += 1;
    this.detail = this.back;
    this.back = null;
    this.shown = null;
    cx.notify();
    return true;
  }

  clearSearch(cx) {
    this.activeQuery = "";
    this.lists.search = [];
    this.searchError = null;
    this.searchGen += 1;
    this.searchLoading = false;
    this.query.set_value("");
    const items = this.items();
    if (items.length && !items.some((i) => i.key === this.selected?.key)) this.select(items[0], cx);
    if (!items.length) {
      this.selected = null;
      this.shown = null;
      this.detail = null;
    }
    cx.notify();
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Keys and commands

  command(c, cx, key = null) {
    if (c === "focus" || c === "show:notion") {
      this.visible = true;
      this.handle.focus();
      if (this.status === "error") this.reload(cx);
    } else if (c.startsWith("show:") && this.visible) {
      this.visible = false;
    } else if (c.startsWith("notion:") && take(c, key)) {
      this.action(c.slice("notion:".length), cx);
    }
    cx.notify();
  }

  key(e, cx) {
    const stroke = e.keystroke;
    if (this.searching) {
      if (stroke === "escape") {
        this.searching = false;
        if (!this.query.value().trim()) this.clearSearch(cx);
        this.handle.focus();
        cx.notify();
        return true;
      }
      // Enter arrives as the field's submit.
      return false;
    }
    if (this.adding) {
      if (stroke === "escape") {
        this.cancelAdd(cx);
        return true;
      }
      // Enter arrives as the new-task field's submit.
      return false;
    }
    switch (stroke) {
      case "/":
        this.searching = true;
        this.query.focus();
        cx.notify();
        return true;
      case "j":
      case "down":
        this.move(cx, 1);
        return true;
      case "k":
      case "up":
        this.move(cx, -1);
        return true;
      case "g":
      case "home":
        this.move(cx, -1e6);
        return true;
      case "shift-g":
      case "end":
        this.move(cx, 1e6);
        return true;
      case "enter":
      case "o":
        this.openSelected(cx);
        return true;
      case "a": {
        const board = this.detail?.board ?? this.boards()[0];
        const column = board && openColumn(board.shape);
        if (column) this.startAdd(board, { name: column }, cx);
        return Boolean(column);
      }
      case "d": {
        const board = this.detail?.board ?? this.boards()[0];
        if (!board || !doneColumn(board.shape)) return false;
        this.toggleDone(board, cx);
        return true;
      }
      case "p":
        this.togglePin(cx);
        return true;
      case "r":
      case "shift-r":
        this.reload(cx);
        return true;
      case "escape":
        if (this.backTo(cx)) return true;
        if (this.activeQuery) return this.clearSearch(cx);
        return false;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing

  iconEl(d, size) {
    const k = tokens();
    if (d?.icon) return div().w(size).flex_none().text_size(size * 0.9).child(d.icon);
    return div().w(size).flex_none().child(Icon((d?.kind ?? d?.type) === "database" ? "table" : "file-text", { size: size * 0.8, color: k.mutedFg }));
  }

  listPane(k, cx) {
    const sections = this.sections();
    const rows = [];
    for (const section of sections) {
      rows.push({ height: 30, id: `section:${section.label}`, el: div().h(30).px(8).pt(2).child(SectionHeader(section.label, { count: section.rows.length })) });
      for (const item of section.rows) {
        rows.push({
          height: 50,
          id: item.key,
          el: ListRow(item.key, {
            height: 50,
            selected: this.selected?.key === item.key,
            leading: this.iconEl(item, 18),
            title: v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(item.title))
              .when(Boolean(item.highlight || item.path), (e) => e.child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(item.highlight || item.path))),
            meta: item.type === "database" ? Badge("Database", "secondary") : null,
            hover: this.hover,
            onClick: (_e, cx) => {
              this.searching = false;
              this.select(item, cx);
              this.handle.focus();
            },
            onDoubleClick: (_e, cx) => this.open(item.url, cx),
          }),
        });
      }
    }
    let body;
    if (this.activeQuery && this.searchLoading) {
      body = v_flex().flex_1().p(8).gap(8).children([0, 1, 2, 3].map((i) => Skeleton({ w: 200 + ((i * 41) % 80), h: 16 })));
    } else if (this.activeQuery && this.searchError) {
      body = v_flex().flex_1().p(12).gap(8).child(div().text_size(TEXT.sm).text_color(k.destructive).child(this.searchError)).child(Button("notion-search-retry", { label: "Try again", icon: "refresh", size: "sm", variant: "outline", onClick: (_e, cx) => this.submitSearch(cx) }));
    } else if (!sections.length) {
      const note = this.status === "loading" ? "Reading Notion…" : this.status === "login" ? "Sign in to browse your pages." : this.status === "error" ? "Notion is not answering." : this.activeQuery ? "Nothing in Notion matches." : "No pages yet.";
      body = v_flex().flex_1().p(12).text_size(TEXT.sm).text_color(k.mutedFg).child(note);
    } else {
      body = this.scroller.view("notion-list", rows, rows.findIndex((r) => r.id === this.selected?.key));
    }
    return v_flex()
      .w(this.width < 900 ? 240 : 300)
      .flex_none()
      .h_full()
      .min_h(0)
      .border_r_1()
      .border_color(k.border)
      .bg(k.background)
      .child(body);
  }

  detailHeader(k, cx) {
    const d = this.detail;
    if (!d) return null;
    const board = d.boardView?.name;
    const description = [board ? `${board} board` : d.kind === "database" ? "Database" : d.kind === "page" ? "Page" : null, d.parent].filter(Boolean).join(" · ");
    const pinned = this.isPinned(d);
    return h_flex()
      .h(54)
      .px(20)
      .gap(10)
      .flex_none()
      .items_center()
      .border_b_1()
      .border_color(k.border)
      .when(Boolean(this.back), (e) =>
        e.child(Button("notion-back", { label: "Back", icon: "chevron-left", variant: "ghost", size: "sm", tooltip: "Back  esc", onClick: (_e, cx) => this.backTo(cx) })),
      )
      .child(this.iconEl(d, 20))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().truncate().text_size(TEXT.base).font_semibold().text_color(k.foreground).child(d.title ?? "Notion"))
          .when(Boolean(description), (e) => e.child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(description))),
      )
      .child(
        Button("notion-pin", {
          label: pinned ? "Pinned" : "Pin",
          icon: pinned ? "pin-off" : "pin",
          variant: "ghost",
          size: "sm",
          tooltip: pinned ? "Unpin this  p" : "Pin this here  p",
          onClick: (_e, cx) => this.togglePin(cx),
        }),
      )
      .child(Button("notion-open-page", { label: "Open in Notion", icon: "external", variant: "outline", size: "sm", disabled: !/^https?:\/\//.test(String(d.url ?? "")), onClick: (_e, cx) => this.open(d.url, cx) }));
  }

  /** A page's properties as a strip of names and coloured values, when the page has any beyond its title. */
  propertyStrip(k) {
    const rows = this.detail?.properties ?? [];
    if (!rows.length) return null;
    const shape = this.pageShape ?? this.detail?.shape ?? null;
    const colors = (name) => {
      if (!shape) return null;
      if (shape.by === name) return Object.fromEntries(shape.columns.map((c) => [c.name, c.color]));
      return shape.extras.find((x) => x.name === name)?.colors ?? null;
    };
    return h_flex()
      .flex_wrap()
      .gap(12)
      .items_center()
      .children(
        rows.slice(0, 8).map((row) => {
          const map = colors(row.name);
          return h_flex()
            .gap(5)
            .items_center()
            .child(div().text_size(TEXT.xs).text_color(k.dim).child(row.name))
            .children(row.values.slice(0, 4).map((value) => Chip(value, { color: map?.[value] ? optionColor(map[value]) : null })));
        }),
      );
  }

  pageBody(k, cx) {
    const d = this.detail;
    const key = String(d.url ?? d.title ?? "page").replace(/[^a-z0-9]/gi, "").slice(-24) || "page";
    const blocks = (d.blocks?.length ? d.blocks : [{ kind: "markdown", text: d.markdown }]).filter((b) => b.kind === "database" || String(b.text ?? "").trim());
    const embedded = blocks.some((b) => b.kind === "database");
    const props = this.propertyStrip(k);
    const body = v_flex()
      .w_full()
      .gap(14)
      .when(Boolean(props), (e) => e.child(props))
      .children(
        blocks.map((block, i) =>
          block.kind === "database" ? this.inlineBlock(block, i, k, cx) : Markdown(`notion-page-${key}-${i}`, markdownOf(block.text), { size: TEXT.base }),
        ),
      )
      .when(!blocks.length && !props, (e) => e.child(div().text_size(TEXT.sm).text_color(k.mutedFg).child("This page has no content Flow can draw here. Open it in Notion to read it whole.")));
    return div()
      .id(`notion-page-body-${key}`)
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .child(v_flex().w_full().items_center().px(24).py(20).child(v_flex().w_full().max_w(embedded ? 1200 : 820).gap(14).child(body)));
  }

  /** A database a page embeds, drawn as its board in the page's own flow. */
  inlineBlock(block, i, k, cx) {
    const id = `notion-embed-${i}`;
    if (block.loading) {
      return v_flex()
        .id(id)
        .w_full()
        .gap(8)
        .p(14)
        .rounded(RADIUS.lg)
        .border_1()
        .border_color(k.border)
        .child(h_flex().gap(8).items_center().child(Spinner({ size: 14 })).child(div().text_size(TEXT.sm).text_color(k.mutedFg).child(`${block.title ?? "Database"}…`)))
        .children([0, 1, 2].map((n) => Skeleton({ w: 320 - n * 40, h: 14 })));
    }
    if (block.error) {
      return v_flex()
        .id(id)
        .w_full()
        .gap(8)
        .p(14)
        .rounded(RADIUS.lg)
        .border_1()
        .border_color(k.border)
        .child(div().text_size(TEXT.sm).text_color(k.mutedFg).child(block.title ?? "Database"))
        .child(div().text_size(TEXT.sm).text_color(k.destructive).child(block.error))
        .when(Boolean(block.url), (e) =>
          e.child(Button(`${id}-open`, { label: "Open in Notion", icon: "external", variant: "outline", size: "sm", onClick: (_e, cx) => this.open(block.url, cx) })),
        );
    }
    if (!block.board) return div().id(id);
    return v_flex()
      .id(id)
      .w_full()
      .rounded(RADIUS.lg)
      .border_1()
      .border_color(k.border)
      .bg(alpha(k.muted, 0.18))
      .overflow_hidden()
      .child(this.boardBar(block.board, k, cx, { inline: true }))
      .child(this.boardScroll(block.board, k, cx, { inline: true }));
  }

  /** A board's toolbar: its name, counts, the done switch and the new-card button. */
  boardBar(board, k, cx, { inline = false } = {}) {
    const ui = this.uiOf(board);
    const hasDone = Boolean(doneColumn(board.shape));
    const open = board.cards?.length ?? 0;
    const done = ui.showDone ? board.doneCards?.length ?? 0 : null;
    return h_flex()
      .h(44)
      .px(inline ? 12 : 20)
      .gap(8)
      .flex_none()
      .items_center()
      .when(!inline, (e) => e.border_b_1().border_color(k.border))
      .when(inline, (e) => e.child(this.iconEl({ icon: board.icon, kind: "database" }, 18)))
      .when(inline, (e) => e.child(div().max_w(240).truncate().text_size(TEXT.sm).font_semibold().text_color(k.foreground).child(board.title ?? "Database")))
      .when(Boolean(board.view?.name), (e) => e.child(Badge(board.view.name, "secondary")))
      .child(Badge(`${open} open`, "secondary"))
      .when(done !== null, (e) => e.child(Badge(`${done} done`, "outline")))
      .when(board.hasMore, (e) => e.child(Badge("first 100", "outline")))
      .child(div().flex_1())
      .when(Boolean(ui.doneError), (e) => e.child(div().max_w(240).truncate().text_size(TEXT.xs).text_color(k.destructive).tooltip(ui.doneError).child("done cards failed")))
      .when(hasDone, (e) =>
        e.child(
          h_flex()
            .gap(6)
            .items_center()
            .child(
              Button(`${inline ? "notion-embed" : "notion-board"}-done`, {
                label: ui.showDone ? "Hide done" : "Show done",
                icon: ui.showDone ? "eye-off" : "eye",
                variant: "outline",
                size: "sm",
                disabled: ui.doneLoading,
                onClick: (_e, cx) => this.toggleDone(board, cx),
              }),
            )
            .when(ui.doneLoading, (e) => e.child(Spinner({ size: 13 }))),
        ),
      )
      .child(
        Button(`${inline ? "notion-embed" : "notion-board"}-add`, {
          label: inline ? undefined : "New task",
          icon: "plus",
          variant: inline ? "ghost" : "default",
          size: "sm",
          tooltip: `Add a card  a`,
          disabled: !openColumn(board.shape),
          onClick: (_e, cx) => this.startAdd(board, { name: openColumn(board.shape) }, cx),
        }),
      )
      .when(inline && Boolean(board.url), (e) => e.child(Button(`${inline ? "notion-embed" : "notion-board"}-open`, { icon: "external", variant: "ghost", size: "icon-sm", tooltip: "Open in Notion", onClick: (_e, cx) => this.open(board.url, cx) })));
  }

  /** The columns of a board, scrolling across and down, and the pointer that moves a card between them. */
  boardScroll(board, k, cx, { inline = false } = {}) {
    const ui = this.uiOf(board);
    const columns = shownColumns(board, ui.showDone);
    let scroller = div()
      .id(`notion-board-${board.key}`)
      .relative()
      .p(inline ? 12 : 16)
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d || d.source !== board.key || d.moved) return;
        if (Math.abs(e.position.x - d.x) > 4 || Math.abs(e.position.y - d.y) > 4) {
          d.moved = true;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => this.drop(cx))
      .on_hover((on, cx) => {
        if (!on && this.drag && !this.drag.moved) {
          this.drag = null;
          cx.notify();
        }
      })
      .child(h_flex().items_start().gap(10).children(columns.map((column) => this.columnEl(board, column, k, cx, { inline }))));
    if (inline) return scroller.overflow_x_scrollbar();
    return scroller.flex_1().min_h(0).overflow_scrollbar();
  }

  /** Drops the card the pointer carries on the column it last hovered. */
  drop(cx) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.dragMoved = Boolean(drag.moved);
    const board = this.boardFor(drag.source);
    if (!board || drag.over === drag.from) {
      cx.notify();
      return;
    }
    const card = [...(board.cards ?? []), ...(board.doneCards ?? [])].find((c) => c.id === drag.id);
    if (card) this.moveCard(board, card, drag.over, cx);
    cx.notify();
  }

  columnEl(board, column, k, cx, { inline = false } = {}) {
    const ui = this.uiOf(board);
    const cards = column.cards ?? [];
    const adding = this.adding?.source === board.key && this.adding.column === column.name;
    const creating = this.creating?.source === board.key && this.creating.column === column.name;
    const loading = ui.showDone && column.done && !board.doneCards && ui.doneLoading;
    const target = this.drag && this.drag.source === board.key && this.drag.over === column.name && this.drag.from !== column.name;
    const count = loading ? "…" : String(cards.length);
    return v_flex()
      .id(`notion-col-${board.key}-${column.name}`)
      .w(inline ? 250 : 260)
      .flex_none()
      .gap(8)
      .p(8)
      .rounded(RADIUS.lg)
      .bg(alpha(k.muted, 0.55))
      .border_1()
      .border_color(target ? k.ring : "#00000000")
      .on_hover((on, cx) => {
        if (on && this.drag && this.drag.source === board.key) {
          this.drag.over = column.name;
          cx.notify();
        }
      })
      .child(
        h_flex()
          .h(24)
          .px(4)
          .gap(6)
          .items_center()
          .child(div().size(8).flex_none().rounded(4).bg(optionColor(column.color)))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).font_medium().text_color(column.done ? k.dim : k.mutedFg).child(column.name))
          .child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(count))
          .when(!column.none, (e) =>
            e.child(
              Button(`notion-add-${board.key}-${column.name}`, {
                icon: "plus",
                variant: "ghost",
                size: "icon-sm",
                tooltip: `Add to ${column.name}`,
                onClick: (_e, cx) => {
                  cx.stop_propagation();
                  this.startAdd(board, column, cx);
                },
              }),
            ),
          ),
      )
      .children(cards.map((card) => this.cardEl(board, column, card, k, cx)))
      .when(loading, (e) => e.children([0, 1].map((n) => Skeleton({ w: 190 + n * 20, h: 42 }))))
      .when(adding, (e) =>
        e.child(
          v_flex()
            .w_full()
            .gap(6)
            .p(8)
            .rounded(RADIUS.md)
            .border_1()
            .border_color(k.ring)
            .bg(k.background)
            .child(TextField(this.newTask, { active: true }))
            .child(
              h_flex()
                .justify_end()
                .gap(6)
                .child(Button(`notion-add-cancel-${board.key}`, { label: "Cancel", variant: "ghost", size: "sm", onClick: (_e, cx) => this.cancelAdd(cx) }))
                .child(Button(`notion-add-save-${board.key}`, { label: "Add", size: "sm", onClick: (_e, cx) => this.createTask(cx) })),
            ),
        ),
      )
      .when(creating, (e) => e.child(h_flex().h(44).gap(8).items_center().px(4).child(Spinner({ size: 13 })).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child("Adding…"))))
      .when(!cards.length && !adding && !creating && !loading, (e) => e.child(div().px(4).py(6).text_size(TEXT.xs).text_color(k.dim).child("Empty")));
  }

  cardEl(board, column, card, k, cx) {
    const chips = [];
    for (const field of card.fields ?? []) {
      for (const value of field.values.slice(0, 2)) {
        const color = field.colors?.[value] ? optionColor(field.colors[value]) : null;
        chips.push(Chip(value, { color, mono: field.type === "text" || field.type === "rich_text" }));
        if (chips.length >= 3) break;
      }
      if (chips.length >= 3) break;
    }
    const columns = shownColumns(board, this.uiOf(board).showDone);
    const at = columns.findIndex((c) => c.name === column.name);
    const prev = at > 0 ? columns[at - 1] : null;
    const next = at >= 0 && at < columns.length - 1 ? columns[at + 1] : null;
    const busy = this.busy?.id === card.id;
    const dragging = this.drag?.id === card.id && this.drag.moved;
    const actions = [
      prev && Button(`notion-card-${card.id}-prev`, { icon: "chevron-left", variant: "ghost", size: "icon-sm", tooltip: `Move to ${prev.name}`, onClick: (_e, cx) => (cx.stop_propagation(), this.moveCard(board, card, prev.name, cx)) }),
      next && Button(`notion-card-${card.id}-next`, { icon: "chevron-right", variant: "ghost", size: "icon-sm", tooltip: `Move to ${next.name}`, onClick: (_e, cx) => (cx.stop_propagation(), this.moveCard(board, card, next.name, cx)) }),
    ].filter(Boolean);
    const showing = this.hover.is(card.id);
    return v_flex()
      .id(`notion-card-${card.id}`)
      .w_full()
      .gap(6)
      .p(10)
      .rounded(RADIUS.md)
      .border_1()
      .border_color(k.border)
      .bg(k.background)
      .cursor_pointer()
      .when(Boolean(dragging), (e) => e.opacity(0.5))
      .when(busy, (e) => e.opacity(0.65))
      .hover((s) => s.border_color(k.ring))
      .on_mouse_down("left", (e, cx) => {
        this.dragMoved = false;
        if (busy) return;
        this.drag = { source: board.key, id: card.id, from: column.name, over: column.name, x: e.position.x, y: e.position.y, moved: false };
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.cardMenu(board, card, cx);
      })
      .on_click((_e, cx) => {
        if (this.dragMoved) {
          this.dragMoved = false;
          return;
        }
        this.drag = null;
        this.searching = false;
        this.handle.focus();
        this.openCard(board, card, cx);
      })
      .child(div().text_size(TEXT.sm).line_height(1.35).text_color(k.foreground).child(card.title))
      .when(chips.length > 0 || (showing && actions.length > 0), (e) =>
        e.child(
          h_flex()
            .gap(4)
            .flex_wrap()
            .items_center()
            .children(chips)
            .child(div().flex_1())
            .when(showing, (x) => x.children(actions)),
        ),
      )
      .on_hover((on, cx) => {
        if (on) this.hover.key = card.id;
        else if (this.hover.key === card.id) this.hover.key = null;
        cx.notify();
      })
      .relative();
  }

  boardBody(k, cx) {
    const d = this.detail;
    const board = d.board;
    if (!board || !board.shape?.columns.length) {
      return Empty({
        icon: "table",
        title: "No board view",
        description: "This database has no status or select property Flow can group into columns.",
        action: Button("notion-open-database", { label: "Open in Notion", icon: "external", size: "sm", onClick: (_e, cx) => this.open(d.url, cx) }),
      });
    }
    return v_flex().flex_1().min_h(0).child(this.boardBar(board, k, cx)).child(this.boardScroll(board, k, cx));
  }

  signInBody(k, cx) {
    const action = Button("notion-signin", { label: this.signing ? "Signing in…" : "Sign in to Notion", icon: "key-round", size: "sm", disabled: this.signing, onClick: (_e, cx) => this.signIn(cx) });
    return v_flex()
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .gap(10)
      .child(
        Empty({
          icon: "notion",
          title: "Notion needs a sign-in",
          description: "Flow reads Notion through cockpit's connector. Sign in with the Notion account whose pages and databases you want here.",
          action,
        }),
      )
      .when(this.signing, (e) => e.child(h_flex().gap(8).items_center().text_size(TEXT.sm).text_color(k.mutedFg).child(Spinner({ size: 14 })).child("Finish in your browser, then come back.")))
      .when(Boolean(this.signError), (e) => e.child(div().max_w(520).text_size(TEXT.sm).text_color(k.destructive).child(this.signError)));
  }

  errorBody(k, cx) {
    if (this.status === "login") return this.signInBody(k, cx);
    return v_flex()
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .child(ErrorState({ title: "Could not read Notion", message: this.error, onRetry: (_e, cx) => this.reload(cx) }));
  }

  detailBody(k, cx) {
    const d = this.detail;
    if (this.status === "login" && !d) return this.signInBody(k, cx);
    if (this.status === "error" && !d) return this.errorBody(k, cx);
    if (!d) {
      if (this.status === "loading") return v_flex().flex_1().p(24).gap(10).children([0, 1, 2, 3, 4].map((i) => Skeleton({ w: 240 + ((i * 67) % 220), h: 16 })));
      return Empty({ icon: "notion", title: "Read Notion from Flow", description: "Pick a page or a database from the list. Flow reads what your Notion login can see; on a board, it moves and adds cards." });
    }
    if (d.kind === "loading") {
      return v_flex().flex_1().p(24).gap(10).children([Skeleton({ w: 280, h: 22 }), Skeleton({ w: 520, h: 14 }), Skeleton({ w: 460, h: 14 }), Skeleton({ w: 540, h: 14 })]);
    }
    if (d.kind === "error") {
      if (d.login) return this.signInBody(k, cx);
      if (d.remote) return Empty({ icon: "server", title: "Notion is on the other machine", description: d.message });
      return v_flex()
        .flex_1()
        .min_h(0)
        .items_center()
        .justify_center()
        .child(ErrorState({ title: "Could not read this page", message: d.message, onRetry: (_e, cx) => this.select(this.shown ?? this.selected, cx, { back: this.back, keep: this.selected }) }));
    }
    if (d.kind === "database") return this.boardBody(k, cx);
    return this.pageBody(k, cx);
  }

  render(cx) {
    const k = tokens();
    const workspace = this.me?.workspace?.name ?? "Notion";
    const read = this.status === "live" && this.readAt ? ` · read ${dur(Date.now() - this.readAt)} ago` : "";
    const description = this.status === "login" ? "Sign in to read your workspace" : this.status === "error" ? "The last read failed" : `${workspace}${read}`;
    const toasts = this.toasts.render();
    const root = v_flex()
      .id("notion")
      .track_focus(this.handle)
      .size_full()
      .relative()
      .bg(k.sheet)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .on_size_change((size, cx) => {
        const w = size.width / (settings().zoom ?? 1);
        if (Math.abs(w - this.width) > 1) {
          this.width = w;
          cx.notify();
        }
      })
      .on_mouse_down("left", () => {
        this.visible = true;
        if (!this.searching) this.handle.focus();
      })
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .child(
        PageHeader({
          icon: "notion",
          title: "Notion",
          description,
          aside: this.loading || this.searchLoading ? Spinner({ size: 14, color: k.mutedFg }) : null,
          actions: [
            this.status === "login" ? Button("notion-signin-head", { label: "Sign in", icon: "key-round", size: "sm", disabled: this.signing, onClick: (_e, cx) => this.signIn(cx) }) : div(),
            Button("notion-refresh", { label: "Refresh", icon: "refresh-cw", variant: "outline", size: "sm", kbd: "r", onClick: (_e, cx) => this.reload(cx) }),
          ],
        }),
      )
      .child(
        h_flex()
          .px(20)
          .py(10)
          .gap(10)
          .flex_none()
          .items_center()
          .border_b_1()
          .border_color(k.border)
          .child(div().w(360).max_w_full().on_mouse_down("left", (_e, cx) => ((this.searching = true), cx.notify())).child(SearchField(this.query, { active: this.searching, kbd: "/" })))
          .when(Boolean(this.activeQuery), (e) => e.child(Badge(`“${this.activeQuery}”`, "secondary")))
          .child(div().flex_1())
          .when(this.status === "live", (e) => e.child(Badge("Boards live", "outline"))),
      )
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .on_mouse_down("left", () => {
            this.searching = false;
            this.handle.focus();
          })
          .child(this.listPane(k, cx))
          .child(
            v_flex()
              .flex_1()
              .h_full()
              .min_w(0)
              .min_h(0)
              .when(Boolean(this.detail), (e) => e.child(this.detailHeader(k, cx)))
              .child(this.detailBody(k, cx)),
          ),
      )
      .when(Boolean(toasts), (e) => e.child(toasts))
      .child(KeyHints([["j k", "move"], ["⏎", "open in Notion"], ["/", "search"], ["a", "add"], ["d", "done"], ["p", "pin"], ["r", "read again"], ["esc", "back"]]));
    return root;
  }
}
