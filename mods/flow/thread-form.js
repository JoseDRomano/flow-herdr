// The dialog that opens a thread: its kind (fix, feature or bug), its title, the machine it works on and the folder
// there, typed or picked from a list of that machine's folders. The thread is a space on the main machine (flow.json's
// `main`, this computer by default), so its panes can reach every other machine; on another machine, its first pane is
// a bridge there from the main machine, the way a Split right on… reaches it, in that folder. Enter opens it, Esc
// cancels.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, closeOverlay, openOverlay, exec, home, pickFolder, spaces, focused, shared, setShared, run } from "herdr";
import { tokens, TEXT, RADIUS, Button, TextField, Pills, Spinner, Icon } from "./ui.js";
import { LOCAL, ROUTES_FILE, machineWords, routeArgv, routeFor } from "./bridge.js";
import { listMachines, routesConfig, knows } from "./termmenu.js";
import { THREADS, KINDS, mainMachine, folderPath, problem, spaceArgs, begin, targetChoices, LIST_SCRIPT, parseListing, childOf, parentOf } from "./threads.js";

/** Opens the dialog, on `kind` when given. */
export function openThreadForm({ kind = "fix" } = {}) {
  openOverlay({ mod: "flow", kind: "dialog", width: 520, props: { app: "thread-form", kind } });
}

/** `exec`'s options to run on a machine key (`local`: this computer). */
const on = (machine) => (machine === LOCAL ? {} : { on: machine });

/** How many folders the list draws; more than that, typing a path narrows it. */
const LISTED = 300;

/** How long the list waits after a keystroke in the folder field before it follows the path typed, ms. */
const FOLLOW_MS = 450;

