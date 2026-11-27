// Flow settings, built around Flow's window rather than cockpit's whole config: the layout at a glance, the three looks,
// the agents and the options Flow's screens act on, the data sources, and the doctor's checks with their fixes. Every
// other cockpit option stays under Advanced, saved through the hub (`act options set`). It also makes the "Getting
// started" checklist for the empty states; a confirmed fix runs the doctor's own command or action through the hub
// (`act doctor fix`, or `act doctor fix_all` for Fix all), never one this sends.

import { div, image } from "gpui-kit";
import * as base from "gpui-base";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, shared, setShared, openOverlay, closeOverlay, notify, run, updates } from "herdr";
import * as hub from "./hub.js";
import { MOVE_FIRST } from "./person.js";
import { openInEditor, editorLabel } from "./editor.js";
import { versions, checkNow, versionLine, openUpdate } from "./update.js";
import { shownLayout } from "./screens.js";
import { openGitlabForm, readGitlab, GITLAB_SHARED } from "./gitlab-form.js";
import { SECTIONS } from "./gitlab.js";
import { tokens, alpha, TEXT, RADIUS, Icon, Kbd, Button, Badge, Skeleton, Spinner, Toaster, Mono, AlertDialog, Toggle, AgentLogo, Pills, TextField, viewport } from "./ui.js";
import { THREADS } from "./threads.js";

// A Herdr without ScrollHandle still draws the sheet; j/k then move without scrolling.
const ScrollHandle = base.ScrollHandle ?? null;
/** How many checks fail in the last report read, shared so every sidebar and drawer redraws its link. */
const FAILING = "flow.doctor.failing";

/** The categories of checks, in the order the sheet lists them. */
const CATEGORIES = {
  tools: "Tools and config",
  install: "Install",
  app: "Herdr app",
  agents: "Agents",
  claude: "Claude Code plugin",
  sessions: "Sessions",
  sources: "Sources",
  connectors: "Connectors",
  rules: "Permission rules",
  spaces: "Spaces",
  notifications: "Notifications",
  browser: "Browser for E2E tests",
};
/** What an agent can do, as the Agents tab says it: the report's key, its word, and a tooltip where the word needs one. */
const CAN = [["start", "start"], ["resume", "resume"], ["fork", "fork"], ["headless", "headless"], ["driven", "driven", "cockpit can run it itself, without a terminal"]];

/** The doctor's report, `--cached` for one under ten minutes old; throws when it does not run. */
export async function loadDoctor({ cached = false } = {}) {
  const r = await hub.cockpit(["doctor", "--json", ...(cached ? ["--cached"] : [])]);
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error((r.stderr || r.stdout || "cockpit doctor did not answer").trim().split("\n")[0]);
  }
  const failing = report?.summary?.fail ?? 0;
  if (shared(FAILING) !== failing) setShared(FAILING, failing);
  return report;
}

/** How long after a fix's question opens its confirm takes a click. */
const CONFIRM_AFTER_MS = 400;

/** How long a file read may take, and a whole run of the checks, before the sheet stops waiting for it. */
const READ_MS = 10_000;
const CHECKS_MS = 90_000;

/** The tabs in order, by their number key: Flow's own, then the cockpit options it uses, then everything else. */
const TABS = ["flow", "look", "agents", "work", "data", "health", "advanced"];

/** The left rail: what each tab is for, in the order it lists them. */
const NAV = [
  { id: "flow", label: "Flow", icon: "layout-dashboard", hint: "The window at a glance" },
  { id: "look", label: "Look", icon: "palette", hint: "Flow, Mist and Daylight" },
  { id: "agents", label: "Agents", icon: "bot", hint: "Who runs, and how they are named" },
  { id: "work", label: "Work", icon: "workflow", hint: "Threads, prompts, briefs and apps" },
  { id: "data", label: "Data", icon: "server", hint: "GitHub, CI, GitLab and the rest" },
  { id: "health", label: "Health", icon: "shield-check", hint: "Checks, fixes and getting started" },
  { id: "advanced", label: "Advanced", icon: "sliders-horizontal", hint: "Cockpit options Flow does not use" },
];

/** The Flow layout the Look tab offers, with what it is for in a few plain lines and the colours that set it apart. */
export const LAYOUT_CHOICES = [
  {
    name: "flow",
    title: "Flow",
    tagline: "Flow's own teal",
    colors: { dark: ["#0c1012", "#5fd4c4", "#7fb2f0"], light: ["#efede7", "#0f8576", "#2f67b5"] },
    points: [
      "One bar across the top: your tabs, the search and the bell",
      "Your agents' terminals as soft cards, review and runbooks beside them",
      "A sidebar under the bar with your quotas, Needs you and every agent and space",
      "Flow's own teal theme, light and dark, with Geist type",
    ],
  },
  {
    name: "flow-mist",
    title: "Mist",
    tagline: "Cool lavender, lit from above",
    colors: { dark: ["#0d0d15", "#9c9fff", "#8f96e0"], light: ["#ebebf2", "#5a5de6", "#6a74b8"] },
    points: [
      "Flow with cool lavender greys and a periwinkle accent",
      "Cards float on a sky lit from above, with no bands for the bars",
      "Peach marks an agent that needs you",
    ],
  },
  {
    name: "flow-daylight",
    title: "Daylight",
    tagline: "A sky that follows your agents",
    colors: { dark: ["#1c2257", "#b9c4ff", "#8e9ae8"], light: ["#f1f4fa", "#4a5bd6", "#5a72c0"] },
    points: [
      "Flow under a sky that follows your agents",
      "Night while they work, a clear blue day in light mode",
      "Dawn rises from the bottom edge while one waits on you",
    ],
  },
];

/** The option keys each Flow tab shows, in the order it lists them: what Flow's own screens act on. */
const GROUPS = {
  agents: [
    { id: "default", icon: "bot", title: "The agent cockpit starts", description: "The agent Start work, a routine or a one-off job starts when nothing else says which.", keys: ["agents.default"] },
    { id: "names", icon: "sparkles", title: "Names and links", description: "How agents, tabs and spaces are named, and whether their branch names carry links too.", keys: ["names", "links.fromBranch"] },
    { id: "pace", icon: "gauge", title: "The 7-day quota", description: "Where the pace tick on the usage bars stands.", keys: ["agents.pace"] },
  ],
  work: [
    { id: "queue", icon: "send", title: "Queue and CI", description: "What happens to a queued prompt, and what CI tells the agent that caused it.", keys: ["queue.drain", "ci.tellAgents", "github.reviewBots"] },
    {
      id: "notifications",
      icon: "bell",
      title: "Notifications",
      description: "When Flow calls you: in the app, for a release, or on the Dock.",
      keys: ["notifications", "monitor.notify", "dockBadge"],
    },
    {
      id: "briefs",
      icon: "newspaper",
      title: "Briefs and recaps",
      description: "The morning brief, the recap when you come back, meeting briefs and the check after a deploy.",
      keys: ["brief.enabled", "brief.at", "brief.weekends", "recap.enabled", "recap.awayMinutes", "agents.recap", "meetingBrief.enabled", "meetingBrief.model", "deployWatch.enabled", "deployWatch.afterMinutes"],
    },
    {
      id: "apps",
      icon: "app-window",
      title: "Apps and the browser",
      description: "Rows, your editor, links clicked in a terminal, and the browser beside an agent.",
      keys: ["density", "editor", "e2eBrowser", "browserIdleMinutes", "sideBrowser", "links.open", "browser.dock", "browser.profileScope", "browser.popups", "browser.downloads"],
    },
  ],
  data: [
    { id: "github", icon: "git-pull-request", title: "GitHub", description: "Your pull requests and the reviews asked of you, read through gh.", keys: ["github.enabled", "github.org"] },
    { id: "ci", icon: "workflow", title: "CI and background reads", description: "The CI runs of your pull requests, and the session that reads what the hub cannot.", keys: ["ci.enabled", "fetcher"] },
    {
      id: "refresh",
      icon: "refresh-cw",
      title: "Refresh",
      description: "How often each source is read. A shorter wait spends more of your rate limits.",
      keys: ["refresh.github", "refresh.tickets", "refresh.ci", "refresh.mail", "refresh.calendar", "refresh.platform", "refresh.monitor"],
    },
  ],
};

/** The options the Flow tabs above show, so Advanced can keep every other cockpit option in one place. */
const PLACED = new Set(Object.values(GROUPS).flatMap((groups) => groups.flatMap((g) => g.keys)));

/** A tab by the name a caller gives it; cockpit's older names still open their Flow tab. */
const tabOf = (name) =>
  TABS.includes(name) ? name : name === "layout" || name === "look" ? "look" : name === "options" || name === "work" ? "work" : name === "sources" || name === "data" ? "data" : name === "problems" || name === "all" || name === "health" ? "health" : null;

/** The size the layout pictures are saved at, for their height at any width. */
const PICTURE = { w: 800, h: 512 };

