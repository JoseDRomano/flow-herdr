// Flow's own top bar, for the looks that draw it (Daylight): the brand at the left, over the sidebar, and the shown
// space's tabs in one pill. It does what Herdr's tab bar does: select, drag to reorder, double-click to rename,
// right-click for the tab menu, close, a new tab, the wheel to step through tabs, each space's own side panel, and the
// window's buttons where the system draws none.

import { div } from "gpui-kit";
import * as base from "gpui-base";
import { spaces, panes, run, openOverlay, window, shared, setShared, layout } from "herdr";
import { findNode } from "./status.js";
import { tokens, TEXT, Icon, Spinner } from "./ui.js";

const { h_flex } = base;
// A Herdr without ScrollHandle still draws the bar; the shown tab is then not scrolled into view.
const ScrollHandle = base.ScrollHandle ?? null;

const stop = (_e, cx) => cx.stop_propagation();

/** The sidebar is a rail below this width, however it got there. */
const RAIL = 160;

/** A quiet square button: an icon, a tooltip, a click that never drags the window. */
function quiet(id, icon, tooltip, onClick) {
  const k = tokens();
  return h_flex()
    .id(id)
    .size(28)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(7)
    .text_color(k.mutedFg)
    .cursor_pointer()
    .hover((s) => s.bg(k.accent).text_color(k.foreground))
    .on_mouse_down("left", stop)
    .on_click(onClick)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .child(Icon(icon, { size: 15 }));
}

/** The sidebar to its rail (wide enough for the macOS window buttons), or back to the width it had. */
export function toggleSidebar() {
  const width = findNode(layout(), "sidebar")?.size?.px ?? Infinity;
  const rail = width < RAIL;
  if (!rail) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !rail);
  run("layout.resize", { id: "sidebar", px: rail ? (shared("sidebar.width") ?? 256) : window()?.platform === "macos" ? 76 : 44 });
}

/** The brand over the sidebar: Flow's mark and name after the macOS window buttons, and the sidebar's toggle. */
export class Brand {
  init() {}

  render() {
    const k = tokens();
    const w = window();
    const rail = (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < RAIL;
    const lights = w?.platform === "macos" && !w?.fullscreen;
    return h_flex()
      .size_full()
      .pl(lights ? 76 : 14)
      .pr(12)
      .gap(8)
      .items_center()
      .when(!rail, (e) =>
        e.child(
          h_flex()
            .flex_1()
            .min_w(0)
            .gap(8)
            .items_center()
            .child(div().size(14).flex_none().rounded(4).bg(k.ring))
            .child(div().truncate().text_size(14).font_semibold().text_color(k.foreground).child("Flow")),
        ),
      )
      .child(quiet("brand-sidebar", "panel-left", rail ? "Show the sidebar" : "Hide the sidebar", () => toggleSidebar()));
  }
}

/** A tab's name: the one the person gave, else its agent's or program's, else "Terminal". */
export function tabName(tab, lead) {
  if (tab.named && tab.name) return tab.name;
  return lead?.program?.name ?? "Terminal";
}

/** Each space keeps its own side panel; this is the one a space shows, among the panels the bar may restore. */
export function panelToShow(kept, space, allowed) {
  const want = kept?.[space] ?? null;
  return want && allowed.includes(want) ? want : null;
}

const PANELS_KEPT = "flow.tabs.panels";

export class TabBar {
  init() {
    this.scroll = ScrollHandle ? ScrollHandle.new() : null;
    this.pressed = null;
    this.hovered = null;
    this.wheelAt = 0;
    this.wheelSeen = 0;
    this.wheelSum = 0;
    try {
      const kept = JSON.parse(localStorage.getItem(PANELS_KEPT) ?? "{}");
      this.panels = kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
    } catch {
      this.panels = {};
    }
  }

