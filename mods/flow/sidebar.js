// The cockpit sidebar, in place of Herdr's Spaces and Agents lists: the work area and the pinned apps (the config's
// `spaces`) with their counts, then the threads (threads.js) as cards, the resolved ones and the other spaces folded
// under them. It also posts the hub's notifications, as Herdr toasts while the window is in front and system ones
// otherwise; the window's commands run in commands.js.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, shared, setShared, focused, spaces, agents, machines, hc, panes, terminals, setAgentOrder, notify, openOverlay, window as win, readTextFile, exec } from "herdr";
import * as hub from "./hub.js";
import { followBrowser } from "./web.js";
import { deliver } from "./notify.js";
import { rowsOf, countsOf, agentStatus, needing, showBadge } from "./fleet.js";
import { option } from "./config.js";
import { show, showWork, screens } from "./screens.js";
import { togglePalette, openRecap, hint, keyFor, keyText, lend, askResolve } from "./commands.js";
import { UpdateTag, pending as pendingUpdate } from "./update.js";
import { SettingsLink, HerdrLinks } from "./doctor.js";
import { openUsage, inkOn } from "./usage.js";
import { FOLDERS, normalize as normalizeFolders, arrange as arrangeFolders, toggleFolder as toggleFolders, machineKey, machineOfKey } from "./folders.js";
import { openFolderName } from "./folder-name.js";
import { THREADS, KINDS, kindOf, settle as settleThreads, split as splitThreads, unbridged, bridged, activity, ago, threadFolder, normalize as threadsOf } from "./threads.js";
import { BRIDGES, remember, machineWords } from "./bridge.js";
import { tokens, alpha, TEXT, RADIUS, Icon, Kbd, Button, openMenu, SectionHeader, StageHeading, HoverCard, Hover, Flashes, CornerCount, HubDown, dur, AgentLogo, providersOf } from "./ui.js";
import { AgentsModel, QuestionCard, QuotaBars, StageMark, Chips, STAGES, stageColor, stageAge, hours, statusColor, UndoRow } from "./agentsui.js";

/** The config's pinned spaces that are apps here, by their space name; their key comes from the shown layout's keys. */
export const APPS = {
  runbook: { label: "Runbook", icon: "book" },
  "to-do": { child: "todo", label: "To-do", icon: "list-todo" },
  meetings: { label: "Meetings", icon: "calendar" },
  monitor: { label: "Monitor", icon: "activity" },
  routines: { label: "Routines", icon: "clock" },
  mail: { label: "Mail", icon: "mail" },
};
const DEFAULT_SPACES = ["terminal", "actions", "to-do", "runbook", "meetings"];

/** The fields of each app's view that appBadge reads: the hub sends these alone, and only when they move. */
const BADGE_FIELDS = {
  todo: ["open"],
  monitor: ["tiles"],
  routines: ["tiles"],
  meetings: ["meetings", "today", "banner"],
  mail: ["counts"],
};

/** An app's bubble from its view: what waits on you there, {count, tone} or null. */
function appBadge(app, v) {
  if (!v) return null;
  const of = (count, tone) => (count ? { count, tone } : null);
  if (app === "todo") return of(v.open, null);
  if (app === "monitor") {
    const t = v.tiles ?? {};
    return of((t.alerts ?? 0) + (t.failed ?? 0), "destructive") ?? of(t.newErrors, "warning");
  }
  if (app === "routines") return of(v.tiles?.unread, v.tiles?.failing ? "destructive" : "warning");
  if (app === "mail") return of(v.counts?.needs, "warning");
  if (app === "meetings") {
    const now = Date.now();
    const left = (v.meetings ?? []).filter((m) => m.day === v.today && (m.end ?? 0) > now).length;
    return of(left, v.banner?.soon ? "warning" : "info");
  }
  return null;
}

export { show } from "./screens.js";

/** Brings up a space's work: its panes. */
function showSpace(id) {
  showWork();
}

/** The palette over the window, on Herdr's palette geometry; again: closes it. */
export function openPalette(cx) {
  togglePalette(cx);
}