/** Whether a theme colour is dark: its luminance under one half; a colour it cannot read counts as dark. */
export function isDark(color) {
  const hex = /^#([0-9a-f]{6})/i.exec(String(color ?? ""))?.[1];
  if (!hex) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** A layout's picture for the window's theme, as `image()` takes it from the Herdr app's home. */
export const layoutPicture = (name, dark) => `mods/flow/layouts/${name}-${dark ? "dark" : "light"}.png`;

/** The sheet's width: 860 px, or the window's width less a margin on each side when it is narrower. */
export const sheetWidth = (window = viewport()) => (window?.width ? Math.max(320, Math.min(860, Math.floor(window.width) - 32)) : 860);

/**
 * Opens Flow settings: a window over the cockpit, on `tab` when given (flow, look, agents, work, data, health,
 * advanced). `person` when the person's click, key or palette pick opened it: what it shows counts as seen at once.
 */
export function openSettings({ tab = null, person = false } = {}) {
  openOverlay({ mod: "flow", kind: "window", key: "flow-settings", width: sheetWidth(), height: 0.86, props: { app: "settings", tab, person: Boolean(person) } });
}

/**
 * A quiet row that opens Flow settings, with how many checks fail when a report was read: the sidebar's and the
 * drawer's. It opens on Health while a check fails, the tab its count is about. `rail` keeps the icon alone.
 */
/** The Herdr app's own Settings (a dot when an update waits) and Add machine, as rows under Flow settings. */
export function HerdrLinks(id, { rail = false } = {}) {
  const k = tokens();
  let ready = false;
  try {
    ready = Boolean(updates()?.app?.ready);
  } catch {}
  const row = (key, icon, label, dim, action, extra = null) => {
    const e = h_flex()
      .id(`${id}-${key}`)
      .h(28)
      .gap(8)
      .flex_none()
      .items_center()
      .rounded(RADIUS.md)
      .cursor_pointer()
      .text_color(dim ? k.dim : k.mutedFg)
      .hover((s) => s.bg(k.accent).text_color(k.foreground))
      .on_click(action)
      .child(Icon(icon, { size: 14 }));
    if (rail) return e.relative().justify_center().tooltip(label).when(Boolean(extra), (x) => x.child(div().absolute().top(5).right(6).child(extra)));
    return e.px(8).child(div().flex_1().truncate().text_size(TEXT.sm).child(label)).when(Boolean(extra), (x) => x.child(extra));
  };
  return v_flex()
    .gap(2)
    .child(row("settings", "settings", "Settings", false, () => run("app.settings"), ready ? div().size(6).rounded_full().bg(k.ring) : null))
    .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
}

export function SettingsLink(id, { rail = false } = {}) {
  // A remote desk reads another machine: its settings and checks are that machine's.
  if (hub.remoteMachine()) return div();
  const k = tokens();
  const failing = Number(shared(FAILING) ?? 0);
  const tip = `Flow settings${failing ? `: ${failing} failing` : ""}`;
  const row = h_flex()
    .id(id)
    .h(28)
    .gap(8)
    .flex_none()
    .items_center()
    .rounded(RADIUS.md)
    .cursor_pointer()
    .text_color(k.mutedFg)
    .hover((s) => s.bg(k.accent).text_color(k.foreground))
    .on_click(() => openSettings({ tab: failing ? "health" : null, person: true }))
    .tooltip(`${tip}  ⌘⇧P, then Flow settings`)
    .child(Icon("sliders-horizontal", { size: 14, color: failing ? k.destructive : undefined }));
  if (rail) return row.justify_center();
  return row
    .px(8)
    .child(div().flex_1().truncate().text_size(TEXT.sm).child("Flow settings"))
    .when(failing > 0, (e) => e.child(div().text_size(TEXT.xs).font_medium().text_color(k.destructive).child(`${failing} failing`)));
}

/** The steps not done yet, in order. */
export const toDo = (report) => (report?.getting_started ?? []).filter((s) => !s.done);

/** What a fix runs, for its button: "Fix" when the hub can, null when it only says what to do. */
export const fixVerb = (fix) => (fix?.act ? "Fix" : fix?.command ? "Run" : null);

/** The check a fix goes through: a step names its own (null when no check says it), a check is itself. */
const checkOf = (item) => ("check" in item ? item.check : item.id);

/** Whether the hub can run this item's fix: a check of the report with a command or an action. */
export const runnable = (item) => Boolean(fixVerb(item?.fix) && checkOf(item));

/** A fix as the person saw it, as the hub compares it: its command, or `app action [args]`. */
export const shownFix = (fix) => fix?.command ?? `${fix?.act?.app ?? ""} ${fix?.act?.action ?? ""} ${JSON.stringify(fix?.act?.args ?? [])}`;

/** The hub actions a fix may name, in plain words. */
const ACTION_WORDS = {
  "sources refresh": () => "Reads every source again now.",
  "sources sign_in": (args) => `Opens the sign-in to ${args?.[0] ?? "that source"} in a tab of the actions space.`,
};

/** The question before a fix runs: `{title, description, confirm}`. */
export function fixQuestion(item) {
  const fix = item.fix ?? {};
  if (fix.act) {
    const words = ACTION_WORDS[`${fix.act.app} ${fix.act.action}`];
    return { title: "Fix it?", description: words ? words(fix.act.args) : `Runs ${fix.act.app} ${fix.act.action}.`, confirm: "Fix" };
  }
  return { title: "Run this command?", description: `${fix.command} runs in a tab of the actions space, where you can watch it.`, confirm: "Run" };
}

/**
 * Runs a confirmed fix through the hub, naming the report it was shown in (`report.at`) and the fix as shown, so the hub
 * runs that one or nothing; copies what it says when nothing runs it. The outcome is `toasts`' toast, and `done(cx)`
 * follows once the hub took it.
 */
export function runFix(item, report, cx, toasts, done) {
  const fix = item.fix;
  if (!runnable(item)) {
    const words = fix?.command ?? fix?.label;
    if (words) {
      cx.write_to_clipboard(words);
      toasts?.push(cx, "Copied what to do", { kind: "info", description: words });
    }
    return;
  }
  cx.spawn(async (cx) => {
    try {
      const r = await hub.act("doctor", "fix", [checkOf(item), report?.at ?? 0, shownFix(fix)]);
      toasts?.push(cx, r.error || r.note || "Fixing", { kind: r.error ? "error" : "info" });
      if (!r.error) done?.(cx);
    } catch (e) {
      toasts?.push(cx, String(e?.message ?? e), { kind: "error" });
    }
  });
}

/**
 * What Fix all would run, from the report shown: `items`, the checks that need a look and whose fix the hub can run,
 * and `left`, how many others need the person.
 */
export function fixAll(report) {
  const needs = (report?.checks ?? []).filter((c) => c.status !== "pass");
  const items = needs.filter(runnable);
  return { items, left: needs.length - items.length };
}

/** Fix all's confirm, one line per fix: `{command}` for a command, `{text}` for an action in plain words. */
export const fixAllLines = (items) => items.map((item) => (item.fix?.act ? { text: fixQuestion(item).description } : { command: item.fix.command, text: "runs in a tab of the actions space" }));

/**
 * Runs the confirmed fixes in one go through the hub, naming the report they were shown in, so the hub runs them all as
 * shown or none. Its toast says how many were fixed and failed, each fix's line under it; `done(cx)` follows once any ran.
 */
export function runFixAll(items, report, cx, toasts, done) {
  cx.spawn(async (cx) => {
    try {
      const r = await hub.act("doctor", "fix_all", [report?.at ?? 0, items.map((item) => [checkOf(item), shownFix(item.fix)])]);
      const [title, ...lines] = String(r.error || r.note || "Fixing").split("\n");
      toasts?.push(cx, title, { kind: r.error ? "error" : "info", description: lines.join("\n") || undefined, ms: 10_000 });
      if (!r.error) done?.(cx);
    } catch (e) {
      toasts?.push(cx, String(e?.message ?? e), { kind: "error" });
    }
  });
}

/** Fix all's question: a line per fix, commands in mono, then how many others need the person. */
function fixAllQuestion(items, left) {
  const k = tokens();
  const line = (l, i) =>
    h_flex()
      .id(`fix-all-line-${i}`)
      .gap(6)
      .min_w(0)
      .items_center()
      .when(Boolean(l.command), (e) => e.child(div().id(`fix-all-command-${i}`).min_w(0).flex_shrink(1).truncate().font_family("JetBrains Mono").text_size(TEXT.xs).text_color(k.foreground).tooltip(l.command).child(l.command)))
      .child(l.command ? div().flex_none().text_size(TEXT.sm).text_color(k.mutedFg).child(l.text) : div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).text_color(k.foreground).child(l.text));
  return {
    title: `Run these ${items.length} fixes?`,
    description: v_flex()
      .gap(6)
      .pt(4)
      .children(fixAllLines(items).map(line))
      .when(left > 0, (e) => e.child(div().pt(4).text_size(TEXT.sm).text_color(k.mutedFg).child(`${left} more need${left === 1 ? "s" : ""} you: see below`))),
    confirm: "Fix all",
  };
}

/** The confirm before a fix or Fix all, as an AlertDialog. */
function fixConfirm(id, asking, { onConfirm, onCancel }) {
  const q = asking.items ? fixAllQuestion(asking.items, asking.left) : fixQuestion(asking.item);
  const ask = { title: q.title, description: q.description, confirmLabel: q.confirm, onConfirm, onCancel };
  // A click answers it: ⏎ does not, so its key is not drawn.
  return AlertDialog(id, { ...ask, confirmKbd: null });
}

const statusIcon = (status) => (status === "pass" ? "circle-check" : status === "fail" ? "circle-x" : "triangle-alert");
const statusColor = (k, status) => (status === "pass" ? k.success : status === "fail" ? k.destructive : k.warning);

/** One step of getting started: done or not, and its fix beside it, or the question before it runs. */
function stepRow(k, step, { onFix, compact, asking, onConfirm, onCancel }) {
  const fix = step.fix;
  if (asking === step.id) {
    const q = fixQuestion(step);
    return h_flex()
      .id(`start-${step.id}`)
      .gap(8)
      .min_h(compact ? 28 : 32)
      .items_center()
      .child(Icon("circle-dashed", { size: 15, color: k.mutedFg }))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.foreground).child(q.description))
      .child(Button(`start-cancel-${step.id}`, { label: "Cancel", variant: "ghost", size: "sm", onClick: (_e, cx) => onCancel(cx) }))
      .child(Button(`start-ok-${step.id}`, { label: q.confirm, size: "sm", variant: "outline", onClick: (_e, cx) => onConfirm(step, cx) }));
  }
  return h_flex()
    .id(`start-${step.id}`)
    .gap(10)
    .min_h(compact ? 28 : 32)
    .items_center()
    .child(Icon(step.done ? "circle-check" : "circle-dashed", { size: 15, color: step.done ? statusColor(k, "pass") : k.mutedFg }))
    .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(step.done ? k.mutedFg : k.foreground).when(step.done, (e) => e.line_through()).child(step.label))
    .when(!step.done && Boolean(fix), (e) =>
      e.child(
        Button(`start-fix-${step.id}`, {
          label: runnable(step) ? fixVerb(fix) : "Copy",
          icon: runnable(step) ? "play" : "copy",
          size: "sm",
          variant: "outline",
          tooltip: fix.command ?? fix.label,
          onClick: (_e, cx) => onFix(step, cx),
        }),
      ),
    );
}

/**
 * The "Getting started" checklist of a doctor report: each step done or not, with its fix; null when every step is
 * done. `onFix(step, cx)` asks before a step's fix runs; `asking` is the step being asked about, which `onConfirm(step,
 * cx)` runs and `onCancel(cx)` leaves.
 */
export function StartedList(report, { onFix, compact = false, title = "Getting started", asking = null, onConfirm, onCancel } = {}) {
  const steps = report?.getting_started ?? [];
  const left = steps.filter((s) => !s.done).length;
  if (!steps.length || !left) return null;
  const k = tokens();
  return v_flex()
    .id("getting-started")
    .w_full()
    .max_w(compact ? 520 : 640)
    .gap(4)
    .p(compact ? 14 : 16)
    .rounded(RADIUS.lg)
    .border_1()
    .border_color(k.border)
    .bg(k.card)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .pb(4)
        .child(div().flex_1().text_size(TEXT.base).font_semibold().text_color(k.foreground).child(title))
        .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(`${steps.length - left} of ${steps.length} done`)),
    )
    .children(steps.map((s) => stepRow(k, s, { onFix, compact, asking, onConfirm, onCancel })));
}

/**
 * A self-contained "Getting started" for an empty state: once the empty state shows it reads the kept doctor report (or
 * runs one), then draws `StartedList`, or nothing when every step is done. Make it in `init`, call `want(cx)` from
 * `render` while the empty state shows, and draw `el()` there: `this.started = new Started()` …
 * `this.started.want(cx)` … `this.started.el({ compact: true })`.
 */