  /** One tab per wheel notch, or per 40px of a touchpad's swipe, at most one every 90ms so each shows. */
  wheel(e) {
    if (e.delta_lines?.y) {
      run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    // A pause or a turn starts a new swipe.
    const now = Date.now();
    if (now - this.wheelSeen > 250 || e.delta.y * this.wheelSum < 0) this.wheelSum = 0;
    this.wheelSeen = now;
    this.wheelSum += e.delta.y;
    if (Math.abs(this.wheelSum) < 40 || now - this.wheelAt < 90) return;
    this.wheelAt = now;
    this.wheelSum = 0;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  /** Shows the space's own side panel when the shown space changes, and remembers the panel opened or closed in it. */
  keepPanel(space, root) {
    const panel = findNode(root, "panel");
    if (!space || !panel) return;
    const body = findNode(root, "panel-body");
    const now = panel.hidden ? null : (body?.active ?? null);
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.restoring = null;
      if (!first || space.id in this.panels) {
        const want = panelToShow(this.panels, space.id, shared("workspace.panels") ?? ["files", "changes"]);
        if (want !== now) {
          this.restoring = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands, or something else wins, the panel shown is not the person's choice.
    if (this.restoring) {
      if (this.restoring.want !== now && Date.now() < this.restoring.until) return;
      this.restoring = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    try {
      localStorage.setItem(PANELS_KEPT, JSON.stringify(this.panels));
    } catch {}
  }

  tab(space, tabs, t, i, active, cx) {
    const k = tokens();
    const lead = panes().find((p) => p.tab === t.id && p.program?.agent) ?? panes().find((p) => p.tab === t.id);
    const on = t.active;
    const hovered = this.hovered === t.id;
    return h_flex()
      .id(`tab-${t.id}`)
      .h(28)
      .pl(12)
      .pr(on || hovered ? 6 : 12)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(8)
      .text_size(12.8)
      .cursor_pointer()
      .when(on, (e) => e.bg(k.tabOn).text_color(k.foreground).font_medium())
      .when(!on, (e) => e.text_color(k.mutedFg).hover((s) => s.text_color(k.foreground)))
      // A rename or a status on this or an earlier tab can push the shown one out of view.
      .when(i <= active && Boolean(this.scroll), (e) => e.on_size_change(() => this.scroll.scroll_to_item(active)))
      .on_hover((over, cx) => {
        this.hovered = over ? t.id : this.hovered === t.id ? null : this.hovered;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.pressed = i;
        if (e.click_count === 2) run("tab.rename", { id: t.id });
      })
      .on_mouse_up("left", () => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("tab.move", { id: tabs[from].id, index: i + 1 });
        else run("tab.select", { id: t.id });
      })
      .on_mouse_down("middle", (_e, cx) => {
        cx.stop_propagation();
        run("tab.close", { id: t.id });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: t.id, space: space.id } } });
      })
      .child(div().max_w(180).truncate().child(t.zoomed ? `${tabName(t, lead)} · zoomed` : tabName(t, lead)))
      .when(t.status === "working", (e) => e.child(Spinner({ size: 11, color: k.working })))
      .when(t.status === "blocked" || t.status === "done", (e) => e.child(div().size(6).flex_none().rounded(3).bg(k[t.status])))
      .when(on || hovered, (e) =>
        e.child(
          h_flex()
            .id(`tab-close-${t.id}`)
            .size(18)
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(5)
            .text_color(k.dim)
            .hover((s) => s.bg(k.accent).text_color(k.foreground))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("tab.close", { id: t.id });
            })
            .child(Icon("x", { size: 12 })),
        ),
      );
  }

  render(cx) {
    const k = tokens();
    const root = layout();
    const space = spaces().find((s) => s.active);
    const tabs = space?.tabs ?? [];
    const active = tabs.findIndex((t) => t.active);
    if (tabs[active]?.id !== this.shown) {
      this.shown = tabs[active]?.id;
      if (active >= 0) this.scroll?.scroll_to_item(active);
    }
    this.keepPanel(space, root);
    const w = window();
    const panelOn = (name) => {
      const panel = findNode(root, "panel");
      return Boolean(panel && !panel.hidden && findNode(root, "panel-body")?.active === name);
    };
    const panelButton = (name, icon, label) =>
      quiet(`bar-${name}`, icon, label, () => {
        if (panelOn(name)) run("layout.hide", { id: "panel" });
        else {
          run("layout.select", { stack: "panel-body", child: name });
          run("layout.show", { id: "panel" });
        }
      }).when(panelOn(name), (e) => e.bg(k.tabOn).text_color(k.foreground));
    const allowed = shared("workspace.panels") ?? ["files", "changes"];
    const windowButton = (id, glyph, command) => quiet(id, glyph, null, () => run(command));
    return h_flex()
      .id("flow-tabbar")
      .size_full()
      .min_w(0)
      .pl(12)
      .pr(8)
      .gap(6)
      .items_center()
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel((e) => this.wheel(e))
      .child(
        h_flex()
          .min_w(0)
          .flex_shrink(1)
          .p(3)
          .rounded(11)
          .bg(k.pill)
          .when(!tabs.length, (e) => e.px(12).h(34).text_size(TEXT.sm).text_color(k.dim).child(space ? "No tabs" : "No space open"))
          .when(tabs.length > 0, (e) =>
            e.child(
              h_flex()
                .id("tab-scroll")
                .min_w(0)
                .gap(2)
                .items_center()
                .overflow_x_scrollbar()
                .when(Boolean(this.scroll), (e) => e.track_scroll(this.scroll))
                .children(tabs.map((t, i) => this.tab(space, tabs, t, i, active, cx))),
            ),
          ),
      )
      .when(Boolean(space), (e) => e.child(quiet("tab-new", "plus", "New tab", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))))
      .child(div().flex_1().min_w(0).h_full())
      .when(allowed.includes("files"), (e) => e.child(panelButton("files", "folder", "Files")))
      .when(allowed.includes("changes"), (e) => e.child(panelButton("changes", "git-compare", "Changes")))
      .when(Boolean(w?.buttons), (e) =>
        e
          .child(windowButton("win-min", "minus", "window.minimize"))
          .child(windowButton("win-max", w.maximized ? "minimize" : "maximize", "window.maximize"))
          .child(windowButton("win-close", "x", "window.close")),
      );
  }
}