export default class ThreadForm {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = KINDS.some(([k]) => k === p.kind) ? p.kind : "fix";
    this.main = null;
    this.config = {};
    this.machines = [];
    this.target = LOCAL;
    // The folder the dialog filled in itself, cleared when the machine changes.
    this.filled = null;
    this.loading = true;
    this.busy = false;
    this.error = "";
    // The folders of the machine picked: the folder listed, its folders, and whether a listing is on its way.
    this.list = { path: null, folders: [], loading: false, error: "" };
    this.listSeq = 0;
    this.typedSeq = 0;
    // The path the list put in the field itself, which the field's change doesn't list again.
    this.navigating = null;
    this.title = InputState.new({ placeholder: "What it is, like “Login loops on SSO”" });
    this.folder = InputState.new({ placeholder: "Folder: /full/path, ~/path or a path in its home" });
    for (const input of [this.title, this.folder]) input.on("submit", (_e, cx) => this.save(cx));
    this.title.on("change", (_e, cx) => {
      this.error = "";
      cx.notify();
    });
    // A path typed in the folder field: the list follows it once the typing pauses.
    this.folder.on("change", (_e, cx) => {
      this.error = "";
      cx.notify();
      const typed = this.folder.value().trim();
      if (this.loading || typed === this.navigating || typed === this.list.path) return;
      this.navigating = null;
      const at = ++this.typedSeq;
      cx.timer.after(FOLLOW_MS, (later) => {
        if (at === this.typedSeq) this.browse(later ?? cx, this.folder.value().trim() || null);
      });
    });
    this.handle = cx.focus_handle();
    this.title.focus();
    cx.timer.after(50, () => this.title.focus());
    cx.spawn(async (cx) => {
      this.config = await routesConfig();
      this.main = mainMachine(this.config);
      this.target = this.mainKey();
      this.machines = (await listMachines()).map((m) => m.name);
      this.loading = false;
      // The focused terminal's folder, when it is on the main machine, is likely where the work is.
      const f = focused();
      const there = f && spaces().find((s) => s.id === f.space);
      if (f?.cwd && there && (there.machine ?? null) === this.main && !this.folder.value()) {
        this.navigating = f.cwd;
        this.folder.set_value(f.cwd);
        this.filled = f.cwd;
      }
      this.browse(cx, this.folder.value().trim() || null);
    });
  }

  /**
   * Lists the folders of `path` (null: the home folder) on the machine picked. A path that isn't a folder there keeps
   * the list where it was and says so; an answer that comes after a newer ask is dropped.
   */
  browse(cx, path = null) {
    const seq = ++this.listSeq;
    const target = this.target;
    this.list = { ...this.list, loading: true, error: "" };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", LIST_SCRIPT, "sh", path ?? ""], { ...on(target), timeout: 8000 }).catch((e) => ({ code: -1, stdout: "", stderr: e?.message ?? String(e) }));
      if (seq !== this.listSeq) return;
      const got = r.code === 0 ? parseListing(r.stdout) : null;
      if (got) this.list = { ...got, loading: false, error: "" };
      else if (r.code === 3 && path) this.list = { ...this.list, loading: false, error: `${path} isn't a folder on ${machineWords(target)}.` };
      else {
        const why = (r.stderr || "").trim();
        this.list = { path: null, folders: [], loading: false, error: `Couldn't list the folders on ${machineWords(target)}${why ? `: ${why}` : "."} Type the folder instead.` };
      }
      cx.notify();
    });
  }

  /** Opens a folder in the list and puts it in the field. */
  go(cx, path) {
    this.navigating = path;
    this.filled = null;
    this.folder.set_value(path);
    this.browse(cx, path);
  }

  /** The main machine as a machine key: its name, or `local` for this computer. */
  mainKey() {
    return this.main ?? LOCAL;
  }

  /** Whether the thread works on a machine other than the main one. */
  away() {
    return this.target !== this.mainKey();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  ready() {
    return !this.loading && !this.busy && Boolean(this.title.value().trim());
  }

  pick(target, cx) {
    if (target === this.target) return;
    this.target = target;
    // A folder filled in for the main machine is likely not there on another one.
    if (this.filled && this.folder.value() === this.filled) {
      this.navigating = "";
      this.folder.set_value("");
    }
    this.filled = null;
    this.error = "";
    this.list = { path: null, folders: [], loading: false, error: "" };
    this.browse(cx, this.folder.value().trim() || null);
  }

  save(cx) {
    if (!this.ready()) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.open();
      } catch (e) {
        this.error = e?.message ?? String(e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  /** The home folder on the thread's machine, for a folder typed from it. */
  async homeThere() {
    if (this.target === LOCAL) return home();
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.target, timeout: 8000 }).catch((e) => ({ code: -1, stderr: e?.message ?? String(e) }));
    if (r.code !== 0 || !r.stdout?.trim()) throw new Error(`Couldn't ask ${this.target} for its home folder: ${(r.stderr || "").trim() || `exit ${r.code}`}`);
    return r.stdout.trim();
  }

  /** How the main machine reaches the thread's machine, as a split from there would: a route, or an error saying what to add. */
  async route() {
    let route = routeFor(this.config, this.target, this.main);
    if (!route && this.target !== LOCAL && this.main && (await knows(this.main, this.target))) route = { kind: "hc", name: this.target };
    if (!route || route.kind === "split") {
      throw new Error(`${machineWords(this.main)} has no way to ${machineWords(this.target)} yet. Add a route in ${ROUTES_FILE}, or from a terminal on ${machineWords(this.main)}: Split right on…, then How ${machineWords(this.main)} reaches the others.`);
    }
    return route;
  }

  async open() {
    const typed = this.folder.value().trim();
    const folder = typed && !typed.startsWith("/") ? folderPath(typed, await this.homeThere()) : typed;
    const title = this.title.value().trim();
    const wrong = problem({ kind: this.kind, title, folder });
    if (wrong) throw new Error(wrong);
    if (folder) {
      // `test -d` says 1 for a folder that isn't there; a machine this computer can't ask is left to the bridge.
      const r = await exec("test", ["-d", folder], { ...on(this.target), timeout: 8000 }).catch(() => ({ code: -1 }));
      if (r.code === 1) throw new Error(`${folder} isn't a folder on ${machineWords(this.target)}.`);
    }
    const away = this.away();
    const argv = away ? routeArgv(await this.route(), folder || null) : null;
    const where = away ? { machine: this.target, folder: folder || null, argv } : null;
    const before = spaces().map((s) => s.id);
    setShared(THREADS, begin(shared(THREADS), { kind: this.kind, title, main: this.main, before, where }));
    run("space.new", spaceArgs({ title, folder: away ? "" : folder, main: this.main, argv }));
    this.close();
  }

  /** Picks a folder in the system's dialog: only on this computer, where the dialog looks. */
  choose(cx) {
    cx.spawn(async (cx) => {
      const picked = await pickFolder({ prompt: "Where the thread starts" });
      if (picked) this.go(cx, picked);
      cx.notify();
    });
  }

  /** The folders of the machine picked: the folder listed with Up, then a row per folder, a click opening it. */
  browser(k) {
    const l = this.list;
    const up = l.path ? parentOf(l.path) : null;
    const shown = l.folders.slice(0, LISTED);
    const note = (text, color = k.dim) => div().px(8).py(6).text_size(TEXT.xs).text_color(color).child(text);
    const row = (name) =>
      h_flex()
        .id(`thread-form-folder-${name}`)
        .h(26)
        .px(8)
        .gap(8)
        .flex_none()
        .items_center()
        .rounded(RADIUS.md)
        .cursor_pointer()
        .text_size(TEXT.sm)
        .text_color(k.foreground)
        .hover((st) => st.bg(k.accent))
        .on_click((_e, cx) => this.go(cx, childOf(l.path, name)))
        .child(Icon("folder", { size: 13, color: k.mutedFg }))
        .child(div().flex_1().min_w(0).truncate().child(name))
        .child(Icon("chevron-right", { size: 12, color: k.dim }));
    return v_flex()
      .rounded(RADIUS.md)
      .border_1()
      .border_color(k.border)
      .bg(k.background)
      .child(
        h_flex()
          .h(30)
          .pl(8)
          .pr(4)
          .gap(6)
          .items_center()
          .border_b_1()
          .border_color(k.border)
          .text_size(TEXT.xs)
          .text_color(k.mutedFg)
          .child(Icon("folder-open", { size: 13 }))
          .child(div().flex_1().min_w(0).truncate().child(l.path ?? (l.loading ? "Reading…" : "")))
          .when(l.loading, (e) => e.child(Spinner({ size: 12, color: k.mutedFg })))
          .when(Boolean(up), (e) => e.child(Button("thread-form-up", { label: "Up", icon: "arrow-up", variant: "ghost", size: "sm", tooltip: up, onClick: (_e, cx) => this.go(cx, up) }))),
      )
      .child(
        v_flex()
          .id("thread-form-folders")
          .h(168)
          .p(4)
          .overflow_y_scrollbar()
          .when(Boolean(l.error), (e) => e.child(note(l.error, k.destructive)))
          .when(!l.error && !l.loading && Boolean(l.path) && shown.length === 0, (e) => e.child(note("No folders here.")))
          .children(shown.map(row))
          .when(l.folders.length > shown.length, (e) => e.child(note(`${l.folders.length - shown.length} more: type a path to narrow it.`))),
      );
  }

  render() {
    const k = tokens();
    const label = (text) => div().text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child(text);
    const main = this.loading ? "…" : machineWords(this.main);
    const there = this.loading ? "…" : machineWords(this.target);
    const note = this.away()
      ? `It opens on the main machine, ${main}, and reaches ${there} from there, the way Split right on… does. A split onto ${there} in this thread starts in this folder.`
      : `Threads open on the main machine, ${main}, so any pane of one can split onto another machine (right-click a terminal, Split right on…). Set "main" in ${ROUTES_FILE} to change it.`;
    return v_flex()
      .id("thread-form")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.close();
          cx.stop_propagation();
        }
      })
      .w_full()
      .p(18)
      .gap(12)
      .rounded(RADIUS.lg)
      .bg(k.popover)
      .text_color(k.foreground)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(Icon("git-branch", { size: 16, color: k.mutedFg }))
          .child(div().flex_1().text_size(TEXT.lg).font_semibold().child("New thread"))
          .child(div().text_size(TEXT.xs).text_color(k.dim).child("Esc")),
      )
      .child(
        v_flex()
          .gap(6)
          .child(label("Kind"))
          .child(
            Pills("thread-form-kind", KINDS.map(([v, l]) => [v, l]), this.kind, (v, cx) => {
              this.kind = v;
              cx.notify();
            }),
          ),
      )
      .child(v_flex().gap(6).child(label("Title")).child(h_flex().child(TextField(this.title))))
      .when(!this.loading, (e) =>
        e.child(
          v_flex()
            .gap(6)
            .child(label("Machine"))
            .child(Pills("thread-form-machine", targetChoices(this.main, this.machines).map(([v, l]) => [v, l]), this.target, (v, cx) => this.pick(v, cx))),
        ),
      )
      .child(
        v_flex()
          .gap(6)
          .child(label(`Folder on ${there}`))
          .child(
            h_flex()
              .gap(8)
              .child(TextField(this.folder, { active: false }))
              .when(!this.loading && this.target === LOCAL, (e) => e.child(Button("thread-form-choose", { label: "Choose…", variant: "outline", onClick: (_e, cx) => this.choose(cx) }))),
          )
          .when(!this.loading, (e) => e.child(this.browser(k))),
      )
      .child(div().text_size(TEXT.xs).text_color(k.dim).child(note))
      .when(Boolean(this.error), (e) => e.child(div().text_size(TEXT.xs).text_color(k.destructive).child(this.error)))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .items_center()
          .justify_end()
          .when(this.busy, (e) => e.child(Spinner({ size: 14, color: k.mutedFg })).child(div().text_size(TEXT.xs).text_color(k.dim).child("Opening…")))
          .child(Button("thread-form-cancel", { label: "Cancel", variant: "outline", onClick: () => this.close() }))
          .child(Button("thread-form-save", { label: "Open thread", disabled: !this.ready(), onClick: (_e, cx) => this.save(cx) })),
      );
  }
}
