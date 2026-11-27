// The GitLab screen: the person's activity, merge requests, pipelines, issues and projects, read from GitLab's MCP server
// through cockpit's connector. Read-only: it browses, filters and opens pages in GitLab, and changes nothing there.
// Keys: 1–5 for the tabs, j k to move, ⏎ to open, r to read again, / to filter, p for the project menu, m for a row's menu.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { settings, shared, setShared } from "herdr";
import * as hub from "./hub.js";
import { take } from "./person.js";
import { readGitlab, openGitlabForm } from "./gitlab-form.js";
import { failure } from "./gitlab.js";
import {
  TABS, callArgs, parseAnswer, pipelineState, pipelineOpen, failedPipelines, pipelineFor, mrProjects, filterRows,
  agoText, whenText, loadCore, loadActivity, loadMergeRequests, loadPipelines, loadIssues, loadMrDetail, loadPipelineDetail,
  loadWorkDetail, groupOf, GITLAB_ORANGE,
} from "./gitlab-data.js";
import {
  tokens, TEXT, RADIUS, Icon, Badge, Button, ListRow, Chip, PageHeader, SearchField, KeyHints, Empty, ErrorState, Skeleton,
  Tabs, Toaster, Scroller, Hover, SidePanel, Spinner, Mono, SectionHeader, StageHeading, openMenu, alpha,
} from "./ui.js";

/** What each kind of contribution's row shows: its icon and colour token. */
const EVENT = {
  push: ["git-commit", "info"],
  merge: ["git-merge", "working"],
  issue: ["circle-dot", "success"],
  note: ["message-circle", "mutedFg"],
  milestone: ["flag", "info"],
  project: ["folder", "mutedFg"],
  member: ["user-plus", "mutedFg"],
  activity: ["activity", "mutedFg"],
};

const TONE = { success: "success", destructive: "destructive", info: "info", warning: "warning", mutedFg: "outline" };
const toneColor = (k, tone) => k[tone] ?? k.mutedFg;

/** A merge request's state as a badge. */
function mrBadge(row, k) {
  if (row.draft) return Badge("Draft", "warning", { id: `mr-state-${row.iid}` });
  if (row.state === "merged") return Badge("Merged", "outline");
  if (row.state === "closed") return Badge("Closed", "outline");
  return Badge("Open", "info", { dot: k.info });
}

/** A work item's state as a badge. */
function issueBadge(row) {
  return row.state === "closed" ? Badge("Closed", "outline") : Badge("Open", "info");
}

/** The status inside a badge, from a pipeline status. */
function pipelineBadge(status) {
  const s = pipelineState(status);
  return Badge(s.label, TONE[s.tone] ?? "outline", { icon: s.icon });
}

/** How a list section starts: its label, a count and a hairline. */
function heading(label, count) {
  return { height: 32, el: div().h(32).pt(4).child(SectionHeader(label, { count })) };
}

export default class GitlabPage {
  init(_p, cx) {
    this.link = null;
    this.core = null;
    this.data = { activity: null, mrs: null, pipelines: null, issues: null, projects: null };
    this.busy = new Set();
    this.details = new Map();
    this.detail = null;
    this.sel = {};
    this.tab = "activity";
    this.project = null;
    this.filter = "";
    this.filtering = false;
    this.width = 1200;
    this.visible = true;
    this.gen = 0;
    this.hover = new Hover();
    this.toasts = new Toaster();
    this.scroller = new Scroller();
    this.handle = cx.focus_handle();
    this.query = InputState.new({ placeholder: "Filter GitLab…" });
    this.query.on("change", (_e, cx) => {
      this.filter = this.query.value();
      this.keepSelection(cx);
      cx.notify();
    });
    this.query.on("submit", (_e, cx) => {
      this.filtering = false;
      this.handle.focus();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      this.link = await readGitlab().catch(() => null);
      cx.notify();
      if (this.link) await this.reload(cx, this.tab);
    });
  }