export default class Sidebar {
  init(_props, cx) {
    this.spaces = DEFAULT_SPACES;
    this.counts = {};
    this.place = null;
    this.width = 268;
    this.hover = new Hover();
    this.flashes = new Flashes();
    this.folded = new Set();
    this.repos = new Map();
    this.machineList = [];
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    this.drag = null;
    this.update = null;
    this.agents = new AgentsModel();
    this.agents.loadPins();
    this.agents.follow(cx, (value, before, cx) => this.agentsChanged(value, before, cx));
    this.unlend = lend(() => (this.agents.state === "live" ? this.agents.value : null));
    cx.spawn(async (cx) => {
      try {
        this.install = await hub.install();
        const { cache, home } = this.install;
        const text = (await readTextFile(`${cache}/config.json`)) ?? (await readTextFile(`${home}/.config/cockpit/config.json`));
        const pinned = text ? JSON.parse(text).spaces : null;
        if (Array.isArray(pinned)) this.spaces = pinned.map((s) => (typeof s === "string" ? s : s.name));
      } catch {}
      cx.notify();
    });
    // The hub writes update.json every six hours; a window left open picks a newer cockpit up on its own.
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          this.update = await pendingUpdate();
        } catch {
          this.update = null;
        }
        cx.notify();
        await hub.sleep(cx, 5 * 60 * 1000);
      }
    });
    // The sidebar is in every layout: it is where a page an agent opens brings the side panel to the browser.
    this.web = followBrowser(cx);
    const views = Object.entries(BADGE_FIELDS).map(([name, pick]) => ({ name, pick }));
    this.sub = hub.subscribe(cx, { views, notify: true }, (m, cx) => {
      if (m.view) this.counts[m.view] = appBadge(m.view, m.value);
      if (m.notify) this.toast(m.notify, cx);
      cx.notify();
    });
  }

  close() {
    this.unlend?.();
    this.sub?.stop();
    this.web?.stop();
    this.agents.stop();
    // Another layout draws no count: the badge goes with the sidebar, and a sidebar still drawn puts it back.
    showBadge(0);
  }

  /** A hub notification, as notify.js shows it: Herdr's toast in front, the system's behind. */
  toast(n, cx) {
    deliver(n, this.install, cx);
  }

  /** The agents menu's `flow.agents|…`; the window's are the runner's. */
  command(c, cx, key = null) {
    if (this.agents.command(c, cx, key)) return;
    cx.notify();
  }

  /** The agents view arrived: rows whose stage moved flash in its color. */
  agentsChanged(value, before, cx) {
    const was = new Map(rowsOf(before).map((r) => [r.terminal, r.stage]));
    for (const r of rowsOf(value)) if (was.has(r.terminal) && was.get(r.terminal) !== r.stage) this.flashes.start(cx, r.terminal, stageColor(r.stage));
  }

  /** Each space's repo, for nesting worktrees under their checkout: asked of git once per folder. */
  repoOf(cwd, cx) {
    if (!cwd || this.repos.has(cwd)) return this.repos.get(cwd) ?? null;
    this.repos.set(cwd, null);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd });
        if (r.code !== 0) return;
        const [top, common] = r.stdout.trim().split("\n");
        this.repos.set(cwd, { common, linked: common !== `${top}/.git` });
        cx.notify();
      } catch {}
    });
    return null;
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machineList = (JSON.parse(r.stdout).machines ?? []).filter(m => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  render(cx) {
    const k = tokens();
    const active = shared("flow.app") ?? "work";
    // A space or tab picked anywhere brings the work area back (Home keeps its own focused agent).
    const f = focused();
    const place = f ? `${f.space}/${f.tab}` : null;
    if (this.place !== null && place !== this.place && active !== screens().work && active !== "home" && active !== "tab") cx.timer.after(1, () => showWork());
    this.place = place;
    const rail = this.width < 160;
    const model = this.agents;
    const rows = model.rows;
    const waiting = rows.filter((r) => r.stage === "needs_you");
    const order = [...waiting, ...rows.filter((r) => r.stage !== "needs_you")];
    // Home and Needs answer them on their own cards: there the waiting agents stay in the list below. Without the hub
    // nothing answers in place, so they stay in the list too.
    const band = active === "home" || active === "needs" || model.down ? [] : waiting;
    if (!model.down) showBadge(needing(rows).length, option("dockBadge", true) !== false);
    setAgentOrder(order.filter(r => !r.remote).map((r) => r.address));

    const navItem = (child, label, icon, count, command, tone) => {
      const on = active === child;
      return h_flex()
        .id(`nav-${child}`)
        .h(30)
        .px(8)
        .gap(8)
        .items_center()
        .relative()
        .when(rail, (e) => e.justify_center())
        .rounded(RADIUS.md)
        .cursor_pointer()
        .text_size(TEXT.base)
        .font_medium()
        .text_color(on ? k.foreground : k.mutedFg)
        .when(on, (e) => e.bg(k.selected))
        .when(!on, (e) => e.hover((s) => s.bg(k.accent).text_color(k.foreground)))
        .on_click((_e, cx) => {
          show(child);
          cx.notify();
        })
        .tooltip(hint(label, command))
        .child(Icon(icon, { size: 16 }))
        .when(!rail, (e) => e.child(div().flex_1().truncate().child(label)))
        .when(Boolean(count) && !rail, (e) =>
          e.child(
            h_flex()
              .h(18)
              .min_w(18)
              .px(5)
              .items_center()
              .justify_center()
              .rounded(9)
              .bg(tone ? alpha(tone, 0.16) : k.muted)
              .text_size(TEXT.xs)
              .font_semibold()
              .text_color(tone ?? k.foreground)
              .child(String(count)),
          ),
        )
        .when(Boolean(count) && rail, (e) => e.child(div().absolute().top(4).right(6).size(7).rounded(4).bg(tone ?? k.ring)));
    };
    const apps = this.spaces.filter((s) => APPS[s]).map((s) => ({ ...APPS[s], child: APPS[s].child ?? s, command: `flow.go:${APPS[s].child ?? s}` }));
    const badge = (child) => this.counts[child] ?? shared(`badge.${child}`) ?? null;
    const tone = (child) => { const t = badge(child)?.tone; return t ? k[t] ?? t : null; };
    const counts = countsOf(model.value);
    const home = screens().list.find((x) => x.child === "home");
    const lead = [{ child: "home", label: "Home", icon: "layout-dashboard", command: home.command, count: counts.unread || null, tone: counts.needs_you ? k.blocked : null }];
    const paletteKey = keyFor("flow.palette");

    return v_flex()
      .id("flow-sidebar")
      .size_full()
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        this.drag = null;
        this.appDrag = null;
        cx.notify();
      })
      .px(rail ? 6 : 10)
      .py(6)
      .gap(1)
      .when(!rail, (e) =>
        e.child(
          h_flex()
            .id("palette-open")
            .h(32)
            .mb(8)
            .px(10)
            .gap(8)
            .items_center()
            .rounded(RADIUS.md)
            .border_1()
            .border_color(k.input)
            .bg(k.background)
            .cursor_pointer()
            .hover((s) => s.border_color(k.ring))
            .on_click(() => openPalette())
            .child(Icon("search", { size: 14, color: k.mutedFg }))
            .child(div().flex_1().text_size(TEXT.sm).text_color(k.mutedFg).child("Search or run…"))
            .when(Boolean(paletteKey), (e) => e.child(Kbd(keyText(paletteKey ?? "")))),
        ),
      )
      .when(!rail && Boolean(model.value?.quota?.length || rows.length), (e) =>
        e.child(div().id("quota-box").mb(8).px(4).child(QuotaBars(model.value?.quota, { compact: true, big: true, rows }))),
      )
      .when(rail, (e) =>
        e
          .children(lead.map((a) => navItem(a.child, a.label, a.icon, a.count, a.command, a.tone)))
          .children(apps.map((a) => navItem(a.child, a.label, a.icon, badge(a.child)?.count || null, a.command, tone(a.child)))),
      )
      .when(!rail, (e) =>
        e.child(
          this.appStrip(k, active, [...lead, ...apps.map((a) => ({ ...a, count: badge(a.child)?.count || null, tone: tone(a.child) }))]),
        ),
      )
      .child(div().h(1).my(8).bg(k.border))
      .child(
        v_flex()
          .id("sidebar-scroll")
          .flex_1()
          .min_h(0)
          .gap(2)
          .overflow_y_scrollbar()
          .when(rail, (e) => e.children(this.railRows(k, rows)))
          // The agents list stays out (each space lists what runs in it); it shows only to start a stopped hub.
          .when(!rail, (e) => e.children([UndoRow("band-undo", model), ...this.bandRows(k, band), ...(model.down && !rows.length ? this.agentRows(k, rows, band, cx) : []), ...this.spaceRows(k, cx)].filter(Boolean))),
      )
      .when(Boolean(this.update), (e) => e.child(UpdateTag("update-tag", this.update, { rail })))
      .child(div().mt(4).child(SettingsLink("sidebar-settings", { rail })))
      .child(HerdrLinks("sidebar-herdr", { rail }));
  }

  /** The pinned apps as a row of tiles (label and key in the tooltip, count as a badge): the list below keeps the room. */
  appStrip(k, active, items) {
    return h_flex()
      .id("app-strip")
      .gap(2)
      .p(3)
      .rounded(RADIUS.lg)
      .bg(alpha(k.muted, 0.6))
      .children(
        items.map((a) => {
          const on = active === a.child;
          // Home (and Needs) stay first; the pinned apps move by drag and drop, the config's order following.
          const movable = a.child !== "home" && a.child !== "needs";
          const d = this.appDrag;
          const dragging = d && d.from === a.child && d.over !== a.child;
          const over = d && d.over === a.child && d.from !== a.child;
          return h_flex()
            .id(`nav-${a.child}`)
            .flex_1()
            .h(30)
            .relative()
            .items_center()
            .justify_center()
            .rounded(RADIUS.md)
            .cursor_pointer()
            .text_color(on ? k.foreground : k.mutedFg)
            .when(on, (e) => e.bg(k.background).shadow_sm())
            .when(!on, (e) => e.hover((s) => s.bg(k.accent).text_color(k.foreground)))
            .when(Boolean(dragging), (e) => e.opacity(0.4))
            .when(Boolean(over), (e) => e.child(div().absolute().top(4).bottom(4).w(2).rounded(1).bg(k.ring).when(this.appDropAfter(a.child), (l) => l.right(0)).when(!this.appDropAfter(a.child), (l) => l.left(0))))
            .when(movable, (e) =>
              e
                .on_mouse_down("left", () => {
                  this.appDrag = { from: a.child, over: a.child };
                })
                .on_mouse_move((_e, cx) => {
                  if (this.appDrag && this.appDrag.over !== a.child) {
                    this.appDrag.over = a.child;
                    cx.notify();
                  }
                })
                .on_mouse_up("left", (_e, cx) => {
                  const drag = this.appDrag;
                  this.appDrag = null;
                  if (drag && drag.from !== a.child) {
                    cx.stop_propagation();
                    this.moveApp(drag.from, a.child);
                    cx.notify();
                  }
                }),
            )
            .on_click((_e, cx) => {
              show(a.child);
              cx.notify();
            })
            .tooltip(hint(a.label, a.command))
            .child(Icon(a.icon, { size: 16 }))
            .when(Boolean(a.count), (e) => e.child(CornerCount(a.count, { tone: a.tone ?? k.primary, top: -3, right: -2 })));
        }),
      );
  }

  /** Whether a drop on `child` lands after it: dragging rightwards. */
  appDropAfter(child) {
    const d = this.appDrag;
    return Boolean(d) && this.spaces.indexOf(d.from) < this.spaces.indexOf(child);
  }

  /** Moves a pinned app to where another one is, then saves the order and re-pins herdr's spaces to match. */
  moveApp(from, to) {
    const order = this.spaces.filter((s) => s !== from);
    const at = order.indexOf(to) + (this.spaces.indexOf(from) < this.spaces.indexOf(to) ? 1 : 0);
    order.splice(at, 0, from);
    this.spaces = order;
    hub.act("home", "pin_order", [order]).catch(() => undefined);
  }

  /** The Needs you band: each waiting agent's question, answered in place. */
  bandRows(k, band) {
    if (!band.length) return [];
    const shown = band.slice(0, 3);
    const now = Date.now();
    return [
      StageHeading("band-head", "Needs you", { color: k.blocked, count: band.length, pulse: true }),
      ...shown.map((r) =>
        QuestionCard(`band-${r.terminal}`, r, this.agents, {
          header: h_flex()
            .gap(6)
            .items_center()
            .child(AgentLogo(r, { size: 13, tooltip: r.agent_name, id: `band-${r.terminal}-logo` }))
            .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).font_semibold().text_color(k.foreground).child(r.title || r.tab?.name || r.address))
            .child(div().flex_none().text_size(TEXT.xs).text_color(k.blocked).child(dur(now - (r.since ?? now)))),
        }),
      ),
      band.length > shown.length
        ? h_flex()
            .id("band-more")
            .h(26)
            .px(8)
            .items_center()
            .rounded(RADIUS.md)
            .cursor_pointer()
            .text_size(TEXT.xs)
            .text_color(k.mutedFg)
            .hover((s) => s.bg(k.accent))
            .on_click(() => openRecap())
            .tooltip(hint("Recap of every agent", "flow.recap"))
            .child(`${band.length - shown.length} more waiting · open the recap`)
            .when(Boolean(keyFor("flow.recap")), (e) => e.gap(6).child(Kbd(keyText(keyFor("flow.recap") ?? ""))))
        : null,
      div().h(6),
    ].filter(Boolean);
  }

  /** An agent's row: its mark, title, what stands out (CI, PR, changes), how long; hover for its recap. */
  agentRow(k, r, now, cx, { indent = 0 } = {}) {
    const id = `ag-${r.terminal}`;
    const hovered = this.hover.is(id);
    const pinned = this.agents.pins.includes(r.terminal);
    const focusedNow = focused()?.terminal === r.address;
    const parts = [];
    if (r.ci?.state === "fail") parts.push(div().text_color(k.destructive).child(r.ci.label));
    else if (r.ci?.state === "running") parts.push(div().text_color(k.working).child(r.ci.label));
    if (r.pr) parts.push(div().child(`#${r.pr.number}${r.pr.review === "APPROVED" ? " approved" : r.pr.review === "CHANGES_REQUESTED" ? " changes asked" : ""}`));
    if (r.changes?.files) parts.push(h_flex().gap(3).child(div().text_color(k.success).child(`+${r.changes.add}`)).child(div().text_color(k.destructive).child(`−${r.changes.del}`)));
    if (!parts.length && r.said) parts.push(div().min_w(0).truncate().italic().child(r.said));
    // A session cockpit drives has no terminal: the row says so.
    const reads = r.paused ? "Paused · picks up when you write" : "Runs without a terminal";
    if (r.driven) parts.unshift(h_flex().min_w(0).gap(4).items_center().child(Icon("bot", { size: 11 })).child(div().min_w(0).truncate().child(reads)));
    const flash = this.flashes.of(r.terminal);
    const row = h_flex()
      .id(id)
      .relative()
      .min_h(parts.length ? 42 : 30)
      .py(4)
      .pl(8 + indent)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(RADIUS.md)
      .cursor_pointer()
      .when(focusedNow, (e) => e.bg(k.selected))
      .when(!focusedNow, (e) => e.hover((s) => s.bg(k.accent)))
      .when(Boolean(flash), (e) =>
        e.child(div().id(`${id}-flash`).absolute().inset_0().rounded(RADIUS.md).bg(alpha(flash.color ?? k.ring, 0.28)).opacity(flash.on ? 1 : 0).transition("opacity", { duration: 1600, easing: "ease-out" })),
      )
      .on_click((_e, cx) => this.agents.go(cx, r))
      .on_mouse_down("right", () => this.agents.menu(r))
      .child(h_flex().w(14).flex_none().justify_center().child(StageMark(id, r.stage, { status: r.status })))
      .child(AgentLogo(r, { size: 14, tooltip: r.agent_name, id: `${id}-logo` }))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().truncate().text_size(TEXT.base).text_color(r.stage === "idle" || r.stage === "merged" ? k.mutedFg : k.foreground).child(r.title || r.tab?.name || r.address))
          .when(parts.length > 0, (e) => e.child(h_flex().min_w(0).gap(6).text_size(TEXT.xs).text_color(k.mutedFg).children(parts))),
      )
      .when(hovered, (e) =>
        e.child(
          h_flex()
            .gap(2)
            .flex_none()
            // A dismissed agent comes back from its own row.
            .when(Boolean(r.dismissed) && !r.remote, (h) => h.child(Button(`${id}-restore`, { icon: "undo", variant: "ghost", size: "icon-sm", tooltip: "Bring back to Needs you", onClick: (_e, cx) => (cx.stop_propagation(), this.agents.dismiss(cx, r)) })))
            .child(Button(`${id}-pin`, { icon: pinned ? "pin-off" : "pin", variant: "ghost", size: "icon-sm", tooltip: pinned ? "Unpin" : "Pin to the top", onClick: (_e, cx) => (cx.stop_propagation(), this.agents.togglePin(r.terminal), cx.notify()) }))
            .child(Button(`${id}-more`, { icon: "more", variant: "ghost", size: "icon-sm", tooltip: r.driven ? "Read, open in a terminal, recap…" : "Snooze, recap, fork…", onClick: (_e, cx) => (cx.stop_propagation(), this.agents.menu(r)) })),
        ),
      )
      .when(!hovered, (e) =>
        e
          .when(Boolean(r.unread), (el) => el.child(div().size(6).flex_none().rounded(3).bg(stageColor(r.stage))))
          .child(div().flex_none().text_size(TEXT.xs).text_color(r.stage === "snoozed" ? k.info : k.dim).child(r.stage === "snoozed" ? r.snoozed?.label?.replace("until ", "") ?? "" : r.stage === "dismissed" ? "dismissed" : dur(now - (r.since ?? now)))),
      );
    const tracked = this.hover.track(row, id);
    const recap = r.recap?.text;
    const card = v_flex()
      .gap(8)
      .child(h_flex().gap(8).items_center().child(StageMark(`${id}-hc`, r.stage, { status: r.status })).child(AgentLogo(r, { size: 14 })).child(div().flex_1().font_semibold().child(r.title || r.address)).child(div().text_size(TEXT.xs).text_color(stageColor(r.stage)).child(stageAge(r, now))))
      .child(div().text_size(TEXT.sm).text_color(recap ? k.foreground : k.mutedFg).child(recap || (r.recap?.running ? "Recapping…" : r.said || "No recap yet: right-click › Recap.")))
      .child(h_flex().flex_wrap().gap(4).children(Chips(r, { id: `${id}-hc` })))
      .child(div().text_size(TEXT.xs).text_color(k.dim).child(`${r.agent_name ? `${r.agent_name} · ` : ""}${r.driven ? `A session cockpit drives · ${String(r.cwd ?? "").split("/").pop()}` : `${r.space?.name ?? ""} · ${r.tab?.name ?? ""}`}${r.cost ? ` · ~$${r.cost.toFixed(2)} estimated` : ""}${r.context ? ` · context ${Math.round(r.context)}%` : ""}`));
    return HoverCard(`${id}-hover`, tracked, card, { width: 340, openDelay: 650 });
  }

  /** Sub-agents an agent started (`hc run`), under it with tree lines; a click peeks. */
  subRows(k, r) {
    if (r.remote) return [];
    const kids = (terminals() ?? []).filter((t) => t.parent === r.address && t.state === "live");
    return kids.map((t, i) =>
      h_flex()
        .id(`sub-${t.address}`)
        .h(24)
        .pl(26)
        .pr(8)
        .gap(6)
        .items_center()
        .rounded(RADIUS.md)
        .cursor_pointer()
        .hover((s) => s.bg(k.accent))
        .on_click(() => run("terminal.peek", { terminal: t.address }))
        .child(div().text_size(TEXT.xs).text_color(k.dim).child(i === kids.length - 1 ? "└" : "├"))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.mutedFg).child(t.name || t.template || t.program?.name || t.address))
        .child(StageMark(`sub-${t.address}`, { working: "working", blocked: "needs_you", failed: "failed" }[agentStatus(t.status)] ?? "idle", { size: 6 })),
    );
  }

  /** The agents not in the band, by ticket (else their space), by space, or by stage; pinned ones first. */
  agentRows(k, rows, band, cx) {
    const now = Date.now();
    const rest = rows.filter((r) => !band.includes(r));
    const mode = shared("flow.agents.group") ?? "ticket";
    const MODES = { ticket: ["ticket", "By ticket"], space: ["layers", "By space"], stage: ["list-ordered", "By whose move"] };
    const next = { ticket: "space", space: "stage", stage: "ticket" }[mode] ?? "ticket";
    const head = SectionHeader("Agents", {
      count: rows.length || undefined,
      action: h_flex()
        .gap(2)
        .child(Button("agents-recap", { icon: "sparkles", variant: "ghost", size: "icon-sm", tooltip: hint("Recap of every agent", "flow.recap"), onClick: () => openRecap() }))
        .child(Button("agents-group", { icon: MODES[mode][0], variant: "ghost", size: "icon-sm", tooltip: `${MODES[mode][1]} · click for ${MODES[next][1].toLowerCase()}`, onClick: () => setShared("flow.agents.group", next) })),
    });
    if (!rows.length) {
      const state = this.agents.state;
      // A hub that stopped, on purpose or not, can be started from here on this machine.
      const why = String(this.agents.lastError ?? "");
      if (this.agents.down && !hub.isNotInstalled(why) && !hub.remoteMachine()) return [head, div().px(8).pb(8).child(HubDown("sidebar-hub-down", this, why.replace(/^error: /, ""), k))];
      const hint = state === "live" || hub.isNotInstalled(state)
        ? "No agent yet. Agents show here once they report their status."
        : state === "connecting" ? "Connecting to the cockpit hub…" : "The runner's cockpit hub is not answering.";
      return [head, div().px(8).pb(8).text_size(TEXT.xs).text_color(k.dim).child(hint)];
    }
    const pinned = rest.filter((r) => this.agents.pins.includes(r.terminal));
    const others = rest.filter((r) => !this.agents.pins.includes(r.terminal));
    const groups = [];
    if (pinned.length) groups.push({ id: "pinned", label: "Pinned", members: pinned });
    const keyOf = (r) => (mode === "ticket" ? r.ticket?.key ?? `space:${r.space?.id}` : mode === "space" ? `space:${r.space?.id}` : r.stage);
    for (const r of others) {
      const id = keyOf(r);
      let g = groups.find((x) => x.id === id);
      if (!g) {
        const t = mode === "ticket" ? r.ticket : null;
        const label = t ? t.key : mode === "stage" ? STAGES[r.stage]?.label ?? r.stage : r.space?.name || "Agents";
        g = { id, label, title: t?.title, url: t?.url, ticket: t?.key, stage: mode === "stage" ? r.stage : null, members: [] };
        groups.push(g);
      }
      g.members.push(r);
    }
    const tickets = new Map((this.agents.value?.tickets ?? []).map((t) => [t.key, t]));
    if (mode === "stage") groups.sort((a, b) => Object.keys(STAGES).indexOf(a.id) - Object.keys(STAGES).indexOf(b.id));
    const out = [head];
    for (const g of groups) {
      const folded = this.folded.has(g.id);
      const time = g.ticket ? tickets.get(g.ticket)?.today : null;
      out.push(
        h_flex()
          .id(`grp-${g.id}`)
          .h(26)
          .mt(4)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(RADIUS.md)
          .cursor_pointer()
          .text_size(TEXT.xs)
          .hover((s) => s.bg(k.accent))
          .on_click((_e, cx) => {
            folded ? this.folded.delete(g.id) : this.folded.add(g.id);
            cx.notify();
          })
          .on_mouse_down("right", () => g.url && run("flow.target:" + g.url))
          .when(Boolean(g.stage), (e) => e.child(StageMark(`grp-${g.id}`, g.stage, { size: 6 })))
          .when(Boolean(g.ticket), (e) => e.child(Icon("ticket", { size: 12, color: k.info })))
          .child(div().flex_none().font_semibold().text_color(g.stage ? stageColor(g.stage) : k.mutedFg).child(g.label))
          .children(providersOf(g.members).map((p) => AgentLogo(p, { size: 11, tooltip: p.name, id: `grp-${g.id}-${p.icon}` })))
          .when(Boolean(g.title), (e) => e.child(div().flex_1().min_w(0).truncate().text_color(k.dim).child(g.title)))
          .when(!g.title, (e) => e.child(div().flex_1()))
          .when(Boolean(time), (e) => e.child(div().flex_none().text_color(k.dim).tooltip(`Agents worked ${hours(time)} on it today`).child(hours(time))))
          .when(folded, (e) => e.child(div().flex_none().text_color(k.dim).child(String(g.members.length))))
          .child(Icon(folded ? "chevron-right" : "chevron-down", { size: 12, color: k.dim })),
      );
      if (folded) continue;
      for (const r of g.members) {
        out.push(this.agentRow(k, r, now, cx));
        out.push(...this.subRows(k, r));
      }
    }
    out.push(div().h(8));
    return out;
  }

  /** The threads as stored, once the spaces Herdr lists now are read: a new thread's space found, a closed one's dropped. */
  threadStore(sp) {
    const stored = shared(THREADS);
    const ready = machines();
    const loaded = (m) => ready.find((x) => (x.name ?? null) === (m ?? null))?.layout === "ready";
    let next = settleThreads(stored, sp, { loaded });
    // A thread on another machine opened its first pane as a bridge there: it is remembered as one, for its splits and
    // its Reconnect, once.
    const ps = panes();
    for (const u of unbridged(next, sp, ps)) {
      setShared(BRIDGES, remember(shared(BRIDGES), u.pane, u.where.machine, u.where.folder, new Set(ps.map((p) => p.pane)), u.where.argv));
      next = bridged(next, u.id, u.pane);
    }
    if (next !== stored) setShared(THREADS, next);
    return next;
  }

  /** A thread's menu: edit it, rename it, its kind, mark it resolved, leave it as a plain space, close it. */
  threadMenu(s, thread) {
    openMenu(
      [
        { label: "Edit thread…", icon: "sliders-horizontal", command: `thread:edit|${s.id}` },
        { label: "Rename…", icon: "pencil", run: ["space.rename", { id: s.id }] },
        "separator",
        ...KINDS.map(([kind, label, icon]) => ({ label, icon, check: thread.kind === kind, command: `thread:kind|${s.id}|${kind}` })),
        "separator",
        { label: "Mark resolved…", icon: "circle-check", command: `thread:confirm|${s.id}` },
        { label: "Not a thread", icon: "folder-output", command: `thread:release|${s.id}` },
        "separator",
        { label: "Close thread", icon: "trash-2", run: ["space.close", { id: s.id }] },
      ],
      { width: 220 },
    );
  }

  /** The Threads section's header, with a new thread. */
  threadHead(count) {
    return SectionHeader("Threads", {
      id: "threads-head",
      count: count || undefined,
      action: Button("thread-new", { icon: "plus", variant: "ghost", size: "icon-sm", tooltip: hint("New thread", "flow.thread"), onClick: () => run("flow.thread:new|fix") }),
    });
  }

  /**
   * A thread as a card: its kind's tile, its title, its kind, where it works, how many panes and how long it has been
   * open, then what its agents are doing. Nothing in it is a link of its own: a click shows the thread, a drag moves
   * it, a double-click renames it, a right-click opens its menu, and ✓ asks before resolving it.
   */
  threadCard(k, { s, i, thread }, { colors, ps, byAddress, sp }) {
    const STATUS = { blocked: "needs_you", failed: "failed", working: "working", done: "done", idle: "idle" };
    const stageOf = (p) => (p.terminal ? (byAddress.get(p.terminal)?.stage ?? STATUS[agentStatus(p.status)] ?? null) : null);
    const act = activity(s, ps, stageOf);
    const on = s.active && (shared("flow.app") ?? "work") === "work";
    const fill = colors[s.id] ?? k.ring;
    const [, kindLabel, kindIcon] = kindOf(thread.kind);
    const where = machineWords(thread.where ? thread.where.machine : s.machine);
    const dragging = this.drag && this.drag.from === i;
    const over = this.drag && this.drag.over === i && this.drag.from !== i;
    const urgent = act.needs_you > 0 ? k.blocked : act.failed > 0 ? k.destructive : null;
    const meta = [kindLabel, where, act.panes === 0 ? "no panes" : `${act.panes} ${act.panes === 1 ? "pane" : "panes"}`, ago(thread.at)].filter(Boolean).join(" · ");
    const states = [
      ["needs_you", act.needs_you, act.needs_you === 1 ? "needs you" : "need you"],
      ["failed", act.failed, "stopped"],
      ["working", act.working, "working"],
      ["done", act.done, "done"],
    ].filter(([, n]) => n > 0);
    const resolveButton = h_flex()
      .id(`thread-resolve-${s.id}`)
      .size(24)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(RADIUS.md)
      .hover((st) => st.bg(k.accent))
      .tooltip("Mark resolved: closes its panes")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.drag = null;
        askResolve(s.id);
      })
      .child(Icon("circle-check", { size: 15, color: k.dim }));
    return v_flex()
      .id(`thread-${s.id}`)
      .relative()
      .mb(4)
      .pl(12)
      .pr(8)
      .py(10)
      .gap(6)
      .rounded(RADIUS.lg)
      // Over Daylight's sky a thread is a plain row, the shown one lit; elsewhere each is a card of its own.
      .when(!k.sky, (e) => e.border_1().border_color(on ? alpha(k.ring, 0.55) : alpha(k.border, 0.6)).bg(on ? k.selected : alpha(k.card, 0.6)))
      .when(k.sky && on, (e) => e.bg(k.accent))
      .cursor_pointer()
      .when(!on, (e) => e.hover((st) => st.bg(k.accent)))
      .when(Boolean(dragging) && this.drag?.over !== i, (e) => e.opacity(0.5))
      .when(Boolean(over), (e) => e.child(div().absolute().left(0).right(0).h(2).bg(k.ring).when(this.drag.from < i, (l) => l.bottom(-3)).when(this.drag.from > i, (l) => l.top(-3))))
      .when(Boolean(urgent), (e) => e.child(div().absolute().left(0).top(10).bottom(10).w(3).rounded(2).bg(urgent)))
      .on_mouse_down("left", () => {
        this.drag = { from: i, over: i };
      })
      .on_mouse_move((_e, cx) => {
        const from = this.drag && sp[this.drag.from];
        if (from && (from.machine ?? null) === (s.machine ?? null) && this.drag.over !== i) {
          this.drag.over = i;
          cx.notify();
        }
      })
      .on_mouse_up("left", (e, cx) => {
        const d = this.drag;
        this.drag = null;
        if (d && d.over === i && d.from !== i) run("space.move", { id: sp[d.from].id, index: i + 1 });
        else if (e.click_count > 1) run("space.rename", { id: s.id });
        else {
          run("space.select", { id: s.id });
          showSpace(s.id);
        }
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.drag = null;
        this.threadMenu(s, thread);
      })
      .child(
        h_flex()
          .gap(10)
          .items_start()
          .child(h_flex().mt(1).size(k.sky ? 24 : 28).flex_none().rounded(k.sky ? 6 : 7).bg(fill).items_center().justify_center().child(Icon(kindIcon, { size: 15, color: inkOn(fill, "#ffffff") })))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().truncate().text_size(TEXT.base).when(k.sky, (e) => e.font_medium()).when(!k.sky, (e) => e.font_semibold()).text_color(k.foreground).child(s.name))
              .child(h_flex().gap(4).items_center().min_w(0).text_size(TEXT.xs).text_color(k.dim).when(Boolean(thread.where), (e) => e.child(Icon("server", { size: 10 }))).child(div().truncate().child(meta))),
          )
          .child(h_flex().flex_none().child(resolveButton)),
      )
      .when(states.length > 0, (e) =>
        e.child(
          h_flex()
            .pl(38)
            .gap(10)
            .flex_wrap()
            .text_size(TEXT.xs)
            .text_color(k.mutedFg)
            .children(states.map(([stage, n, word]) => h_flex().gap(5).items_center().child(StageMark(`thread-${s.id}-${stage}`, stage, { size: 6 })).child(`${n} ${word}`))),
        ),
      );
  }

  /** The threads marked resolved, folded until opened: each a line of its own, right-click to take it off the list. */
  resolvedRows(k) {
    const resolved = threadsOf(shared(THREADS)).resolved;
    if (!resolved.length) return [];
    const open = shared("flow.threads.resolved.open") === true;
    const head = SectionHeader("Resolved", {
      id: "resolved-head",
      count: resolved.length,
      action: h_flex()
        .gap(2)
        .when(open, (e) =>
          e.child(
            Button("resolved-clear", {
              icon: "trash-2",
              variant: "ghost",
              size: "icon-sm",
              tooltip: "Clear the resolved list",
              onClick: () => openMenu([{ label: "Clear the resolved list", icon: "trash-2", destructive: true, command: "thread:forget|*" }], { width: 240 }),
            }),
          ),
        )
        .child(
          Button("resolved-toggle", {
            icon: open ? "chevron-down" : "chevron-right",
            variant: "ghost",
            size: "icon-sm",
            tooltip: open ? "Hide the resolved threads" : "Show the resolved threads",
            onClick: () => setShared("flow.threads.resolved.open", !open),
          }),
        ),
    });
    if (!open) return [head];
    return [
      head,
      ...resolved.map((r) =>
        h_flex()
          .id(`resolved-${r.id}`)
          .h(28)
          .px(10)
          .gap(8)
          .items_center()
          .rounded(RADIUS.md)
          .text_size(TEXT.sm)
          .text_color(k.mutedFg)
          .hover((st) => st.bg(k.accent))
          .tooltip(`${kindOf(r.kind)[1]} · resolved ${ago(r.resolvedAt)} ago${r.where ? ` · on ${machineWords(r.where.machine)}` : ""}  (right-click to remove)`)
          .on_mouse_down("right", () => openMenu([{ label: "Remove from Resolved", icon: "x", command: `thread:forget|${r.id}` }], { width: 220 }))
          .child(Icon("circle-check", { size: 13, color: k.success }))
          .child(div().flex_1().min_w(0).truncate().line_through().child(r.title))
          .child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(ago(r.resolvedAt))),
      ),
    ];
  }

  /** The threads, then the other spaces folded under them, as Herdr's list has them: colored avatar (a thread's kind),
   * branch, drag to reorder, its menu on right-click, worktrees under their checkout, grouped by machine once one is
   * remote. */
  spaceRows(k, cx) {
    const sp = spaces();
    const ps = panes();
    const colors = this.spaceColors(sp);
    const { threads } = splitThreads(this.threadStore(sp), sp);
    const threadOf = new Map(threads.map((t) => [t.space.id, t.thread]));
    const placeOf = (s) => {
      const tabs = new Set((s.tabs ?? []).map((t) => t.id));
      return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
    };
    const info = sp.map((s, i) => ({ s, i, repo: s.machine ? null : this.repoOf(placeOf(s), cx) })).filter((r) => !threadOf.has(r.s.id));
    const mains = new Set(info.filter((r) => r.repo && !r.repo.linked).map((r) => r.repo.common));
    const nested = (r) => r.repo?.linked && mains.has(r.repo.common);
    const ordered = [];
    for (const r of info) {
      if (nested(r)) continue;
      ordered.push({ ...r, tree: false });
      if (r.repo && !r.repo.linked) for (const kid of info.filter((x) => nested(x) && x.repo.common === r.repo.common)) ordered.push({ ...kid, tree: true });
    }
    const machineNames = [...new Set([...sp.map(s => s.machine).filter(Boolean), ...machines().map(m => m.name).filter(Boolean), ...this.machineList.map(m => m.name)])].sort();
    const row = ({ s, i, tree }) => {
      const on = s.active && (shared("flow.app") ?? "work") === "work";
      const fill = colors[s.id] ?? k.ring;
      const dragging = this.drag && this.drag.from === i;
      const over = this.drag && this.drag.over === i && this.drag.from !== i;
      const urgent = ["blocked", "failed", "done"].includes(agentStatus(s.status));
      return h_flex()
        .id(`space-${s.id}`)
        .relative()
        .h(tree ? 26 : 30)
        .pl(tree ? 30 : 8)
        .pr(8)
        .gap(8)
        .items_center()
        .rounded(RADIUS.md)
        .cursor_pointer()
        .text_size(TEXT.base)
        .text_color(on ? k.foreground : k.mutedFg)
        .when(on, (e) => e.bg(k.selected))
        .when(!on, (e) => e.hover((st) => st.bg(k.accent).text_color(k.foreground)))
        .when(Boolean(dragging) && this.drag?.over !== i, (e) => e.opacity(0.5))
        .when(Boolean(over), (e) => e.child(div().absolute().left(0).right(0).h(2).bg(k.ring).when(this.drag.from < i, (l) => l.bottom(0)).when(this.drag.from > i, (l) => l.top(0))))
        .on_mouse_down("left", () => {
          this.drag = { from: i, over: i };
        })
        .on_mouse_move((_e, cx) => {
          const from = this.drag && sp[this.drag.from];
          if (from && (from.machine ?? null) === (s.machine ?? null) && this.drag.over !== i) {
            this.drag.over = i;
            cx.notify();
          }
        })
        .on_mouse_up("left", (e, cx) => {
          const d = this.drag;
          this.drag = null;
          if (d && d.over === i && d.from !== i) run("space.move", { id: sp[d.from].id, index: i + 1 });
          else if (e.click_count > 1) run("space.rename", { id: s.id });
          else {
            run("space.select", { id: s.id });
            showSpace(s.id);
          }
          cx.notify();
        })
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
        .tooltip(`${s.name}${s.branch ? ` · ${s.branch}` : ""}  (double-click to rename, drag to move)`)
        .when(tree, (e) => e.child(Icon("git-branch", { size: 13, color: k.dim })))
        .when(!tree, (e) =>
          e.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color(inkOn(fill, "#ffffff")).child([...s.name][0]?.toUpperCase() ?? "?")),
        )
        .child(div().flex_shrink_1().min_w(0).truncate().font_medium().child(s.name))
        .child(div().flex_1())
        .when(Boolean(s.branch) && !["main", "master"].includes(s.branch) && s.branch !== s.name, (e) => e.child(div().max_w(96).truncate().text_size(TEXT.xs).text_color(k.dim).child(s.branch)))
        .when(urgent, (e) => e.child(div().size(7).flex_none().rounded(4).bg(statusColor(k, agentStatus(s.status)))))
        .when(hasTerms(s), (e) => e.child(this.foldButton(k, s, folded)));
    };
    // Each space's terminal lines fold away, one space with its chevron or all of them from the header.
    const byAddress = new Map(this.agents.rows.map((r) => [r.address, r]));
    const folded = new Set(shared("flow.spaces.folded") ?? []);
    const hasTerms = (s) => this.termRows(k, s, ps, byAddress, false).length > 0;
    const withLines = ordered.filter((r) => hasTerms(r.s));
    const allFolded = withLines.length > 0 && withLines.every((r) => folded.has(r.s.id));
    const othersOpen = shared("flow.spaces.others") === true;
    // The spaces that aren't threads, folded by default: only the button that opens them shows then.
    const head = SectionHeader("Other spaces", {
      id: "spaces-head",
      count: ordered.length,
      action: h_flex()
        .gap(2)
        .when(othersOpen && withLines.length > 0, (e) =>
          e.child(
            Button("spaces-fold", {
              icon: allFolded ? "chevrons-up-down" : "chevrons-down-up",
              variant: "ghost",
              size: "icon-sm",
              tooltip: allFolded ? "Show what runs in each space" : "Hide what runs in each space",
              onClick: () => {
                const ids = new Set(withLines.map((r) => r.s.id));
                const rest = [...folded].filter((id) => !ids.has(id));
                setShared("flow.spaces.folded", allFolded ? rest : [...rest, ...ids]);
              },
            }),
          ),
        )
        .when(othersOpen && machineNames.length > 0, (e) => e.child(Button("folder-new", { icon: "folder-plus", variant: "ghost", size: "icon-sm", tooltip: "New folder for machines", onClick: () => openFolderName() })))
        .when(othersOpen, (e) => e.child(Button("space-new", { icon: "plus", variant: "ghost", size: "icon-sm", tooltip: hint("New space", "space.new"), onClick: () => run("space.new") })))
        .child(
          Button("spaces-others", {
            icon: othersOpen ? "chevron-down" : "chevron-right",
            variant: "ghost",
            size: "icon-sm",
            tooltip: othersOpen ? "Hide the spaces that aren't threads" : "Show the spaces that aren't threads",
            onClick: () => setShared("flow.spaces.others", !othersOpen),
          }),
        ),
    });
    const withTerms = (r) => [row(r), ...(folded.has(r.s.id) ? [] : this.termRows(k, r.s, ps, byAddress, r.tree))];
    // The threads lead as cards, in Herdr's order, then the resolved ones; the spaces that aren't threads follow, folded
    // until opened.
    const cards = threads.map((t) => this.threadCard(k, { s: t.space, i: sp.indexOf(t.space), thread: t.thread }, { colors, ps, byAddress, sp }));
    const lead = [
      this.threadHead(threads.length),
      ...(cards.length
        ? [v_flex().id("thread-cards").px(4).children(cards)]
        : [
            h_flex()
              .id("thread-empty")
              .h(26)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(RADIUS.md)
              .cursor_pointer()
              .text_size(TEXT.xs)
              .text_color(k.dim)
              .hover((st) => st.bg(k.accent).text_color(k.foreground))
              .tooltip("A fix, a feature or a bug, as a space on the main machine")
              .on_click(() => run("flow.thread:new|fix"))
              .child(Icon("plus", { size: 12 }))
              .child("New thread"),
          ]),
      ...this.resolvedRows(k),
    ];
    if (!ordered.length) return lead;
    if (!othersOpen) return [...lead, head];
    if (!machineNames.length) return [...lead, head, ...ordered.flatMap(withTerms)];
    const groups = normalizeFolders(shared(FOLDERS));
    const states = new Map(this.machineList.map((x) => [x.name, x.state]));
    const isUp = (m) => m === null || states.get(m) === "connected";
    // A machine's header and its spaces, indented one step inside a folder.
    const machineBlock = (m, inFolder) => {
      const machine = this.machineList.find(x => x.name === m);
      const layout = machines().find(x => x.name === m)?.layout;
      const loading = layout === "loading" || (!layout && machine?.state === "connected");
      const connected = isUp(m);
      const state = (machine?.state ?? "asleep").replace(/_/g, " ");
      const key = machineKey(m);
      const holder = groups.find((g) => g.machines.includes(key));
      const menu = () =>
        openMenu(
          [
            { label: "New space there", icon: "plus", command: `folder:space|${key}` },
            "separator",
            ...groups.filter((g) => g.id !== holder?.id).map((g) => ({ label: `Move to ${g.name}`, icon: "folder-input", command: `folder:move|${g.id}|${key}` })),
            { label: "New folder with this machine…", icon: "folder-plus", command: `folder:new|${key}` },
            holder && { label: `Remove from ${holder.name}`, icon: "folder-output", command: `folder:out|${key}` },
          ],
          { width: 250 },
        );
      const rows = [
        h_flex()
          .id(`machine-${m ?? "local"}`)
          .h(24)
          .px(8)
          .gap(6)
          .items_center()
          .text_size(TEXT.xs)
          .text_color(k.dim)
          .on_mouse_down("right", () => menu())
          .tooltip(`${m ?? "This computer"}  (right-click to move it into a folder)`)
          .child(Icon(m ? "container" : "terminal", { size: 12 }))
          .child(div().flex_1().child(m ?? "This computer"))
          .when(Boolean(m) && !connected, e => e.child(div().text_color(k.dim).child(state)))
          .child(div().size(6).flex_none().rounded(3).bg(connected ? k.success : k.dim).when(Boolean(m), e => e.tooltip(connected ? "connected" : state)))
          .child(Button(`machine-new-${m ?? "local"}`, { icon: "plus", variant: "ghost", size: "icon-sm", tooltip: `${m ?? "This computer"} · New space there`, onClick: () => run("space.new", { machine: m ?? "" }) })),
      ];
      const mine = ordered.filter(r => (r.s.machine ?? null) === m);
      if (!mine.length) {
        rows.push(loading
          ? h_flex().id(`machine-loading-${m ?? "local"}`).h(26).px(8).text_size(TEXT.xs).text_color(k.dim).child("Loading…")
          : h_flex().id(`machine-empty-${m ?? "local"}`).h(26).px(8).gap(6).items_center().rounded(RADIUS.md).cursor_pointer().text_size(TEXT.xs).text_color(k.dim).hover(s => s.bg(k.accent).text_color(k.foreground)).tooltip(`${m ?? "This computer"} · New space there`).on_click(() => run("space.new", { machine: m ?? "" })).child(Icon("plus", { size: 12 })).child("New space there"));
      } else rows.push(...mine.flatMap(withTerms));
      return inFolder ? [v_flex().id(`machine-block-${m ?? "local"}`).pl(12).children(rows)] : rows;
    };
    const out = [...lead, head];
    for (const item of arrangeFolders(groups, [null, ...machineNames].map(machineKey))) {
      if (item.kind === "machine") {
        out.push(...machineBlock(machineOfKey(item.key), false));
        continue;
      }
      const { folder, members } = item;
      const inside = members.map(machineOfKey);
      const urgent = ordered.find((r) => inside.includes(r.s.machine ?? null) && ["blocked", "failed", "done"].includes(agentStatus(r.s.status)));
      out.push(this.folderHeader(k, folder, inside.length, urgent ? agentStatus(urgent.s.status) : null, inside.length > 0 && inside.every(isUp)));
      if (folder.folded) continue;
      if (!members.length) out.push(h_flex().id(`folder-empty-${folder.id}`).h(24).pl(28).text_size(TEXT.xs).text_color(k.dim).child("Right-click a machine to move it here"));
      for (const m of inside) out.push(...machineBlock(m, true));
    }
    return out;
  }

  /** A Spaces folder's header: chevron, folder icon, name and machine count, a dot when an agent inside needs a look,
   * and whether all its machines are connected; a click folds it, a right-click renames or deletes it. */
  folderHeader(k, folder, count, status, connected) {
    return h_flex()
      .id(`folder-${folder.id}`)
      .h(26)
      .px(8)
      .mt(4)
      .gap(6)
      .items_center()
      .rounded(RADIUS.md)
      .cursor_pointer()
      .text_size(TEXT.sm)
      .text_color(k.mutedFg)
      .hover((st) => st.bg(k.accent).text_color(k.foreground))
      .tooltip(`${folder.name}  (click to ${folder.folded ? "open" : "fold"}, right-click for more)`)
      .on_click(() => setShared(FOLDERS, toggleFolders(shared(FOLDERS), folder.id)))
      .on_mouse_down("right", () =>
        openMenu(
          [
            { label: folder.folded ? "Open" : "Fold", icon: folder.folded ? "chevron-down" : "chevron-right", command: `folder:fold|${folder.id}` },
            { label: "Rename…", icon: "pencil", command: `folder:rename|${folder.id}` },
            "separator",
            { label: "Delete folder", icon: "trash-2", command: `folder:delete|${folder.id}` },
          ],
          { width: 200 },
        ),
      )
      .child(Icon(folder.folded ? "chevron-right" : "chevron-down", { size: 12, color: k.dim }))
      .child(Icon(folder.folded ? "folder" : "folder-open", { size: 14 }))
      .child(div().flex_shrink_1().min_w(0).truncate().font_medium().child(folder.name))
      .child(div().text_size(TEXT.xs).text_color(k.dim).child(String(count)))
      .child(div().flex_1())
      .when(Boolean(status), (e) => e.child(div().size(7).flex_none().rounded(4).bg(statusColor(k, status))))
      .when(count > 0, (e) => e.child(div().size(6).flex_none().rounded(3).bg(connected ? k.success : k.dim).tooltip(connected ? "all connected" : "not all connected")));
  }

  /** A space row's chevron: folds its terminal lines away or back, without selecting the space. */
  foldButton(k, s, folded) {
    const isFolded = folded.has(s.id);
    const toggle = () => {
      const next = new Set(folded);
      isFolded ? next.delete(s.id) : next.add(s.id);
      setShared("flow.spaces.folded", [...next]);
    };
    return h_flex()
      .id(`space-fold-${s.id}`)
      .size(18)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(RADIUS.sm)
      .hover((st) => st.bg(k.accent))
      .tooltip(isFolded ? "Show what runs here" : "Hide what runs here")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        toggle();
        cx.notify();
      })
      .child(Icon(isFolded ? "chevron-right" : "chevron-down", { size: 12, color: k.dim }));
  }

  /** The terminals running in a space, one line each with its agent or program and its state, waiting ones first;
   * four lines at most, the last one then counting the rest. */
  termRows(k, s, ps, byAddress, tree) {
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    const STATUS = { blocked: "needs_you", failed: "failed", working: "working", done: "done", idle: "idle" };
    const FIRST = { needs_you: 0, failed: 1 };
    const terms = ps
      .filter((p) => tabs.has(p.tab) && p.terminal)
      .map((p) => {
        const r = byAddress.get(p.terminal);
        return { p, r, stage: r?.stage ?? STATUS[agentStatus(p.status)] ?? null };
      })
      .sort((a, b) => (FIRST[a.stage] ?? 2) - (FIRST[b.stage] ?? 2));
    const MAX = 4;
    const shown = terms.length > MAX ? terms.slice(0, MAX - 1) : terms;
    const pad = tree ? 38 : 34;
    const line = ({ p, r, stage }) => {
      const name = p.program?.name || (r ? "Agent" : "Terminal");
      // A shell's title is often `user@host:folder`: the folder says more.
      const title = (r?.title || p.title || "").replace(/^[^@\s]+@[^:\s]+:\s*/, "");
      const state = stage ? STAGES[stage]?.label ?? stage : null;
      // What the tab is about leads, the program running it follows.
      const named = Boolean(title) && title !== name && title !== p.terminal;
      return h_flex()
        .id(`term-${p.terminal}`)
        .h(22)
        .pl(pad)
        .pr(8)
        .gap(6)
        .items_center()
        .rounded(RADIUS.md)
        .cursor_pointer()
        .hover((st) => st.bg(k.accent))
        .tooltip(state ? `${name} · ${state}` : name)
        .on_click((_e, cx) => {
          if (r) return this.agents.go(cx, r);
          run("tab.select", { id: p.tab });
          run("pane.focus", { pane: p.pane });
          showWork();
        })
        .child(h_flex().w(12).flex_none().justify_center().child(stage ? StageMark(`term-${p.terminal}`, stage, { size: 6, status: r?.status }) : Icon("terminal", { size: 11, color: k.dim })))
        .when(Boolean(r) || p.program?.agent, (e) => e.child(AgentLogo(r ? { ...r, program: p.program } : { program: p.program }, { size: 12, color: k.mutedFg })))
        .child(div().min_w(0).truncate().text_size(TEXT.sm).text_color(stage === "needs_you" ? k.blocked : k.mutedFg).child(named ? title : name))
        .when(named, (e) => e.child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(name)));
    };
    const out = shown.map(line);
    if (terms.length > shown.length) out.push(h_flex().h(20).pl(pad + 18).items_center().text_size(TEXT.xs).text_color(k.dim).child(`+${terms.length - shown.length} more`));
    return out;
  }

  /** Space avatar colors, the ones Herdr's own list keeps in `space.colors`, given to new spaces the same way and drawn in the theme's hues. */
  spaceColors(sp) {
    const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
    const palette = Object.keys(MARK);
    const stored = shared("space.colors") ?? {};
    const ids = new Set(sp.map((s) => s.id));
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const hues = tokens().t ?? {};
    return Object.fromEntries(Object.entries(kept).map(([id, c]) => [id, c.startsWith("#") ? c : hues[c] ?? MARK[c] ?? c]));
  }

  /** The rail: a dot per waiting agent, then the threads as avatars (their kind's icon) with their status, each with its menu on a right-click. */
  railRows(k, rows) {
    const waiting = rows.filter((r) => r.stage === "needs_you");
    const sp = spaces();
    const colors = this.spaceColors(sp);
    const threads = splitThreads(this.threadStore(sp), sp).threads;
    return [
      ...waiting.map((r) =>
        h_flex()
          .id(`rail-${r.terminal}`)
          .h(28)
          .justify_center()
          .items_center()
          .rounded(RADIUS.md)
          .cursor_pointer()
          .hover((s) => s.bg(k.accent))
          .tooltip(`${r.title}: ${r.question?.text ?? r.waits?.text ?? "needs you"}`)
          .on_click((_e, cx) => this.agents.go(cx, r))
          .child(StageMark(`rail-${r.terminal}`, "needs_you", { size: 9 })),
      ),
      ...threads.map(({ space: s, thread }) =>
        h_flex()
          .id(`rail-space-${s.id}`)
          .h(30)
          .relative()
          .justify_center()
          .items_center()
          .rounded(RADIUS.md)
          .cursor_pointer()
          .when(s.active, (e) => e.bg(k.selected))
          .hover((st) => st.bg(k.accent))
          .tooltip(`${kindOf(thread.kind)[1]} · ${s.name}`)
          .on_click(() => {
            run("space.select", { id: s.id });
            showSpace(s.id);
          })
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            this.threadMenu(s, thread);
          })
          .child(h_flex().size(20).rounded(5).bg(colors[s.id] ?? k.ring).items_center().justify_center().child(Icon(kindOf(thread.kind)[2], { size: 12, color: inkOn(colors[s.id] ?? k.ring, "#ffffff") })))
          .when(["blocked", "failed", "done"].includes(agentStatus(s.status)), (e) => e.child(div().absolute().top(3).right(8).size(7).rounded(4).bg(statusColor(k, agentStatus(s.status))))),
      ),
    ];
  }
}