export class Started {
  constructor() {
    this.report = null;
    this.loading = false;
    this.loaded = false;
    /** The step asked about, with the report it was shown from. */
    this.asking = null;
    this.toasts = new Toaster();
  }

  /** Reads the report the first time the empty state shows, and again after a fix (`cached: false`). */
  want(cx, { cached = true } = {}) {
    if (this.loading || (this.loaded && cached)) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.report = await loadDoctor({ cached });
      } catch {
        this.report = null;
      }
      // A question asked from another report is not this one's.
      if (this.asking && this.asking.at !== this.report?.at) this.asking = null;
      this.loading = false;
      this.loaded = true;
      cx.notify();
    });
  }

  /** The checklist, with this component's own toasts, or null. */
  el({ compact = true, title } = {}) {
    const list = StartedList(this.report, {
      compact,
      title,
      asking: this.asking?.step.id ?? null,
      onFix: (step, cx) => {
        if (!runnable(step)) return runFix(step, this.report, cx, this.toasts);
        this.asking = { step, at: this.report?.at };
        cx.notify();
      },
      onCancel: (cx) => ((this.asking = null), cx.notify()),
      onConfirm: (_step, cx) => {
        const { step, at } = this.asking ?? {};
        this.asking = null;
        // An action is done when the hub answers: read again; a command runs on in its tab, the list waits.
        if (step) runFix(step, { at }, cx, this.toasts, (cx) => (step.fix?.act ? this.want(cx, { cached: false }) : null));
        cx.notify();
      },
    });
    if (!list) return null;
    const toasts = this.toasts.render();
    return toasts ? div().relative().w_full().child(list).child(toasts) : list;
  }
}

/** A heading over a group of rows: a category of checks, a section of options. */
function heading(k, id, text, spaced) {
  return div().id(id).pt(spaced ? 14 : 0).pb(2).text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child(String(text).toUpperCase());
}

/** An option's value in words, as its toast and its default line say it: on, a choice's name, a number with its unit. */
export function optionWords(o, value = o.value) {
  if (o.kind === "toggle" || o.kind === undefined) return value ? "on" : "off";
  if (o.kind === "choice") return (o.choices ?? []).find((c) => c.value === value)?.label ?? String(value ?? "");
  if (o.kind === "number") return `${value}${o.unit ? ` ${o.unit}` : ""}`;
  return value === "" || value === null || value === undefined ? (o.blank ?? "empty") : String(value);
}

/** What a field's text is sent as: a whole number for a number field, else the text; the hub checks either. */
export const typedValue = (o, text) => (o.kind === "number" && /^-?\d+$/.test(String(text).trim()) ? Number(String(text).trim()) : String(text));

/** The next value of a choice (the one before with -1), going round. */
export function turned(o, by = 1) {
  const values = (o.choices ?? []).map((c) => c.value);
  if (!values.length) return o.value;
  const at = Math.max(0, values.indexOf(o.value));
  return values[(at + by + values.length) % values.length];
}

/** The sections of an options view in its order, each with its options and their place in the whole list. */
export function sectioned(view) {
  const options = view?.options ?? [];
  const names = [...(view?.sections ?? []), ...options.map((o) => o.section ?? "Options")].filter((name, i, all) => all.indexOf(name) === i);
  return names.map((title) => ({ title, rows: options.map((o, i) => [o, i]).filter(([o]) => (o.section ?? "Options") === title) })).filter((s) => s.rows.length > 0);
}

export default class Settings {
  init(p, cx) {
    this.p = p ?? props() ?? {};
    this.report = null;
    this.error = null;
    this.running = false;
    this.tab = tabOf(this.p.tab) ?? "flow";
    /** Health lists every check, not only the ones that need a look. */
    this.all = this.p.tab === "all";
    this.at = 0;
    /** The hub's `options` view, its options, and the one selected among them. */
    this.view = null;
    this.options = null;
    this.optionAt = 0;
    /** What the window's link to the hub says: connecting, live, or "error: …" with the reason. */
    this.hubState = "connecting";
    this.starting = false;
    /** The options being saved, why one was not, and each field's input with what was typed in it. */
    this.saving = new Set();
    this.errors = {};
    this.fields = new Map();
    this.drafts = {};
    this.field = null;
    /** What runs and what is published, and whether a check asked for is under way. */
    this.v = null;
    this.checking = false;
    this.editor = "your editor";
    /** The fix asked about, with the report it was shown from. */
    this.asking = null;
    /** A command a fix typed into a tab runs on: the sheet keeps its report until checked again. */
    this.fixing = null;
    this.rowAt = {};
    // Any local process can open the sheet (`flow.settings`): ⏎ and space set or run nothing until the person
    // moves in it (j/k) or clicks in it.
    this.pointed = true;
    /** The person opened the sheet or acted in it: from then on what it shows counts as seen. */
    this.person = Boolean(this.p.person);
    this.toasts = new Toaster();
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.scroll = ScrollHandle ? ScrollHandle.new() : null;
    this.check(cx, true);
    this.follow(cx);
    this.readVersions(cx);
    // What config.json says of GitLab, shared so the card shows it; the dialog shares it again when it changes.
    void readGitlab();
  }

  /** Follows the hub's `options` view for as long as the sheet is open, and what the link to the hub says. */
  follow(cx) {
    this.sub = hub.subscribe(
      cx,
      { views: ["options"] },
      (m, cx) => {
        if (m.view !== "options") return;
        this.adopt(m.value);
        cx.notify();
      },
      (state, cx) => {
        this.hubState = state;
        cx.notify();
      },
    );
  }

  /**
   * The versions as the files say them, with no look at what is published, and the editor's name for its button. A read
   * the window never answers (one made while a layout switches) is given up and made again.
   */
  readVersions(cx) {
    cx.spawn(async (cx) => {
      for (let tries = 0; tries < 3 && !this.v; tries++) this.v = await hub.within(cx, versions(), READ_MS, "the versions").catch(() => null);
      cx.notify();
      this.editor = await hub.within(cx, editorLabel(), READ_MS, "the editor's name").catch(() => this.editor);
      cx.notify();
    });
  }

  /** One click or `u`: asks the hub to look at what is published now, and shows what it found or why it failed. */
  checkUpdates(cx) {
    if (this.checking) return;
    this.checking = true;
    cx.notify();
    cx.spawn(async (cx) => {
      this.v = await checkNow(cx);
      this.checking = false;
      cx.notify();
    });
  }

  /** Whether what is typed in an option's field differs from its value. */
  dirty(o, value = o.value) {
    const draft = this.drafts[o.key];
    return draft !== undefined && draft !== String(value ?? "");
  }

  /** The options a tab lists, in its own order: the curated groups, or every option Advanced keeps. */
  optionList(tab = this.tab) {
    const all = this.options ?? [];
    if (tab === "advanced") return all.filter((o) => !PLACED.has(o.key));
    const groups = GROUPS[tab];
    if (!groups) return [];
    const order = groups.flatMap((g) => g.keys);
    return order.map((key) => all.find((o) => o.key === key)).filter(Boolean);
  }

  /** Selects an option and brings its card into view; the cursor is the option's place in the whole list. */
  selectOption(o) {
    const at = (this.options ?? []).findIndex((x) => x.key === o?.key);
    if (at < 0) return;
    this.optionAt = at;
    const row = this.rowAt[`option:${o.key}`];
    if (row !== undefined) this.scroll?.scroll_to_item(row);
  }

  /** A text or number option's input, on its value: typing notes a draft, ⏎ saves it. */
  fieldFor(o) {
    const state = InputState.new({ placeholder: o.kind === "number" ? String(o.default ?? "") : (o.blank ?? ""), value: String(o.value ?? "") });
    state.on("change", (_e, cx) => {
      this.drafts[o.key] = state.value();
      delete this.errors[o.key];
      cx?.notify?.();
    });
    state.on("submit", (_e, cx) => this.commit(o.key, cx));
    // The keyboard gets into a field by the person's click, or their ⏎ on its row.
    state.on("focus", (_e, cx) => {
      this.field = o.key;
      this.pointed = false;
      const at = (this.options ?? []).findIndex((x) => x.key === o.key);
      if (at >= 0) this.optionAt = at;
      cx?.notify?.();
    });
    state.on("blur", (_e, cx) => {
      if (this.field === o.key) this.field = null;
      cx?.notify?.();
    });
    return state;
  }

  /**
   * Takes the hub's view. A field shows its option's new value unless the person is typing in it or left a draft
   * there; `settled` names an option just saved, whose field takes the value as the hub wrote it.
   */
  adopt(view, settled = null) {
    if (!view || view.error) return;
    const before = new Map((this.options ?? []).map((o) => [o.key, o.value]));
    this.view = view;
    this.options = view.options ?? [];
    for (const o of this.options) {
      if (o.kind !== "text" && o.kind !== "number") continue;
      const shown = String(o.value ?? "");
      const state = this.fields.get(o.key);
      if (!state) this.fields.set(o.key, this.fieldFor(o));
      else if (settled === o.key || (this.field !== o.key && !this.dirty(o, before.get(o.key)))) {
        if (state.value() !== shown) state.set_value(shown);
        delete this.drafts[o.key];
      }
    }
    this.optionAt = Math.min(this.optionAt, Math.max(0, this.options.length - 1));
    const visible = this.optionList();
    if (visible.length && !visible.some((o) => this.options.indexOf(o) === this.optionAt)) this.optionAt = this.options.indexOf(visible[0]);
    this.seenShown();
  }

  /**
   * The options tab in front, opened or acted in by the person: what it lists is noted as seen, and keeps its "new"
   * marks while the sheet is open. A sheet a bare command opened notes nothing.
   */
  seenShown() {
    const unseen = this.optionList().filter((o) => !o.seen && !this.noted?.has(o.key)).map((o) => o.key);
    if (!this.person || !unseen.length) return;
    this.noted = new Set([...(this.noted ?? []), ...unseen]);
    hub.act("options", "shown", [{ keys: unseen }]).catch(() => {});
  }

  /** An option of the list shown with some of it changed. */
  patch(key, change) {
    this.options = (this.options ?? []).map((x) => (x.key === key ? { ...x, ...change } : x));
  }