  /** The window's clock: the tab in front is read again once two minutes pass while the screen shows. */
  tick(cx, now) {
    if (!this.visible || !this.link) return;
    const at = this.data[this.tab]?.at ?? 0;
    if (now - at > 120_000 && !this.busy.has(this.tab) && !this.data[this.tab]?.error) this.reload(cx, this.tab);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reading

  /** One call to GitLab's MCP server, its answer as an object; a failed call throws its reason. */
  async call(tool, args = {}) {
    const r = await hub.cockpit(callArgs(tool, args), { timeout: 90_000 });
    if (!r || r.code !== 0) throw new Error(failure(r));
    return parseAnswer(r.stdout);
  }

  /** Reads one tab, through the person's groups and projects (read once, again on refresh), narrowed to the chosen project. */
  async load(tab) {
    const run = (tool, args) => this.call(tool, args);
    if (!this.core) this.core = await loadCore(run);
    if (tab === "activity") return loadActivity(run, this.core, this.project);
    if (tab === "mrs") return loadMergeRequests(run, this.core, this.project);
    if (tab === "pipelines") return loadPipelines(run, this.core, mrProjects(this.data.mrs?.rows ?? []), this.project);
    if (tab === "issues") return loadIssues(run, this.core, this.project);
    return { rows: (this.core.projects ?? []).filter((p) => !this.project || p.fullPath === this.project).map((p) => this.projectRow(p)) };
  }

  /** What the sidebar's app strip shows on the GitLab button: the pipelines that failed, if any. */
  publishBadge(rows = []) {
    const count = failedPipelines(rows).length;
    const value = count ? { count, tone: "destructive" } : null;
    if (JSON.stringify(shared("badge.gitlab") ?? null) === JSON.stringify(value)) return;
    setShared("badge.gitlab", value);
  }

  /** Reads a tab again, keeping what it showed until the answer lands (a first read shows skeletons). */
  async reload(cx, tab = this.tab) {
    if (!this.link || this.busy.has(tab)) return;
    const gen = this.gen;
    this.busy.add(tab);
    const old = this.data[tab];
    this.data[tab] = { ...(old ?? {}), loading: !old, refreshing: Boolean(old), error: null };
    cx.notify();
    try {
      const value = await this.load(tab);
      if (gen !== this.gen) return;
      this.data[tab] = { ...value, at: Date.now(), loading: false, refreshing: false, error: null };
      if (tab === "pipelines") this.publishBadge(value.rows);
      if (tab === this.tab) this.keepSelection(cx);
    } catch (e) {
      if (gen !== this.gen) return;
      this.data[tab] = { ...(old ?? {}), loading: false, refreshing: false, error: String(e?.message ?? e) };
    } finally {
      this.busy.delete(tab);
      if (gen === this.gen) cx.notify();
    }
  }

  /** Reads everything again: the tabs come back one by one as they are opened. */
  refresh(cx, tab = this.tab) {
    this.gen += 1;
    this.core = null;
    this.details.clear();
    this.detail = null;
    for (const id of Object.keys(this.data)) this.data[id] = null;
    this.busy.clear();
    this.reload(cx, tab);
  }

  /** A project row, with the group it belongs to among the person's. */
  projectRow(p) {
    return {
      key: `project:${p.fullPath}`,
      id: p.id,
      name: p.name,
      path: p.fullPath,
      group: groupOf(p.fullPath, (this.core?.groups ?? []).map((g) => g.fullPath)),
      visibility: p.visibility,
      archived: p.archived,
      url: p.webUrl,
    };
  }

  /** The project paths the top bar offers, sorted so the dropdown keeps its order between reads. */
  projectPaths() {
    return [...new Set((this.core?.projects ?? []).map((p) => p.fullPath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  /** The top bar's dropdown: every project, the chosen one marked, and All projects first. */
  projectMenu(cx, byKey = false) {
    const items = [
      { label: "All projects", icon: "layers", check: !this.project, command: "gitlab:project:" },
      "separator",
      ...this.projectPaths().map((path) => ({
        label: path,
        icon: "folder-git",
        check: path === this.project,
        command: `gitlab:project:${path}`,
      })),
    ];
    openMenu(items, { width: 320, byKey });
  }

  /** Narrows every tab to `project` (null: all of them) and reads the tab in front again. */
  setProject(project, cx) {
    const next = project || null;
    if (next === this.project) return;
    this.project = next;
    this.gen += 1;
    this.details.clear();
    this.detail = null;
    for (const id of Object.keys(this.data)) this.data[id] = null;
    this.busy.clear();
    if (this.link) this.reload(cx, this.tab);
    cx.notify();
  }

  /** The top bar's project dropdown: a select-shaped button that opens the project menu. */
  projectSelect(k, cx) {
    const label = this.project ?? "All projects";
    return h_flex()
      .id("gitlab-project")
      .h(32)
      .px(10)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(RADIUS.md)
      .border_1()
      .border_color(k.input)
      .bg(k.background)
      .cursor_pointer()
      .text_size(TEXT.sm)
      .font_medium()
      .text_color(k.foreground)
      .hover((s) => s.bg(k.accent))
      .tooltip(this.project ? `Showing ${this.project} only` : "Filter by project")
      .on_click((_e, cx) => this.projectMenu(cx))
      .child(Icon("folder-git", { size: 14, color: k.mutedFg }))
      .child(div().max_w(this.width < 980 ? 130 : 220).truncate().child(label))
      .child(Icon("chevron-down", { size: 14, color: k.mutedFg }));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What the tab shows

  rowsOf(tab = this.tab) {
    return filterRows(this.data[tab]?.rows ?? [], this.filter);
  }

  todos() {
    return filterRows(this.data.activity?.todos ?? [], this.filter);
  }

  /** The rows of a tab in the order they are drawn, the merge requests by section. */
  sections(tab = this.tab) {
    if (tab === "activity") {
      const out = [];
      const todos = this.todos();
      if (todos.length) out.push({ id: "todos", label: "To-dos", rows: todos });
      const rows = this.rowsOf("activity");
      if (rows.length) out.push({ id: "events", label: "Your activity", rows });
      return out;
    }
    if (tab === "mrs") {
      const rows = this.rowsOf("mrs");
      return [
        ["review", "Waiting on your review"],
        ["yours", "Yours"],
        ["merged", "Merged"],
      ]
        .map(([id, label]) => ({ id, label, rows: rows.filter((r) => r.scope === id) }))
        .filter((s) => s.rows.length);
    }
    if (tab === "pipelines") {
      const out = [];
      for (const row of this.rowsOf("pipelines")) {
        let section = out.find((s) => s.id === row.project);
        if (!section) out.push((section = { id: row.project, label: row.project, rows: [] }));
        section.rows.push(row);
      }
      return out;
    }
    if (tab === "issues") {
      const rows = this.rowsOf("issues");
      return rows.length ? [{ id: "issues", label: this.data.issues?.scope === "all" ? "Open in your groups" : "Assigned to you", rows }] : [];
    }
    const out = [];
    for (const row of this.rowsOf("projects")) {
      const label = row.group || "Your projects";
      let section = out.find((s) => s.id === label);
      if (!section) out.push((section = { id: label, label, rows: [] }));
      section.rows.push(row);
    }
    return out;
  }

  keysOf(tab = this.tab) {
    return this.sections(tab).flatMap((s) => s.rows.map((r) => r.key));
  }

  allRows() {
    const rows = [];
    for (const tab of Object.keys(this.data)) rows.push(...(this.data[tab]?.rows ?? []));
    rows.push(...(this.data.activity?.todos ?? []));
    return rows;
  }

  selectedRow() {
    const key = this.sel[this.tab];
    if (!key) return null;
    return this.allRows().find((r) => r.key === key) ?? null;
  }

  keepSelection(cx) {
    const keys = this.keysOf(this.tab);
    if (!keys.includes(this.sel[this.tab])) this.sel[this.tab] = keys[0] ?? null;
    this.ensureDetail(cx);
  }

  pick(cx, key) {
    this.sel[this.tab] = key;
    this.ensureDetail(cx);
    this.handle.focus();
    cx.notify();
  }

  move(cx, by) {
    const keys = this.keysOf(this.tab);
    if (!keys.length) return;
    const at = Math.max(0, keys.indexOf(this.sel[this.tab]));
    this.sel[this.tab] = keys[Math.max(0, Math.min(keys.length - 1, at + by))];
    this.ensureDetail(cx);
    cx.notify();
  }

  /** Selects `tab` and reads it when it has never been read. */
  switchTo(tab, cx) {
    if (!TABS.some((t) => t.id === tab)) return;
    this.tab = tab;
    this.detail = null;
    cx.notify();
    if (!this.link) return;
    if (!this.data[tab]?.at && !this.busy.has(tab)) this.reload(cx, tab);
    else this.keepSelection(cx);
  }

  /** The detail of the selected row, read once and kept: only merge requests, pipelines and work items have more to read. */
  ensureDetail(cx) {
    const row = this.selectedRow();
    if (!row) {
      this.detail = null;
      return;
    }
    if (this.detail?.key === row.key) return;
    const kept = this.details.get(row.key);
    if (kept) {
      this.detail = kept;
      return;
    }
    const read = this.tab === "mrs" ? loadMrDetail : this.tab === "pipelines" ? loadPipelineDetail : this.tab === "issues" ? loadWorkDetail : null;
    if (!read) {
      this.detail = { key: row.key, value: null };
      return;
    }
    this.detail = { key: row.key, loading: true };
    cx.spawn(async (cx) => {
      try {
        const value = await read((tool, args) => this.call(tool, args), row);
        const entry = { key: row.key, value };
        this.details.set(row.key, entry);
        if (this.detail?.key === row.key) {
          this.detail = entry;
          cx.notify();
        }
      } catch (e) {
        if (this.detail?.key === row.key) {
          this.detail = { key: row.key, error: String(e?.message ?? e) };
          cx.notify();
        }
      }
    });
  }

  open(url, cx) {
    if (!url) return this.toasts.push(cx, "GitLab gives no page for this one", { kind: "info" });
    cx.spawn(async () => hub.openUrl(url));
  }

  menu(cx) {
    const row = this.selectedRow();
    if (!row) return;
    openMenu(
      [
        { label: "Open in GitLab", icon: "external", command: `gitlab:open:${row.key}` },
        { label: "Read it again", icon: "refresh-cw", command: "gitlab:refresh" },
      ],
      { width: 220 },
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Keys and commands

  command(c, cx, key = null) {
    if (c === "focus" || c === "show:gitlab") {
      this.visible = true;
      this.handle.focus();
      if (!this.link) {
        // Connected from the dialog since the screen opened: read it now.
        cx.spawn(async (cx) => {
          this.link = await readGitlab().catch(() => null);
          cx.notify();
          if (this.link) await this.reload(cx, this.tab);
        });
      } else if (!this.core && !this.busy.size) this.reload(cx, this.tab);
    } else if (c.startsWith("show:") && this.visible) {
      this.visible = false;
    } else if (c === "gitlab:refresh") {
      this.refresh(cx);
    } else if (c.startsWith("gitlab:project:")) {
      if (take(c, key)) this.setProject(c.slice("gitlab:project:".length), cx);
    } else if (c.startsWith("gitlab:open:")) {
      const row = this.allRows().find((r) => r.key === c.slice("gitlab:open:".length));
      if (row) this.open(row.url, cx);
    }
    cx.notify();
  }

  key(e, cx) {
    const stroke = e.keystroke;
    if (this.filtering) {
      if (stroke !== "escape") return false;
      this.filter = "";
      this.query.set_value("");
      this.filtering = false;
      this.handle.focus();
      this.keepSelection(cx);
      cx.notify();
      return true;
    }
    switch (stroke) {
      case "/":
        this.filtering = true;
        this.query.focus();
        cx.notify();
        return true;
      case "p":
        if (!this.link) return false;
        this.projectMenu(cx, true);
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
      case "o": {
        const row = this.selectedRow();
        if (!row) return false;
        this.open(row.url, cx);
        return true;
      }
      case "r":
      case "shift-r":
        this.refresh(cx);
        return true;
      case "m":
      case "shift-f10":
        this.menu(cx);
        return true;
      case "escape":
        if (!this.filter) return false;
        this.filter = "";
        this.query.set_value("");
        this.keepSelection(cx);
        cx.notify();
        return true;
      default: {
        const n = Number(stroke);
        if (Number.isInteger(n) && n >= 1 && n <= TABS.length) {
          this.switchTo(TABS[n - 1].id, cx);
          return true;
        }
        if (stroke === "tab") {
          const at = TABS.findIndex((t) => t.id === this.tab);
          this.switchTo(TABS[(at + 1) % TABS.length].id, cx);
          return true;
        }
        return false;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing: the list

  headerRow(label, count) {
    const k = tokens();
    return {
      height: 32,
      el: div()
        .h(32)
        .px(8)
        .pt(4)
        .child(StageHeading(`gitlab-group-${label}`, label, { color: k.dim, count })),
    };
  }

  /** A row of the contribution list. */
  eventEl(row, k) {
    const [icon, tone] = EVENT[row.kind] ?? EVENT.activity;
    return ListRow(row.key, {
      height: 52,
      selected: this.sel.activity === row.key,
      leading: div().w(18).flex_none().child(Icon(icon, { size: 14, color: toneColor(k, tone) })),
      title: v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(row.title))
        .child(
          h_flex()
            .gap(6)
            .min_w(0)
            .items_center()
            .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child([row.action, row.project].filter(Boolean).join(" · ")))
            .when(Boolean(row.ref), (e) => e.child(div().truncate().text_size(TEXT.xs).text_color(k.dim).child(row.ref))),
        ),
      meta: div().flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(agoText(row.at)),
      hover: this.hover,
      actions: row.url
        ? [Button(`${row.key}-open`, { icon: "external", variant: "ghost", size: "icon-sm", tooltip: "Open in GitLab", onClick: (_e, cx) => (cx.stop_propagation(), this.open(row.url, cx)) })]
        : [],
      onClick: (_e, cx) => this.pick(cx, row.key),
      onDoubleClick: (_e, cx) => this.open(row.url, cx),
      onRightClick: () => this.menu(cx),
    });
  }

  /** A row of the to-do list: what GitLab says waits on the person. */
  todoEl(row, k) {
    return ListRow(row.key, {
      height: 48,
      selected: this.sel.activity === row.key,
      leading: div().w(18).flex_none().child(Icon("bell-dot", { size: 14, color: k.warning })),
      title: v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(row.title))
        .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child([row.action, row.project].filter(Boolean).join(" · "))),
      meta: div().flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(agoText(row.at)),
      hover: this.hover,
      onClick: (_e, cx) => this.pick(cx, row.key),
      onDoubleClick: (_e, cx) => this.open(row.url, cx),
      onRightClick: () => this.menu(cx),
    });
  }

  mrEl(row, k) {
    const pipeline = pipelineFor(row, this.data.pipelines?.rows ?? []);
    const state = pipeline ? pipelineState(pipeline.status) : null;
    return ListRow(row.key, {
      height: 56,
      selected: this.sel.mrs === row.key,
      leading: div().w(18).flex_none().child(Icon(state?.icon ?? "git-merge", { size: 14, color: state ? toneColor(k, state.tone) : k.mutedFg })),
      title: v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(row.title))
        .child(
          h_flex()
            .gap(6)
            .min_w(0)
            .items_center()
            .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(`${row.project} !${row.iid}`))
            .when(Boolean(row.branch), (e) => e.child(div().truncate().text_size(TEXT.xs).text_color(k.dim).child(`${row.branch} → ${row.base}`))),
        ),
      meta: state ? pipelineBadge(pipeline.status) : mrBadge(row, k),
      hover: this.hover,
      onClick: (_e, cx) => this.pick(cx, row.key),
      onDoubleClick: (_e, cx) => this.open(row.url, cx),
      onRightClick: () => this.menu(cx),
    });
  }

  pipelineEl(row, k) {
    const state = pipelineState(row.status);
    return ListRow(row.key, {
      height: 48,
      selected: this.sel.pipelines === row.key,
      leading: div().w(18).flex_none().child(Icon(state.icon, { size: 14, color: toneColor(k, state.tone) })),
      title: v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(
          h_flex()
            .gap(6)
            .min_w(0)
            .items_center()
            .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(row.ref))
            .when(Boolean(row.source), (e) => e.child(Badge(row.source, "secondary"))),
        )
        .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(`#${row.id}${row.sha ? ` · ${row.sha.slice(0, 8)}` : ""}`)),
      meta: h_flex().gap(8).items_center().child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(agoText(row.updatedAt ?? row.createdAt))).child(Badge(state.label, TONE[state.tone] ?? "outline")),
      hover: this.hover,
      onClick: (_e, cx) => this.pick(cx, row.key),
      onDoubleClick: (_e, cx) => this.open(row.url, cx),
      onRightClick: () => this.menu(cx),
    });
  }

  issueEl(row, k) {
    return ListRow(row.key, {
      height: 50,
      selected: this.sel.issues === row.key,
      leading: div().w(18).flex_none().child(Icon("circle-dot", { size: 14, color: row.state === "closed" ? k.mutedFg : k.success })),
      title: v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(row.title))
        .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child([row.reference, row.type].filter(Boolean).join(" · "))),
      meta: h_flex().gap(8).items_center().child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(agoText(row.updatedAt ?? row.createdAt))).child(issueBadge(row)),
      hover: this.hover,
      onClick: (_e, cx) => this.pick(cx, row.key),
      onDoubleClick: (_e, cx) => this.open(row.url, cx),
      onRightClick: () => this.menu(cx),
    });
  }

  projectEl(row, k) {
    return ListRow(row.key, {
      height: 48,
      selected: this.sel.projects === row.key,
      leading: div().w(18).flex_none().child(Icon("folder-git", { size: 14, color: k.mutedFg })),
      title: v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().text_size(TEXT.sm).text_color(k.foreground).child(row.name))
        .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(row.path)),
      meta: h_flex().gap(8).items_center().when(Boolean(row.visibility), (e) => e.child(Chip(row.visibility))).when(row.archived, (e) => e.child(Badge("Archived", "outline"))),
      hover: this.hover,
      onClick: (_e, cx) => this.pick(cx, row.key),
      onDoubleClick: (_e, cx) => this.open(row.url, cx),
      onRightClick: () => this.menu(cx),
    });
  }

  heightOf(row) {
    if (this.tab === "activity") return row.key.startsWith("todo:") ? 48 : 52;
    if (this.tab === "mrs") return 56;
    if (this.tab === "issues") return 50;
    return 48;
  }

  rowEl(row, k) {
    if (this.tab === "activity") return row.key.startsWith("todo:") ? this.todoEl(row, k) : this.eventEl(row, k);
    if (this.tab === "mrs") return this.mrEl(row, k);
    if (this.tab === "pipelines") return this.pipelineEl(row, k);
    if (this.tab === "issues") return this.issueEl(row, k);
    return this.projectEl(row, k);
  }

  list(k) {
    const sections = this.sections();
    const out = [];
    for (const section of sections) {
      if (this.tab !== "issues") out.push(this.headerRow(section.label, section.rows.length));
      for (const row of section.rows) out.push({ height: this.heightOf(row), id: row.key, el: this.rowEl(row, k) });
    }
    if (!out.length) {
      const empty = this.emptyState(k);
      return empty;
    }
    return this.scroller.view(`gitlab-${this.tab}`, out, out.findIndex((r) => r.id === this.sel[this.tab]));
  }

  emptyState(k) {
    const data = this.data[this.tab];
    const messages = {
      activity: ["activity", "Nothing in your activity", "GitLab recorded nothing for you in its last few events."],
      mrs: ["git-merge", "No merge requests", "None of yours is open, waiting on your review or merged."],
      pipelines: ["git-branch", "No pipelines", "No pipeline ran for the projects this page reads."],
      issues: ["circle-dot", "No issues", this.data.issues?.scope === "all" ? "No open work item in the groups and projects it read." : "No work item is assigned to you. Flow falls back to every open one when there is none."],
      projects: ["folder", "No projects", "GitLab lists none among your memberships."],
    };
    const [icon, title, description] = messages[this.tab] ?? messages.activity;
    return Empty({ icon, title, description });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing: the detail beside the list

  fact(k, label, value) {
    return h_flex()
      .gap(8)
      .min_w(0)
      .items_start()
      .child(div().w(96).flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child(label))
      .child(div().flex_1().min_w(0).text_size(TEXT.sm).text_color(k.foreground).child(value === null || value === undefined || value === "" ? "—" : String(value)));
  }

  detailBody(row, d, k, cx) {
    const out = [];
    if (this.tab === "mrs") {
      out.push(h_flex().gap(6).flex_wrap().child(mrBadge(row, k)).when(Boolean(row.author), (e) => e.child(Chip(`by ${row.author}`))));
      out.push(this.fact(k, "Project", row.project));
      out.push(this.fact(k, "Branches", row.branch ? `${row.branch} → ${row.base}` : null));
      const pipeline = pipelineFor(row, this.data.pipelines?.rows ?? []);
      if (pipeline) out.push(h_flex().gap(8).items_center().child(div().w(96).flex_none().text_size(TEXT.xs).text_color(k.mutedFg).child("Pipeline")).child(pipelineBadge(pipeline.status)).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(agoText(pipeline.updatedAt ?? pipeline.createdAt))));
    } else if (this.tab === "pipelines") {
      const state = pipelineState(row.status);
      out.push(h_flex().gap(6).items_center().child(Badge(state.label, TONE[state.tone] ?? "outline", { icon: state.icon })).when(pipelineOpen(row.status), (e) => e.child(Badge("In progress", "info"))));
      out.push(this.fact(k, "Project", row.project));
      out.push(this.fact(k, "Ref", row.ref));
      out.push(this.fact(k, "Commit", row.sha ? row.sha.slice(0, 12) : null));
      out.push(this.fact(k, "Started", whenText(row.createdAt)));
    } else if (this.tab === "issues") {
      out.push(h_flex().gap(6).items_center().child(issueBadge(row)).child(Chip(row.type)));
      out.push(this.fact(k, "Reference", row.reference));
      out.push(this.fact(k, "Project", row.project));
      out.push(this.fact(k, "Updated", whenText(row.updatedAt)));
    } else if (this.tab === "projects") {
      out.push(this.fact(k, "Path", row.path));
      out.push(this.fact(k, "Group", row.group || "—"));
      out.push(this.fact(k, "Visibility", row.visibility));
    } else if (this.tab === "activity") {
      out.push(this.fact(k, "What", row.action));
      out.push(this.fact(k, "Project", row.project));
      out.push(this.fact(k, "Ref", row.ref || null));
      out.push(this.fact(k, "When", whenText(row.at) || agoText(row.at)));
    }

    if (!d) return out;
    if (d.loading) return [...out, h_flex().gap(8).items_center().text_size(TEXT.sm).text_color(k.mutedFg).child(Spinner({ size: 12 })).child("Reading it…"), ...[0, 1, 2].map(() => Skeleton({ w: 260, h: 12 }))];
    if (d.error) {
      return [
        ...out,
        h_flex().gap(8).items_start().px(10).py(8).rounded(RADIUS.md).bg(alpha(k.destructive, 0.1)).text_size(TEXT.sm).text_color(k.destructive).child(Icon("alert", { size: 14 })).child(div().flex_1().min_w(0).child(d.error)),
        Button("gitlab-detail-retry", { label: "Try again", icon: "refresh", variant: "outline", size: "sm", onClick: (_e, cx) => ((this.detail = null), this.ensureDetail(cx), cx.notify()) }),
      ];
    }
    const v = d.value;
    if (!v) return out;
    if (v.kind === "mr") {
      if (v.description) out.push(div().pt(4).text_size(TEXT.sm).text_color(k.mutedFg).child(v.description.slice(0, 3000)));
      out.push(this.fact(k, "Created", whenText(v.createdAt)));
      out.push(this.fact(k, "Updated", whenText(v.updatedAt)));
      out.push(this.fact(k, "Approvals", v.approved ? `Approved${v.approvedBy.length ? ` by ${v.approvedBy.join(", ")}` : ""}` : "Waiting"));
      if (v.pipelines.length)
        out.push(
          v_flex().gap(4).child(SectionHeader("Pipelines", { count: v.pipelines.length })).children(
            v.pipelines.map((p) =>
              h_flex()
                .gap(8)
                .items_center()
                .child(Icon(pipelineState(p.status).icon, { size: 12, color: toneColor(k, pipelineState(p.status).tone) }))
                .child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(p.ref))
                .child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(agoText(p.at))),
            ),
          ),
        );
      if (v.commits.length)
        out.push(
          v_flex().gap(4).child(SectionHeader("Commits", { count: v.commits.length })).children(
            v.commits.map((c) =>
              h_flex()
                .gap(8)
                .items_start()
                .child(Mono(c.sha, { size: TEXT.xs, color: k.dim }))
                .child(v_flex().flex_1().min_w(0).gap(1).child(div().text_size(TEXT.xs).text_color(k.foreground).child(c.title)).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child([c.author, agoText(c.at)].filter(Boolean).join(" · ")))),
            ),
          ),
        );
      if (v.notes.length)
        out.push(
          v_flex().gap(6).child(SectionHeader("Notes", { count: v.notes.length })).children(
            v.notes.map((n) =>
              v_flex()
                .gap(2)
                .p(8)
                .rounded(RADIUS.md)
                .bg(k.muted)
                .child(h_flex().gap(6).items_center().child(div().text_size(TEXT.xs).font_medium().text_color(k.foreground).child(n.author)).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(agoText(n.at))))
                .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(n.body)),
            ),
          ),
        );
    } else if (v.kind === "pipeline") {
      if (v.jobs.length)
        out.push(
          v_flex().gap(3).child(SectionHeader("Jobs", { count: v.jobs.length })).children(
            v.jobs.map((j) => {
              const s = pipelineState(j.status);
              return h_flex()
                .gap(8)
                .items_center()
                .child(Icon(s.icon, { size: 12, color: toneColor(k, s.tone) }))
                .child(div().w(56).flex_none().text_size(TEXT.xs).text_color(k.dim).child(j.stage))
                .child(div().flex_1().min_w(0).truncate().text_size(TEXT.xs).text_color(k.foreground).child(j.name));
            }),
          ),
        );
    } else if (v.kind === "issue") {
      out.push(this.fact(k, "Type", v.type));
      out.push(this.fact(k, "Created", whenText(v.createdAt)));
      if (v.confidential) out.push(Badge("Confidential", "warning"));
      if (v.description) out.push(div().pt(4).text_size(TEXT.sm).text_color(k.mutedFg).child(v.description.slice(0, 3000)));
    }
    return out;
  }

  detailPanel(k, cx) {
    const row = this.selectedRow();
    if (!row) return div();
    const d = this.detail?.key === row.key ? this.detail : null;
    return SidePanel("gitlab-detail", {
      title: row.title ?? row.name ?? "GitLab",
      description: [row.project ?? row.path, row.iid ? `!${row.iid}` : null].filter(Boolean).join(" · "),
      width: Math.min(440, Math.max(320, Math.round(this.width * 0.36))),
      children: this.detailBody(row, d, k, cx),
      footer: h_flex()
        .flex_1()
        .gap(6)
        .items_center()
        .child(Button("gitlab-detail-open", { label: "Open in GitLab", icon: "external", size: "sm", disabled: !row.url, onClick: (_e, cx) => this.open(row.url, cx) }))
        .child(div().flex_1())
        .child(Button("gitlab-detail-refresh", { icon: "refresh-cw", variant: "ghost", size: "icon-sm", tooltip: "Read this tab again  r", onClick: (_e, cx) => this.refresh(cx) })),
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing: the screen

  counts() {
    const n = (value) => (value === null || value === undefined ? undefined : value);
    const activity = this.data.activity;
    return {
      activity: activity ? activity.rows.length + (activity.todos?.length ?? 0) : undefined,
      mrs: n(this.data.mrs?.rows?.length),
      pipelines: n(this.data.pipelines?.rows?.length),
      issues: n(this.data.issues?.rows?.length),
      projects: n(this.data.projects?.rows?.length),
    };
  }

  body(k, cx) {
    if (!this.link) {
      return Empty({
        icon: "gitlab",
        iconColor: GITLAB_ORANGE,
        title: "GitLab isn't connected",
        description: "Connect your GitLab.com or self-hosted server, then Flow reads your activity, merge requests, pipelines and issues from it.",
        action: Button("gitlab-connect", { label: "Connect GitLab", icon: "link", onClick: () => openGitlabForm() }),
      });
    }
    const data = this.data[this.tab];
    if (!data) {
      return v_flex().flex_1().p(20).gap(10).children([0, 1, 2, 3, 4].map((i) => h_flex().gap(10).child(Skeleton({ w: 18, h: 18 })).child(Skeleton({ w: 240 + ((i * 83) % 260), h: 18 }))));
    }
    if (data.error && !data.rows?.length) return ErrorState({ title: "Could not read GitLab", message: data.error, onRetry: (_e, cx) => this.reload(cx, this.tab) });
    return v_flex()
      .flex_1()
      .h_full()
      .min_h(0)
      .px(14)
      .pt(8)
      .gap(8)
      .when(Boolean(data.error), (e) =>
        e.child(
          h_flex()
            .mx(6)
            .gap(8)
            .items_center()
            .px(12)
            .py(8)
            .rounded(RADIUS.md)
            .bg(alpha(k.warning, 0.12))
            .text_size(TEXT.sm)
            .text_color(k.warning)
            .child(Icon("alert", { size: 14 }))
            .child(div().flex_1().min_w(0).child(data.error)),
        ),
      )
      .child(this.list(k));
  }

  render(cx) {
    const k = tokens();
    const data = this.data[this.tab];
    const counts = this.counts();
    const failing = failedPipelines(this.data.pipelines?.rows ?? []).length;
    const read = data?.at ? ` · read ${agoText(new Date(data.at).toISOString())}` : "";
    const description = this.link ? `${this.link.host}${this.core ? ` · ${this.core.username}` : ""}${read}` : "Not connected";
    const wide = this.width >= 900;
    let root = v_flex()
      .id("gitlab")
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
      .on_mouse_down("left", () => ((this.visible = true), this.handle.focus()))
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .child(
        PageHeader({
          icon: "gitlab",
          iconColor: GITLAB_ORANGE,
          title: "GitLab",
          description,
          narrow: this.width < 980,
          aside: failing ? Badge(`${failing} failing`, "destructive", { dot: k.destructive }) : null,
          actions: [
            this.busy.size ? Spinner({ size: 14, color: k.mutedFg }) : div(),
            Button("gitlab-refresh", { label: "Refresh", icon: "refresh-cw", variant: "outline", size: "sm", kbd: "r", onClick: (_e, cx) => this.refresh(cx) }),
          ],
        }),
      )
      .child(
        h_flex()
          .px(20)
          .py(10)
          .gap(12)
          .flex_none()
          .items_center()
          .border_b_1()
          .border_color(k.border)
          .child(Tabs("gitlab-tabs", { items: TABS.map((t) => ({ value: t.id, label: t.label, icon: t.icon, count: counts[t.id] })), value: this.tab, onChange: (id, cx) => this.switchTo(id, cx) }))
          .child(div().flex_1())
          .when(Boolean(this.link), (e) => e.child(this.projectSelect(k, cx)))
          .child(SearchField(this.query, { active: this.filtering, width: Math.min(280, Math.max(160, Math.round(this.width * 0.22))) })),
      )
      .child(h_flex().flex_1().min_h(0).child(v_flex().flex_1().min_w(0).min_h(0).h_full().child(this.body(k, cx))).when(wide && Boolean(this.selectedRow()), (e) => e.child(this.detailPanel(k, cx))))
      .child(KeyHints([["1–5", "tabs"], ["j k", "move"], ["⏎", "open"], ["r", "refresh"], ["/", "filter"], ["p", "projects"], ["m", "menu"], ["esc", "clear"]]));
    const toasts = this.toasts.render();
    if (toasts) root = root.child(toasts);
    return root;
  }
}