  /**
   * One option set through the hub, from a click or the person's own key. It shows at once; a save the hub refuses puts
   * it back and says why under it; a saved one says so in a toast that takes it back.
   */
  setOption(o, value, cx, { undo = true } = {}) {
    if (!o || o.by_hand || this.saving.has(o.key)) return;
    const before = o.value;
    this.saving.add(o.key);
    delete this.errors[o.key];
    this.patch(o.key, { value });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hub.act("options", "set", [{ [o.key]: value }], cx);
        if (r?.unknown) throw new Error("this cockpit's hub cannot save options: update it first");
        if (r?.error) throw new Error(r.error);
        // The value as the hub wrote it (a time comes back as 08:05), and the field with it.
        const view = await hub.view("options").catch(() => null);
        if (view && !view.error) this.adopt(view, o.key);
        else this.fields.get(o.key)?.set_value(String(value));
        delete this.drafts[o.key];
        const now = (this.options ?? []).find((x) => x.key === o.key) ?? { ...o, value };
        this.toasts.push(cx, `${o.title}: ${optionWords(now)}`, {
          kind: "success",
          ms: 8000,
          action: undo ? { label: "Undo", onClick: (_e, cx) => this.setOption(now, before, cx, { undo: false }) } : undefined,
        });
      } catch (e) {
        this.patch(o.key, { value: before });
        this.errors[o.key] = String(e?.message ?? e).replace(/^set: /, "");
        // Why it was not saved shows under the option: it comes into view.
        this.selectOption((this.options ?? []).find((x) => x.key === o.key) ?? o);
      }
      this.saving.delete(o.key);
      cx.notify();
    });
  }

  /** What is typed in an option's field, saved when it differs from its value. */
  commit(key, cx) {
    const o = (this.options ?? []).find((x) => x.key === key);
    const state = this.fields.get(key);
    if (!o || !state) return;
    const text = state.value();
    if (text === String(o.value ?? "")) return;
    this.setOption(o, typedValue(o, text), cx);
  }

  /** A field's text back to its option's value, and the keyboard back to the sheet. */
  leaveField(cx) {
    const key = this.field;
    const o = (this.options ?? []).find((x) => x.key === key);
    if (o) this.fields.get(key)?.set_value(String(o.value ?? ""));
    delete this.drafts[key];
    delete this.errors[key];
    this.field = null;
    this.handle.focus();
    cx.notify();
  }

  /** The selected option's key: a switch flips, a choice takes its next value, ⏎ puts the keyboard in a field. */
  press(o, s, cx) {
    if (!o || o.by_hand) return;
    if (o.kind === "toggle") this.setOption(o, !o.value, cx);
    else if (o.kind === "choice") this.setOption(o, turned(o), cx);
    else if (s === "enter" && this.fields.get(o.key)) {
      this.field = o.key;
      this.fields.get(o.key).focus();
    }
  }

  /** Selects the `at`-th option and scrolls it into view; the last one brings what only config.json holds with it. */
  pick(at) {
    this.optionAt = at;
    const last = at === (this.options?.length ?? 0) - 1 && this.rowAt.end !== undefined;
    const row = last ? this.rowAt.end : this.rowAt[`option:${this.options?.[at]?.key}`];
    if (row !== undefined) this.scroll?.scroll_to_item(row);
  }

  /** config.json in the person's editor, as Open in editor opens a folder. */
  openFile(cx) {
    cx.spawn(async (cx) => {
      try {
        const path = this.view?.path ?? `${(await hub.install()).home}/.config/cockpit/config.json`;
        const failed = await openInEditor(path);
        if (failed) this.toasts.push(cx, "config.json did not open", { kind: "error", description: failed });
        else this.toasts.push(cx, `Opened config.json in ${this.editor}`, { kind: "info", description: path });
      } catch (e) {
        this.toasts.push(cx, "config.json did not open", { kind: "error", description: String(e?.message ?? e) });
      }
    });
  }

  /** Start it: the hub started by the person's click, a stopped one too; the sheet's link finds it by itself. */
  startHub(cx) {
    if (this.starting) return;
    this.starting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await hub.startHub({ explicit: true, cx });
      } catch (e) {
        this.toasts.push(cx, "The hub did not start", { kind: "error", description: String(e?.message ?? e), ms: 8000 });
      }
      this.starting = false;
      cx.notify();
    });
  }

  /** The person's own key or click in the sheet: from then on what it shows counts as seen. */
  acted() {
    if (this.person) return;
    this.person = true;
    this.seenShown();
  }

  /** Shows a tab from its top, j/k starting there; ⏎ and space wait again for a move or a click on a row of it. */
  show(tab) {
    const next = tabOf(tab) ?? this.tab;
    if (next !== this.tab) {
      this.scroll?.scroll_to_item(0);
      this.pointed = true;
    }
    this.tab = next;
    this.at = 0;
    const visible = this.optionList();
    if (visible.length && !visible.some((o) => this.options.indexOf(o) === this.optionAt)) this.optionAt = this.options.indexOf(visible[0]);
    this.seenShown();
  }

  /** Reads the kept report first when it is recent, then runs every check again; a run already going is enough. */
  check(cx, firstCached = false) {
    if (this.running) return;
    this.running = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (firstCached && !this.report) {
          this.report = await hub.within(cx, loadDoctor({ cached: true }), READ_MS, "cockpit doctor").catch(() => null);
          cx.notify();
        }
        this.report = await hub.within(cx, loadDoctor(), CHECKS_MS, "cockpit doctor");
        this.error = null;
        this.fixing = null;
        // A question asked from another report is not this one's: it closes, and the new checks say what is left.
        if (this.asking && this.asking.at !== this.report?.at) {
          this.asking = null;
          this.toasts.push(cx, "The checks ran again: look again", { kind: "info" });
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.running = false;
      cx.notify();
    });
  }

  /** The sheet closed by the person: esc or its close button. */
  dismiss() {
    closeOverlay(props()?.overlay);
  }

  /** The sheet went: its link to the hub stops. */
  close() {
    this.sub?.stop();
    this.scroll?.release();
  }

  /** Asks once before every fix the hub can run, from the report shown; nothing when fewer than two. */
  askAll(cx) {
    const { items, left } = fixAll(this.report);
    if (items.length < 2) return;
    this.asking = { items, left, at: this.report?.at, opened: Date.now() };
    cx.notify();
  }

  /** Asks before `item`'s fix runs, from the report shown; a fix in words is copied at once. */
  ask(item, cx) {
    if (!runnable(item)) return runFix(item, this.report, cx, this.toasts);
    this.asking = { item, at: this.report?.at, opened: Date.now() };
    cx.notify();
  }

  /**
   * The asked fix, run as it was shown. An action is done when the hub answers, so the checks run again; a command
   * runs on in its tab, so the sheet waits for Check again.
   */
  confirmed(cx) {
    // A click that lands as the question opens was meant for what was there before.
    if (this.asking && Date.now() - (this.asking.opened ?? 0) < CONFIRM_AFTER_MS) return;
    const { item, items, at } = this.asking ?? {};
    this.asking = null;
    // Once a command runs in its tab the sheet waits for Check again; actions alone are done, so it checks at once.
    if (items) {
      const commands = items.filter((i) => !i.fix?.act).length;
      runFixAll(items, { at }, cx, this.toasts, (cx) => (commands ? ((this.fixing = `${commands === 1 ? "A command runs in its tab" : `${commands} commands run in their tabs`}: Check again once done`), cx.notify()) : this.check(cx)));
    }
    if (item) runFix(item, { at }, cx, this.toasts, (cx) => (item.fix?.act ? this.check(cx) : ((this.fixing = `${item.fix.command} runs in its tab: Check again once it is done`), cx.notify())));
    cx.notify();
  }

  /** The checks Health lists, in the order it draws them: the ones that need a look, or every one. */
  shown() {
    const checks = this.report?.checks ?? [];
    if (this.tab !== "health") return [];
    const list = this.all ? checks : checks.filter((c) => c.status !== "pass");
    const order = Object.keys(CATEGORIES);
    const rank = (c) => (order.includes(c.category) ? order.indexOf(c.category) : order.length);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }

  /**
   * The sheet's keys: what sets an option, asks about a fix or opens the file takes the person's own key, not held,
   * after a move or a click on a row of that tab; an injected key only looks around. A fix's question is answered by a
   * click only, and while a field has the keyboard every key but esc is the field's.
   */
  key(e, cx) {
    const s = e.keystroke;
    const shown = this.shown();
    const own = !e.injected && !e.is_held;
    if (own) this.acted();
    if (this.asking) {
      if (s === "escape") this.asking = null;
      cx.notify();
      return true;
    }
    if (this.field) {
      if (s !== "escape") return false;
      this.leaveField(cx);
      return true;
    }
    const options = this.optionList();
    const hasOptions = options.length > 0;
    const at = Math.max(0, options.findIndex((x) => (this.options ?? []).indexOf(x) === this.optionAt));
    const o = hasOptions ? options[at] : null;
    const move = ["j", "k", "down", "up"].includes(s);
    if (move && own) this.pointed = false;
    const turns = hasOptions && ["h", "l", "left", "right"].includes(s) && o?.kind === "choice" && !o.by_hand;
    const fixesAll = this.tab === "health" && s === "f" && fixAll(this.report).items.length > 1;
    const acts = turns || (hasOptions && (s === "space" || s === "enter" || s === "o")) || (!hasOptions && s === "enter" && shown[this.at]?.fix) || fixesAll;
    if (acts && !own) return true;
    if (acts && this.pointed) {
      this.toasts.push(cx, MOVE_FIRST, { kind: "info" });
      return true;
    }
    if (s === "escape") this.dismiss();
    else if (s === "u") this.checkUpdates(cx);
    else if (s === "shift-r" || s === "r") this.check(cx);
    else if (/^[1-9]$/.test(s) && TABS[Number(s) - 1]) this.show(TABS[Number(s) - 1]);
    else if (s === "a" && this.tab === "health") (this.all = !this.all), (this.at = 0), (this.pointed = true);
    else if (s === "o" && hasOptions) this.openFile(cx);
    else if (hasOptions && (s === "j" || s === "down")) this.selectOption(options[Math.min(at + 1, options.length - 1)]);
    else if (hasOptions && (s === "k" || s === "up")) this.selectOption(options[Math.max(at - 1, 0)]);
    else if (turns) this.setOption(o, turned(o, s === "h" || s === "left" ? -1 : 1), cx);
    else if (hasOptions && (s === "space" || s === "enter")) this.press(o, s, cx);
    else if (s === "j" || s === "down") this.reveal(Math.min(this.at + 1, Math.max(0, shown.length - 1)), shown);
    else if (s === "k" || s === "up") this.reveal(Math.max(this.at - 1, 0), shown);
    else if (s === "enter" && shown[this.at]?.fix) this.ask(shown[this.at], cx);
    else if (fixesAll) this.askAll(cx);
    else return false;
    cx.notify();
    return true;
  }

  /** A click on a check: it is the one selected, and ⏎ asks about its fix. */
  pick_check(id, cx) {
    const at = this.shown().findIndex((c) => c.id === id);
    if (at < 0) return;
    this.at = at;
    this.pointed = false;
    cx.notify();
  }

  /** Selects the `at`-th shown check and scrolls it into view (its place among the body's rows, as drawn last). */
  reveal(at, shown) {
    this.at = at;
    const row = this.rowAt[shown[at]?.id];
    if (row !== undefined) this.scroll?.scroll_to_item(row);
  }

  checkRow(k, c, cx, selected) {
    const verb = fixVerb(c.fix);
    return h_flex()
      .id(`check-${c.id}`)
      .on_click((_e, cx) => this.pick_check(c.id, cx))
      .gap(10)
      .py(6)
      .px(8)
      .mx(-8)
      .rounded(RADIUS.md)
      .when(selected, (e) => e.bg(k.selected))
      .items_start()
      .child(div().pt(1).child(Icon(statusIcon(c.status), { size: 15, color: statusColor(k, c.status) })))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(TEXT.sm).text_color(k.foreground).child(c.message))
          .when(Boolean(c.fix?.label) && c.status !== "pass", (e) => e.child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(c.fix.label))),
      )
      .when(c.status !== "pass" && Boolean(c.fix), (e) =>
        e.child(
          Button(`fix-${c.id}`, {
            label: verb ?? "Copy",
            icon: verb ? "play" : "copy",
            size: "sm",
            variant: c.status === "fail" && verb ? "default" : "outline",
            // ⏎ runs the selected check's fix: its key shows there.
            kbd: selected ? "⏎" : undefined,
            tooltip: c.fix.act ? c.fix.label : verb ? `Runs ${c.fix.command} in a tab of the actions space` : "Copy what to do",
            onClick: (_e, cx) => this.ask(c, cx),
          }),
        ),
      );
  }

  /** The checks as rows, each category's heading before its own; `this.rowAt` notes where each check lands after `first` rows. */
  checksEl(k, list, cx, first = 0) {
    if (!list.length) {
      return [
        v_flex()
          .items_center()
          .gap(8)
          .p(32)
          .child(Icon("circle-check", { size: 22, color: k.success }))
          .child(div().text_size(TEXT.sm).text_color(k.mutedFg).child("Nothing needs a look: every check passed.")),
      ];
    }
    const groups = Object.keys(CATEGORIES).map((cat) => [cat, list.filter((c) => c.category === cat)]);
    const others = list.filter((c) => !CATEGORIES[c.category]);
    if (others.length) groups.push(["other", others]);
    const picked = this.shown()[this.at]?.id;
    const rows = [];
    for (const [cat, items] of groups.filter(([, items]) => items.length)) {
      rows.push(heading(k, `cat-${cat}`, CATEGORIES[cat] ?? "Other", rows.length > 0));
      for (const c of items) {
        this.rowAt[c.id] = first + rows.length;
        rows.push(this.checkRow(k, c, cx, c.id === picked));
      }
    }
    return rows;
  }

  /**
   * The window's link to the hub when it is not live: what it is doing or why it last failed, in the error's own
   * words, with Start it where this window may start one. Null while the hub answers.
   */
  hubRow(k, id) {
    const state = this.hubState;
    if (state === "live") return null;
    const connecting = state === "connecting";
    const missing = hub.isNotInstalled(state);
    const stopped = hub.isStoppedOnPurpose(state);
    const last = connecting ? (hub.lastFailure()?.message ?? "") : hub.downReason(state);
    const words = this.starting ? "Starting the cockpit hub…" : connecting ? "Reaching the cockpit hub…" : missing ? "Cockpit isn't set up in this Herdr" : `${hub.downWords(state)}: this window cannot reach it`;
    const why = stopped ? "It was stopped with cockpit hub stop, and no window starts it again until you do." : missing ? "Run cockpit app install, then open this again." : last ? `${connecting ? "The last try failed" : "Why"}: ${last}` : "";
    const startable = !connecting && !missing && !hub.remoteMachine() && !this.starting;
    return h_flex()
      .id(id)
      .gap(10)
      .px(12)
      .py(10)
      .items_start()
      .rounded(RADIUS.lg)
      .border_1()
      .border_color(k.border)
      .bg(k.muted)
      .child(div().pt(1).child(connecting || this.starting ? Spinner({ size: 14, color: k.mutedFg }) : Icon(missing ? "wrench" : "triangle-alert", { size: 15, color: k.destructive })))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(TEXT.sm).font_medium().text_color(k.foreground).child(words))
          .when(Boolean(why), (e) => e.child(div().whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child(why))),
      )
      .when(startable, (e) => e.child(Button(`${id}-start`, { label: "Start it", size: "sm", variant: "outline", tooltip: "Start the cockpit hub", onClick: (_e, cx) => this.startHub(cx) })));
  }

  /** What sets an option: its switch, its choices as pills, or its field with Save once something else is typed. */
  control(k, o, i) {
    if (o.by_hand) return Badge("set in config.json", "outline", { tooltip: `${o.key} holds more than one value there: change it in the file` });
    const select = (cx) => {
      this.optionAt = i;
      this.pointed = false;
      cx.notify();
    };
    if ((o.kind ?? "toggle") === "toggle") {
      return Toggle(`option-toggle-${o.key}`, Boolean(o.value), (cx) => (select(cx), this.setOption(o, !o.value, cx)), { tooltip: `${o.value ? "Turn it off" : "Turn it on"}  space` });
    }
    if (o.kind === "choice") {
      const picks = (o.choices ?? []).map((c) => [c.value, c.label]);
      return h_flex().max_w(360).justify_end().child(Pills(`option-pick-${o.key}`, picks, o.value, (value, cx) => (select(cx), value !== o.value && this.setOption(o, value, cx))));
    }
    const state = this.fields.get(o.key);
    if (!state) return div();
    const busy = this.saving.has(o.key);
    // The field keeps the press it took: the sheet behind it would take the keyboard back to itself.
    const field = h_flex()
      .id(`option-field-${o.key}`)
      .w(o.kind === "number" ? 88 : 220)
      .on_mouse_down("left", (_e, cx) => {
        this.pointed = false;
        this.optionAt = i;
        cx.stop_propagation();
        cx.notify();
      })
      .child(TextField(state, { active: this.field === o.key }));
    return h_flex()
      .gap(6)
      .items_center()
      .child(field)
      .when(o.kind === "number" && Boolean(o.unit), (e) => e.child(div().w(24).text_size(TEXT.sm).text_color(k.mutedFg).child(o.unit)))
      .when(busy, (e) => e.child(Spinner({ size: 13, color: k.mutedFg })))
      .when(this.dirty(o) && !busy, (e) => e.child(Button(`option-save-${o.key}`, { label: "Save", size: "sm", kbd: "⏎", tooltip: "Save it", onClick: (_e, cx) => this.commit(o.key, cx) })));
  }

  /** One option: its name, its line, its default and key, why it was not saved when it was not, and what sets it. */
  optionRow(k, o, i) {
    const error = this.errors[o.key];
    const tone = k.destructive;
    const meta = [`Default: ${optionWords(o, o.default)}`, o.since ? `since ${o.since}` : null, o.key].filter(Boolean).join(" · ");
    return h_flex()
      .id(`option-${o.key}`)
      .gap(16)
      .py(10)
      .px(8)
      .mx(-8)
      .items_start()
      .rounded(RADIUS.md)
      .border_1()
      // A ring, not a fill: an off switch's track is the selected row's colour.
      .border_color(i === this.optionAt ? k.ring : k.background)
      .on_click((_e, cx) => ((this.optionAt = i), (this.pointed = false), cx.notify()))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(div().text_size(TEXT.base).font_medium().text_color(k.foreground).child(o.title))
              .when(o.seen === false, (e) => e.child(Badge("new", "outline"))),
          )
          .child(div().whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child(o.description))
          .child(div().truncate().text_size(TEXT.xs).text_color(k.dim).child(meta))
          .when(Boolean(error), (e) =>
            e.child(
              h_flex()
                .id(`option-error-${o.key}`)
                .gap(6)
                .pt(2)
                .items_start()
                .child(div().pt(1).child(Icon("triangle-alert", { size: 13, color: tone })))
                .child(div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).text_color(tone).child(`Not saved: ${error}`)),
            ),
          ),
      )
      .child(div().pt(2).flex_none().child(this.control(k, o, i)));
  }

  /** A small icon tile, the mark at the head of a settings card. */
  iconTile(k, icon, { tone = null, size = 28 } = {}) {
    return h_flex()
      .size(size)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(RADIUS.md)
      .bg(tone ? alpha(tone, 0.12) : k.muted)
      .child(Icon(icon, { size: Math.round(size * 0.55), color: tone ?? k.foreground }));
  }

  /** A card with an icon, a title and a line: the shape every Flow setting is grouped in. */
  settingsCard(k, { id, icon, title, description, action = null, tone = null, children = [] }) {
    return v_flex()
      .id(id)
      .mb(12)
      .w_full()
      .min_w(0)
      .rounded(RADIUS.xl)
      .border_1()
      .border_color(k.border)
      .bg(k.card)
      .overflow_hidden()
      .child(
        h_flex()
          .p(14)
          .gap(10)
          .items_start()
          .child(this.iconTile(k, icon, { tone }))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().text_size(TEXT.base).font_semibold().text_color(k.foreground).child(title))
              .when(Boolean(description), (e) => e.child(div().whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child(description))),
          )
          .when(Boolean(action), (e) => e.child(action)),
      )
      .children(children);
  }

  /** One group of options as a card: its icon and line, then its rows, each still set by its own control. */
  optionCard(k, group) {
    const all = this.options ?? [];
    const options = group.keys.map((key) => all.find((o) => o.key === key)).filter(Boolean);
    if (!options.length) return null;
    return this.settingsCard(k, {
      id: `group-${group.id}`,
      icon: group.icon,
      title: group.title,
      description: group.description,
      children: [v_flex().px(10).pb(6).children(options.map((o) => this.optionRow(k, o, all.indexOf(o))))],
    });
  }

  /** Draws a group of options and notes the card's row for j/k, since a card can hold several options. */
  pushOptionCard(rows, k, group) {
    const card = this.optionCard(k, group);
    if (!card) return;
    const at = rows.length;
    for (const key of group.keys) if ((this.options ?? []).some((o) => o.key === key)) this.rowAt[`option:${key}`] = at;
    rows.push(card);
  }

  /** What config.json holds that no switch or field sets, each key with its line, and the button that opens the file. */
  fileRows(k) {
    const open = Button("options-open-file", { label: `Open config.json in ${this.editor}`, icon: "external", variant: "outline", size: "sm", kbd: "O", tooltip: "~/.config/cockpit/config.json", onClick: (_e, cx) => this.openFile(cx) });
    const list = this.view?.in_file ?? [];
    return [
      heading(k, "options-in-file", "In config.json", true),
      h_flex()
        .id("options-file-intro")
        .gap(12)
        .pb(6)
        .items_center()
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child("What no switch or field sets. Edit the file by hand, then run cockpit doctor: it says when the file does not read."))
        .child(open),
      ...list.map((f, i) =>
        h_flex()
          .id(`options-file-${i}`)
          .gap(12)
          .py(4)
          .items_start()
          .child(div().w(168).flex_none().child(Mono(f.key, { size: TEXT.sm, color: k.foreground })))
          .child(div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child(f.description)),
      ),
    ];
  }

  /** GitLab's card: whether cockpit reads a GitLab server, which one and what from it, and the button that connects it. */
  gitlabRow(k) {
    const found = shared(GITLAB_SHARED);
    const parts = found?.sections?.map((s) => SECTIONS[s]?.toLowerCase()).filter(Boolean) ?? [];
    const line = !found
      ? "Your merge requests, pipelines and issues, from GitLab.com or your company's own server."
      : parts.length
        ? `Connected to ${found.host}: ${parts.join(", ")}.`
        : `${found.host} is saved, but nothing is mapped yet: connect again to finish.`;
    return h_flex()
      .id("options-gitlab")
      .my(8)
      .p(12)
      .gap(12)
      .items_center()
      .rounded(RADIUS.md)
      .border_1()
      .border_color(k.border)
      .bg(k.card)
      .child(Icon("git-merge", { size: 18, color: found && parts.length ? k.success : k.mutedFg }))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().text_size(TEXT.sm).font_semibold().child("GitLab"))
          .child(div().whitespace_normal().text_size(TEXT.xs).text_color(k.mutedFg).child(line)),
      )
      .child(Button("options-gitlab-connect", { label: found ? "Manage" : "Connect GitLab", icon: found ? undefined : "link", variant: found ? "outline" : "default", size: "sm", onClick: () => openGitlabForm() }));
  }

  /**
   * The cockpit options as rows, section by section: Advanced's whole list, or with `omit` the ones no Flow tab
   * shows. `gitlab` and `file` keep the GitLab card and the list only the file holds; `description` replaces the line
   * above them. While the hub does not answer it still opens the file and connects GitLab.
   */
  optionRows(k, { gitlab = true, file = true, omit = null, description = null } = {}) {
    const down = this.hubRow(k, "options-hub");
    const loading = [...(down ? [div().pb(12).child(down)] : []), ...(gitlab ? [this.gitlabRow(k)] : []), v_flex().gap(10).p(24).children([0, 1, 2].map((i) => Skeleton({ h: 16, w: 260 + i * 80 })))];
    if (!this.options) {
      if (!down || this.hubState === "connecting") return loading;
      return [
        down,
        h_flex()
          .id("options-unread")
          .gap(12)
          .pt(14)
          .items_center()
          .child(div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child("The options are read and saved through the hub. config.json itself opens without it, and cockpit options lists them in a terminal."))
          .child(Button("options-open-file", { label: `Open config.json in ${this.editor}`, icon: "external", variant: "outline", size: "sm", onClick: (_e, cx) => this.openFile(cx) })),
        ...(gitlab ? [this.gitlabRow(k)] : []),
      ];
    }
    if (!this.options.length) return [...(gitlab ? [this.gitlabRow(k)] : []), div().p(24).text_size(TEXT.sm).text_color(k.mutedFg).child("This cockpit has no options to set from here: cockpit options lists them in a terminal.")];
    const rows = down ? [div().pb(12).child(down)] : [];
    rows.push(div().pb(4).text_size(TEXT.sm).text_color(k.mutedFg).child(description ?? "Saved in ~/.config/cockpit/config.json as you change them; cockpit options lists them in a terminal."));
    if (gitlab) rows.push(this.gitlabRow(k));
    for (const section of sectioned(this.view)) {
      const kept = section.rows.filter(([o]) => !omit || !omit.has(o.key));
      if (!kept.length) continue;
      rows.push(heading(k, `section-${section.title}`, section.title, true));
      for (const [o, i] of kept) {
        this.rowAt[`option:${o.key}`] = rows.length;
        rows.push(this.optionRow(k, o, i));
      }
    }
    if (file) rows.push(...this.fileRows(k));
    this.rowAt.end = rows.length - 1;
    return rows;
  }

  /**
   * The window shows `name` instead, as the update dialog's Try does: a toast says how to come back. Only a click on its
   * button calls it, and the layout shown already changes nothing.
   */
  useLayout(name) {
    const choice = LAYOUT_CHOICES.find((l) => l.name === name);
    if (!choice || name === shownLayout()) return;
    notify({ title: `This is ${choice.title}`, body: "Flow settings, under Look, switches back.", level: "info", timeout: 8000 });
    this.dismiss();
    run("layout.switch", { name });
  }

  /**
   * The Look tab: one wide card per Flow look, each with its light and dark picture side by side, its colours and what
   * sets it apart. Narrow, the two pictures stack.
   */
  layoutEl(k) {
    const shown = shownLayout();
    const room = this.contentWidth();
    const stacked = room < 560;
    const cardW = room;
    const picW = stacked ? cardW - 26 : Math.floor((cardW - 26 - 10) / 2);
    const picH = Math.round((picW * PICTURE.h) / PICTURE.w);
    const swatch = (color, tip) => div().size(10).rounded(5).bg(color).border_1().border_color(alpha(k.foreground, 0.16)).tooltip(tip);
    const picture = (l, dark) =>
      v_flex()
        .gap(5)
        .child(
          div()
            .rounded(RADIUS.md)
            .overflow_hidden()
            .border_1()
            .border_color(k.border)
            .child(image(layoutPicture(l.name, dark)).w(picW).h(picH)),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(Icon(dark ? "moon" : "sun", { size: 11, color: k.mutedFg }))
            .child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(dark ? "Dark" : "Light"))
            .child(div().flex_1())
            .children((l.colors?.[dark ? "dark" : "light"] ?? []).map((color, i) => swatch(color, ["Chrome", "Accent", "Working"][i]))),
        );
    const card = (l) => {
      const using = l.name === shown;
      return v_flex()
        .id(`layout-${l.name}`)
        .w(cardW)
        .flex_none()
        .gap(10)
        .p(12)
        .rounded(RADIUS.xl)
        .border_1()
        .border_color(using ? k.ring : k.border)
        .bg(k.card)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .child(div().truncate().text_size(TEXT.lg).font_semibold().text_color(k.foreground).child(l.title))
                .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(l.tagline)),
            )
            .when(using, (e) => e.child(Badge("In use", "secondary", { icon: "check" })))
            .when(!using, (e) =>
              e.child(Button(`layout-use-${l.name}`, { label: "Use this look", icon: "layout", size: "sm", tooltip: `Switch this window to ${l.title}`, onClick: () => this.useLayout(l.name) })),
            ),
        )
        .child((stacked ? v_flex() : h_flex().items_start()).gap(10).children([picture(l, false), picture(l, true)]))
        .child(
          v_flex()
            .gap(5)
            .children(
              l.points.map((point) =>
                h_flex()
                  .gap(8)
                  .items_start()
                  .child(div().mt(6).size(4).flex_none().rounded(2).bg(k.dim))
                  .child(div().flex_1().min_w(0).whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child(point)),
              ),
            ),
        );
    };
    return v_flex()
      .gap(12)
      .child(
        v_flex()
          .gap(4)
          .child(div().text_size(TEXT.lg).font_semibold().text_color(k.foreground).child("Three looks, one Flow"))
          .child(div().whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child("The same threads, agents, apps and hub in three moods, each in light and dark. Switching keeps everything where it was.")),
      )
      .children(LAYOUT_CHOICES.map(card));
  }

  /** A tiny drawing of the window Flow draws: the bar, the sidebar, the cards, the side panel and the status bar. */
  blueprint(k) {
    const chip = (label, { w = null, h = 16, tone = null } = {}) => {
      let e = v_flex().flex_none().items_center().justify_center().rounded(4).bg(tone ?? k.background);
      if (w) e = e.w(w);
      return e.h(h).child(div().truncate().text_size(10).text_color(k.mutedFg).child(label));
    };
    const row = (on) => div().h(14).rounded(3).bg(on ? k.selected : k.background).border_1().border_color(alpha(k.border, 0.6));
    const pane = (label, detail, { w = null } = {}) => {
      let e = v_flex().flex_1().min_w(0).gap(3).p(8).rounded(RADIUS.md).bg(k.muted);
      if (w) e = e.w(w);
      return e
        .child(div().truncate().text_size(TEXT.xs).font_medium().text_color(k.foreground).child(label))
        .child(div().truncate().text_size(10).text_color(k.mutedFg).child(detail));
    };
    return v_flex()
      .id("flow-blueprint")
      .w_full()
      .gap(6)
      .p(8)
      .rounded(RADIUS.lg)
      .border_1()
      .border_color(k.border)
      .bg(alpha(k.muted, 0.45))
      .child(
        h_flex()
          .h(26)
          .gap(4)
          .px(6)
          .items_center()
          .rounded(RADIUS.md)
          .bg(k.muted)
          .child(div().size(8).flex_none().rounded_full().bg(k.ring))
          .child(chip("Home", { w: 48, tone: k.selected }))
          .child(chip("Work", { w: 40 }))
          .child(div().flex_1())
          .child(Icon("search", { size: 11, color: k.mutedFg }))
          .child(Icon("bell", { size: 11, color: k.mutedFg })),
      )
      .child(
        h_flex()
          .h(148)
          .gap(6)
          .items_start()
          .child(
            v_flex()
              .w("24%")
              .h_full()
              .min_w(52)
              .gap(3)
              .p(6)
              .rounded(RADIUS.md)
              .bg(k.muted)
              .child(div().text_size(10).font_medium().text_color(k.mutedFg).child("Threads"))
              .child(row(true))
              .child(row(false))
              .child(row(false))
              .child(div().flex_1())
              .child(div().text_size(10).text_color(k.dim).child("Agents")),
          )
          .child(
            v_flex()
              .flex_1()
              .h_full()
              .min_w(0)
              .gap(6)
              .child(
                v_flex()
                  .flex_1()
                  .min_h(0)
                  .gap(2)
                  .p(8)
                  .rounded(RADIUS.md)
                  .bg(k.muted)
                  .child(div().text_size(TEXT.sm).font_semibold().text_color(k.foreground).child("Home"))
                  .child(div().truncate().text_size(10).text_color(k.mutedFg).child("What needs you, and what is moving")),
              )
              .child(h_flex().flex_1().gap(6).items_start().child(pane("Work", "The agent you are with")).child(pane("Review", "Its work beside it", { w: "34%" }))),
          )
          .child(
            v_flex()
              .w("19%")
              .h_full()
              .min_w(46)
              .gap(3)
              .p(6)
              .rounded(RADIUS.md)
              .bg(k.muted)
              .child(div().text_size(10).font_medium().text_color(k.mutedFg).child("Panel"))
              .child(chip("Show"))
              .child(chip("Review"))
              .child(chip("Files")),
          ),
      )
      .child(
        h_flex()
          .h(18)
          .gap(6)
          .px(6)
          .items_center()
          .rounded(4)
          .bg(k.muted)
          .child(div().size(5).flex_none().rounded_full().bg(k.success))
          .child(div().truncate().text_size(9).text_color(k.mutedFg).child("Flow · main machine · this look"))
          .child(div().flex_1())
          .child(div().text_size(9).text_color(k.dim).child("⌘/ keys")),
      );
  }

  /** One figure in Flow's at-a-glance row, a door to the tab that explains it. */
  stat(k, { id, icon, label, value, go, tone = null, width = null }) {
    let e = v_flex()
      .id(`flow-stat-${id}`)
      .gap(3)
      .p(12)
      .rounded(RADIUS.lg)
      .border_1()
      .border_color(k.border)
      .bg(k.card)
      .cursor_pointer()
      .hover((s) => s.bg(k.muted))
      .on_click((_e, cx) => (this.show(go), cx.notify()));
    e = width ? e.w(width).flex_none() : e.flex_1().min_w(112);
    return e
      .child(h_flex().gap(6).items_center().child(Icon(icon, { size: 13, color: tone ?? k.mutedFg })).child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(label)))
      .child(div().truncate().text_size(TEXT.xl).font_semibold().text_color(tone ?? k.foreground).child(String(value)));
  }

  /** The Flow tab: the window drawn small, the figures that matter, the keys and the doors Flow keeps close. */
  flowEl(k) {
    const current = LAYOUT_CHOICES.find((l) => l.name === shownLayout()) ?? LAYOUT_CHOICES[0];
    const installed = (this.report?.agents ?? []).filter((a) => a.installed).length;
    const threadState = shared(THREADS) ?? {};
    const threads = Object.keys(threadState.threads ?? {}).length;
    const failing = this.report?.summary?.fail ?? 0;
    const warn = this.report?.summary?.warn ?? 0;
    const health = !this.report ? "Checking…" : failing ? `${failing} failing` : warn ? `${warn} to look at` : "All clear";
    const content = this.contentWidth();
    const perRow = content < 520 ? 2 : 4;
    const statW = Math.floor((content - (perRow - 1) * 8) / perRow);
    const rows = [
      this.settingsCard(k, {
        id: "flow-window",
        icon: "layout-dashboard",
        title: "The Flow window",
        description: "One bar for the window, threads in the sidebar, the agent you are with in the center, and the work beside it when you need it.",
        action: Button("flow-herdr-settings", { label: "Herdr settings", icon: "settings", variant: "outline", size: "sm", tooltip: "The app's own look, fonts and keys", onClick: () => run("app.settings") }),
        children: [div().px(14).pb(14).child(this.blueprint(k))],
      }),
      h_flex()
        .mb(12)
        .gap(8)
        .flex_wrap()
        .children([
          this.stat(k, { id: "look", icon: "palette", label: "Look", value: current.title, go: "look", width: statW }),
          this.stat(k, { id: "agents", icon: "bot", label: "Agents installed", value: this.report ? installed : "…", go: "agents", width: statW }),
          this.stat(k, { id: "threads", icon: "git-branch", label: "Open threads", value: threads, go: "work", width: statW }),
          this.stat(k, { id: "health", icon: failing ? "triangle-alert" : "circle-check", label: "Health", value: health, go: "health", tone: failing ? k.destructive : !this.report ? null : k.success, width: statW }),
        ]),
    ];
    const shortcuts = this.settingsCard(k, {
      id: "flow-keys",
      icon: "keyboard",
      title: "Everyday keys",
      description: "The few worth knowing before the rest.",
      action: Button("flow-keys-all", { label: "All keys", icon: "command", variant: "outline", size: "sm", tooltip: "The window's keys, by what they do", onClick: () => run("flow.keys") }),
      children: [
        v_flex()
          .px(14)
          .pb(12)
          .gap(8)
          .children(
            [
              ["cmd-shift-p", "Search or run a command"],
              ["cmd-n", "Start a thread"],
              ["cmd-j", "The next agent waiting for you"],
              ["cmd-shift-l", "Switch look"],
              ["cmd-alt-b", "Open or close the side panel"],
              ["cmd-/", "Every key, in one sheet"],
            ].map(([keys, what]) => h_flex().gap(10).items_center().child(Kbd(keys)).child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.mutedFg).child(what))),
          ),
      ],
    });
    const doors = this.settingsCard(k, {
      id: "flow-doors",
      icon: "sparkles",
      title: "At hand",
      description: "The doors Flow's window keeps close, without a trip to the palette.",
      children: [
        h_flex()
          .px(14)
          .pb(14)
          .gap(6)
          .flex_wrap()
          .children([
            Button("flow-new-thread", { label: "New thread", icon: "git-branch", variant: "outline", size: "sm", onClick: () => run("flow.thread") }),
            Button("flow-add-machine", { label: "Add machine", icon: "plus", variant: "outline", size: "sm", onClick: () => run("mod.open", { name: "machine-add" }) }),
            Button("flow-gitlab", { label: "Connect GitLab", icon: "git-merge", variant: "outline", size: "sm", onClick: () => openGitlabForm() }),
            Button("flow-usage", { label: "Usage", icon: "gauge", variant: "outline", size: "sm", onClick: () => run("flow.usage") }),
          ]),
      ],
    });
    const half = Math.floor((this.contentWidth() - 12) / 2);
    rows.push(
      this.contentWidth() < 560
        ? v_flex().gap(12).children([shortcuts, doors])
        : h_flex().items_start().gap(12).children([v_flex().w(half).flex_none().min_w(0).child(shortcuts), v_flex().w(half).flex_none().min_w(0).child(doors)]),
    );
    return rows;
  }

  /** The room the tab's content has, after the rail and the body's margins. */
  contentWidth() {
    const w = this.width ?? 860;
    return Math.max(240, w - (w < 720 ? 28 : 254));
  }

  /** The left rail wide, a wrap of small tabs when the window is narrow. */
  nav(k, narrow) {
    const installed = (this.report?.agents ?? []).filter((a) => a.installed).length;
    const problems = (this.report?.checks ?? []).filter((c) => c.status !== "pass").length + (String(this.hubState).startsWith("error") ? 1 : 0);
    const unseen = (id) => (this.options ?? []).filter((o) => !o.seen && this.optionList(id).includes(o)).length;
    const count = (id) => (id === "agents" ? (this.report ? installed : null) : id === "health" ? (this.report ? problems : null) : ["work", "data", "advanced"].includes(id) ? unseen(id) || null : null);
    const item = (n) => {
      const active = this.tab === n.id;
      const number = count(n.id);
      const tone = n.id === "health" && number ? k.destructive : k.mutedFg;
      if (narrow) {
        return h_flex()
          .id(`settings-nav-${n.id}`)
          .h(30)
          .px(8)
          .gap(5)
          .flex_none()
          .items_center()
          .rounded(RADIUS.md)
          .cursor_pointer()
          .bg(active ? k.selected : k.background)
          .border_1()
          .border_color(active ? k.border : k.background)
          .hover((s) => s.bg(k.muted))
          .on_click((_e, cx) => (this.show(n.id), cx.notify()))
          .child(Icon(n.icon, { size: 13, color: active ? k.foreground : k.mutedFg }))
          .child(div().text_size(TEXT.sm).font_medium().text_color(active ? k.foreground : k.mutedFg).child(n.label))
          .when(Boolean(number), (e) => e.child(div().text_size(TEXT.xs).text_color(tone).child(String(number))));
      }
      return v_flex()
        .id(`settings-nav-${n.id}`)
        .gap(0)
        .px(9)
        .py(7)
        .rounded(RADIUS.md)
        .cursor_pointer()
        .bg(active ? k.selected : k.background)
        .border_1()
        .border_color(active ? k.border : k.background)
        .hover((s) => s.bg(k.muted))
        .on_click((_e, cx) => (this.show(n.id), cx.notify()))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(Icon(n.icon, { size: 14, color: active ? k.foreground : k.mutedFg }))
            .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).font_medium().text_color(active ? k.foreground : k.mutedFg).child(n.label))
            .when(Boolean(number), (e) => e.child(div().text_size(TEXT.xs).font_medium().text_color(tone).child(String(number)))),
        )
        .child(div().pl(22).truncate().text_size(10).text_color(k.dim).child(n.hint));
    };
    return narrow
      ? h_flex().id("settings-nav").w_full().flex_none().flex_wrap().gap(4).p(8).border_b_1().border_color(k.border).children(NAV.map(item))
      : v_flex().id("settings-nav").w(210).flex_none().h_full().gap(2).p(10).border_r_1().border_color(k.border).children(NAV.map(item));
  }

  /** The Agents tab: who new work starts, how agents are named, and the roster this machine runs. */
  agentsElTab(k) {
    const rows = [];
    const down = this.hubRow(k, "agents-hub");
    if (down) rows.push(div().mb(12).child(down));
    for (const group of GROUPS.agents) this.pushOptionCard(rows, k, group);
    const installed = (this.report?.agents ?? []).filter((a) => a.installed).length;
    rows.push(
      this.settingsCard(k, {
        id: "agents-roster",
        icon: "users",
        title: "On this machine",
        description: this.report ? `${installed} installed${this.report.agents?.length > installed ? `, ${this.report.agents.length - installed} to add` : ""}. What each can do, and whether cockpit's tools reach it.` : "Reading what this machine runs…",
        action: Button("agents-add", { label: "Add machine", icon: "plus", variant: "outline", size: "sm", onClick: () => run("mod.open", { name: "machine-add" }) }),
        children: [div().px(14).pb(10).child(this.report ? this.agentsEl(k) : v_flex().gap(8).children([0, 1, 2].map((i) => Skeleton({ h: 14, w: 200 + i * 50 }))))],
      }),
    );
    return rows;
  }

  /** The Work tab: threads themselves, then the prompts, questions and briefs Flow's screens act on. */
  workEl(k) {
    const threadState = shared(THREADS) ?? {};
    const threads = Object.keys(threadState.threads ?? {}).length;
    const resolved = (threadState.resolved ?? []).length;
    const rows = [
      this.settingsCard(k, {
        id: "work-threads",
        icon: "git-branch",
        title: "Threads",
        description: "A fix, a feature or a bug, on the machine it works on. The sidebar lists them in place of spaces, and each keeps its own tabs and panes.",
        action: Button("work-new-thread", { label: "New thread", icon: "plus", size: "sm", onClick: () => run("flow.thread") }),
        children: [
          h_flex()
            .px(14)
            .pb(14)
            .gap(14)
            .items_center()
            .flex_wrap()
            .child(div().text_size(TEXT.sm).text_color(k.mutedFg).child(`${threads} open · ${resolved} resolved`))
            .child(div().flex_1())
            .child(Button("work-add-machine", { label: "Add machine", icon: "server", variant: "outline", size: "sm", onClick: () => run("mod.open", { name: "machine-add" }) })),
        ],
      }),
    ];
    const down = this.hubRow(k, "work-hub");
    if (down) rows.push(div().mb(12).child(down));
    for (const group of GROUPS.work) this.pushOptionCard(rows, k, group);
    if (!this.options && !down) rows.push(v_flex().gap(10).p(24).children([0, 1, 2].map((i) => Skeleton({ h: 16, w: 260 + i * 70 }))));
    rows.push(div().pb(4).text_size(TEXT.xs).text_color(k.dim).child("These are cockpit's options, saved in ~/.config/cockpit/config.json as you change them."));
    return rows;
  }

  /** The Data tab: GitLab, the sources Flow reads, how often, and the connectors only config.json holds. */
  dataEl(k) {
    const rows = [this.gitlabRow(k)];
    const down = this.hubRow(k, "data-hub");
    if (down) rows.push(div().mb(12).child(down));
    for (const group of GROUPS.data) this.pushOptionCard(rows, k, group);
    if (!this.options && !down) rows.push(v_flex().gap(10).p(24).children([0, 1, 2].map((i) => Skeleton({ h: 16, w: 250 + i * 80 }))));
    rows.push(...this.fileRows(k));
    return rows;
  }

  /** The Advanced tab: cockpit's other options, the ones Flow's own screens do not act on, in one honest list. */
  advancedEl(k) {
    const left = (this.options ?? []).filter((o) => !PLACED.has(o.key)).length;
    const rows = [
      this.settingsCard(k, {
        id: "advanced-cockpit",
        icon: "sliders-horizontal",
        title: "Cockpit's other options",
        description: `Start work, cockpit's chat and anything a later cockpit brings. Flow's own screens do not act on most of these, but cockpit still does.${left ? ` ${left} left.` : ""}`,
        action: Button("advanced-open-file", { label: `Open config.json`, icon: "external", variant: "outline", size: "sm", tooltip: "~/.config/cockpit/config.json", onClick: (_e, cx) => this.openFile(cx) }),
      }),
    ];
    rows.push(...this.optionRows(k, { gitlab: false, file: false, omit: PLACED, description: "Saved in ~/.config/cockpit/config.json as you change them; cockpit options lists them in a terminal." }));
    return rows;
  }
  /** The agents this machine runs: their logo, what they can do, their tools and their last usage. */
  agentsEl(k) {
    const agents = this.report?.agents ?? [];
    const row = (a) =>
      v_flex()
        .id(`agent-${a.id}`)
        .gap(6)
        .py(10)
        .border_b_1()
        .border_color(k.border)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(AgentLogo(a.icon ?? "agent", { size: 16, color: a.installed ? k.foreground : k.mutedFg }))
            .child(div().text_size(TEXT.base).font_medium().text_color(a.installed ? k.foreground : k.mutedFg).child(a.name))
            .when(a.default, (e) => e.child(Badge("default", "secondary")))
            .when(!a.installed, (e) => e.child(Badge("not installed", "outline")))
            .child(div().flex_1())
            .when(Boolean(a.path), (e) => e.child(Mono(a.path, { color: k.dim }))),
        )
        .child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .children(CAN.map(([key, word, tip]) => Badge(word, a.can?.[key] ? "secondary" : "outline", { icon: a.can?.[key] ? "check" : "x", id: tip ? `agent-${a.id}-${key}` : undefined, tooltip: tip })))
            .child(Badge(a.tools ? `cockpit's tools: ${a.tools === "plugin" ? "its plugin" : "MCP"}${a.connected === false ? ", not connected" : ""}` : "no cockpit tools", a.connected === false ? "warning" : "outline")),
        )
        .child(
          div()
            .text_size(TEXT.xs)
            .text_color(k.mutedFg)
            .child(`Usage: ${a.usage ?? "not reported"}${a.limits ? ` · limits: ${a.limits}` : ""}`),
        );
    const installed = agents.filter((a) => a.installed);
    const rest = agents.filter((a) => !a.installed);
    return v_flex()
      .gap(0)
      .children(installed.map(row))
      .when(rest.length > 0, (e) => e.child(div().pt(14).pb(2).text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child(`NOT INSTALLED · ${rest.length}`)).children(rest.map(row)));
  }

  /**
   * Health's rows: what the checks found and Check again, the link to the hub when it is down (with why), getting
   * started, then the checks that need a look or every one.
   */
  healthRows(k, cx) {
    const r = this.report;
    const checks = r?.checks ?? [];
    const problems = checks.filter((c) => c.status !== "pass");
    const fixable = fixAll(r).items;
    const s = r?.summary ?? {};
    const at = r?.at ? new Date(r.at).toTimeString().slice(0, 5) : null;
    const summary = this.fixing
      ? this.fixing
      : r
        ? [s.fail ? `${s.fail} failing` : null, s.warn ? `${s.warn} to look at` : null, `${s.pass ?? 0} passed`, at ? `checked ${at}` : null].filter(Boolean).join(" · ")
        : (this.error ?? "Checking every part of cockpit…");
    const rows = [
      v_flex()
        .id("health-top")
        .gap(8)
        .pb(12)
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(this.error ? k.destructive : k.mutedFg).child(summary))
            .when(this.running, (e) => e.child(Spinner({ size: 14, color: k.mutedFg })))
            .child(Button("diag-again", { label: "Check again", icon: "refresh-cw", variant: "outline", size: "sm", kbd: "R", tooltip: "Run every check again", onClick: (_e, cx) => this.check(cx) })),
        )
        .child(
          h_flex()
            .gap(8)
            .flex_wrap()
            .items_center()
            .child(
              Pills("health-filter", [["needs", `Needs a look ${problems.length}`], ["all", `All checks ${checks.length}`]], this.all ? "all" : "needs", (value, cx) => ((this.all = value === "all"), (this.at = 0), cx.notify())),
            )
            .when(fixable.length > 1, (e) =>
              e.child(
                Button("diag-fix-all", {
                  label: `Fix all (${fixable.length})`,
                  icon: "play",
                  size: "sm",
                  kbd: "F",
                  tooltip: `Run the ${fixable.length} fixes cockpit can run, after one confirm`,
                  onClick: (_e, cx) => this.askAll(cx),
                }),
              ),
            ),
        ),
    ];
    const down = this.hubRow(k, "health-hub");
    if (down) rows.push(div().pb(12).child(down));
    if (!r && !this.error) return [...rows, v_flex().gap(10).p(24).children([0, 1, 2, 3, 4].map((i) => Skeleton({ h: 16, w: 240 + ((i * 97) % 300) })))];
    const started = this.all ? null : StartedList(r, { onFix: (step, cx) => this.ask(step, cx) });
    if (started) rows.push(div().pb(16).child(started));
    if (this.all && !down) {
      rows.push(heading(k, "cat-window", "This window", false));
      rows.push(
        h_flex()
          .id("check-window-hub")
          .gap(10)
          .py(6)
          .items_start()
          .child(div().pt(1).child(Icon("circle-check", { size: 15, color: statusColor(k, "pass") })))
          .child(div().flex_1().min_w(0).text_size(TEXT.sm).text_color(k.foreground).child("This window reaches the cockpit hub")),
      );
    }
    // Nothing needs a look only when the hub answers too.
    if (!(down && !this.all && !problems.length)) rows.push(...this.checksEl(k, this.all ? checks : problems, cx, rows.length));
    return rows;
  }

  render(cx) {
    const k = tokens();
    const line = versionLine(this.v, { checking: this.checking });
    const narrow = (this.width ?? 860) < 720;
    // The body's rows are the scroll area's own children, so j/k can bring the selected check or option into view.
    this.rowAt = {};
    const rows =
      this.tab === "flow"
        ? this.flowEl(k)
        : this.tab === "look"
          ? [this.layoutEl(k)]
          : this.tab === "agents"
            ? this.agentsElTab(k)
            : this.tab === "work"
              ? this.workEl(k)
              : this.tab === "data"
                ? this.dataEl(k)
                : this.tab === "advanced"
                  ? this.advancedEl(k)
                  : this.healthRows(k, cx);
    const body = ((area) => (this.scroll ? area.track_scroll(this.scroll) : area))(
      v_flex().id("settings-body").flex_1().min_h(0).min_w(0).px(narrow ? 14 : 22).pt(narrow ? 12 : 16).pb(20).overflow_y_scrollbar(),
    ).children(rows);
    const shell = narrow
      ? v_flex().flex_1().min_h(0).child(this.nav(k, true)).child(body)
      : h_flex().flex_1().min_h(0).child(this.nav(k, false)).child(body);
    let root = v_flex()
      .id("settings")
      .track_focus(this.handle)
      .size_full()
      .relative()
      .bg(k.background)
      .text_color(k.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs((this.width ?? 0) - size.width) < 1) return;
        this.width = size.width;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => {
        this.acted();
        // A click outside a field takes the keyboard back to the sheet.
        if (!this.field) this.handle.focus();
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .child(
        h_flex()
          .h(64)
          .px(20)
          .gap(10)
          .flex_none()
          .items_center()
          .border_b_1()
          .border_color(k.border)
          .child(h_flex().size(32).flex_none().rounded(RADIUS.lg).items_center().justify_center().border_1().border_color(k.border).bg(k.muted).child(Icon("sliders-horizontal", { size: 16, color: k.foreground })))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().text_size(TEXT.lg).font_semibold().child("Flow settings"))
              .child(div().id("settings-version").truncate().text_size(TEXT.sm).text_color(line.state === "failed" ? k.destructive : k.mutedFg).tooltip(line.text).child(line.text)),
          )
          .when(this.checking, (e) => e.child(Spinner({ size: 14, color: k.mutedFg })))
          .when(line.update && !this.checking, (e) =>
            e.child(Button("settings-update", { label: narrow ? "Update" : `Update to ${this.v.latest}`, icon: "arrow-up", size: "sm", tooltip: `What ${this.v.latest} changes, and Install`, onClick: () => (this.dismiss(), openUpdate({ person: true })) })),
          )
          .child(
            Button("settings-check", {
              label: "Check for updates",
              icon: "refresh-cw",
              variant: "outline",
              size: narrow ? "icon-sm" : "sm",
              kbd: "U",
              disabled: this.checking,
              tooltip: narrow ? "Check for updates  U" : "Ask now whether a newer cockpit is published",
              onClick: (_e, cx) => this.checkUpdates(cx),
            }),
          )
          .child(Button("settings-close", { icon: "x", variant: "ghost", size: "icon", tooltip: "Close  esc", onClick: () => this.dismiss() })),
      )
      .child(shell);
    const toasts = this.toasts.render();
    if (toasts) root = root.child(toasts);
    if (this.asking) {
      root = root.child(
        fixConfirm("diag-confirm", this.asking, { onCancel: (_e, cx) => ((this.asking = null), cx.notify()), onConfirm: (_e, cx) => this.confirmed(cx) }),
      );
    }
    return root;
  }
}
