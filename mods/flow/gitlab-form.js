// Connect GitLab: a dialog that asks whether the person uses GitLab.com or a self-hosted server (and its address), and
// what Flow shows from it, then connects cockpit to that server's MCP server step by step: it checks the server
// answers, saves it in cockpit's config.json, signs in in the browser, has an agent map GitLab's tools for each part,
// and reads the person's merge requests once. Connected, it also disconnects. Enter connects, Esc closes.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, closeOverlay, openOverlay, exec, readTextFile, writeTextFile, setShared, notify } from "herdr";
import * as hub from "./hub.js";
import { tokens, TEXT, RADIUS, Button, TextField, Pills, Spinner, Icon, Checkbox } from "./ui.js";
import {
  GITLAB_COM, SECTIONS, candidates, baseOf, mcpUrl, hostOf, probeArgs, verdict, statusOf, parseConfig, configText,
  withServer, connection, replaces, withoutGitlab, synced, steps, stepArgs, readWords, failure,
} from "./gitlab.js";

/** The shared key that holds what is connected, `{ base, host, sections }` or null, for settings and Home to show. */
export const GITLAB_SHARED = "flow.gitlab";

/** How long a step that waits on the person or an agent may take: the browser sign-in, a mapping. */
const LONG_MS = { login: 300_000, map: 600_000, read: 60_000 };

/** Esc closes the dialog from anywhere in it, the address field too, which would otherwise keep the key. */
export const GITLAB_KEYS = [
  { keystroke: "escape", action: "flow_gitlab_escape", context: "FlowGitlab" },
  { keystroke: "escape", action: "flow_gitlab_escape", context: "FlowGitlab > Input" },
];

/** Opens the dialog. */
export function openGitlabForm() {
  openOverlay({ mod: "flow", kind: "dialog", width: 500, props: { app: "gitlab-form" } });
}

/** config.json and the hub's resolved copy of it, where this install keeps them; a remote desk has none to change. */
async function paths() {
  const { home, cache, machine } = await hub.install();
  if (machine) throw new Error("This window shows a cockpit on another machine: connect GitLab on the machine cockpit runs on.");
  return { config: `${home}/.config/cockpit/config.json`, copy: cache ? `${cache}/config.json` : null };
}

/** Rewrites a JSON file through `change`, reading it again right before so an edit made meanwhile is kept. */
async function rewrite(path, change, { create = true } = {}) {
  for (let tries = 0; ; tries++) {
    const text = await readTextFile(path);
    if (text === null && !create) return;
    const next = configText(change(parseConfig(text)));
    if (next === text) return;
    try {
      await writeTextFile(path, next, text);
      return;
    } catch (e) {
      // The file changed between the read and the write: read it again, twice at most.
      if (tries >= 2) throw new Error(`${path} changed while Flow wrote it: ${e?.message ?? e}`);
    }
  }
}

/** Reads what config.json says of GitLab and shares it; null when it can't be read, or while `herdr-app check` loads. */
export async function readGitlab() {
  if (hub.checking?.()) return null;
  try {
    const { config } = await paths();
    const found = connection(parseConfig(await readTextFile(config)));
    setShared(GITLAB_SHARED, found);
    return found;
  } catch {
    return null;
  }
}

/** Brings the hub's resolved copy in line with config.json's GitLab sections, when there is a copy. */
async function syncCopy() {
  const where = await paths();
  if (!where.copy) return;
  const config = parseConfig(await readTextFile(where.config));
  await rewrite(where.copy, (copy) => synced(copy, config), { create: false });
}

/** One read of an address's HTTP status with curl: `{ code, status }`. */
async function probe(url) {
  const r = await exec("curl", probeArgs(url), { timeout: 15_000 }).catch((e) => ({ code: -1, stdout: "", stderr: e?.message ?? String(e) }));
  return { code: r.code, status: statusOf(r.stdout) };
}

export default class GitlabForm {
  init(_props, cx) {
    this.kind = "com";
    this.address = InputState.new({ placeholder: "https://gitlab.acme.example" });
    this.address.on("change", (_e, cx) => {
      this.error = "";
      cx.notify();
    });
    this.address.on("submit", (_e, cx) => this.connect(cx));
    /** The parts picked; merge requests always. */
    this.picks = new Set(["code", "ci"]);
    /** form | running | done | failed */
    this.phase = "form";
    this.error = "";
    this.config = {};
    this.current = null;
    this.base = null;
    this.list = [];
    this.states = {};
    this.notes = {};
    this.open = true;
    // The keymap is the app's: binding again for the next dialog only repeats the same entries.
    try {
      cx.bind_keys(GITLAB_KEYS);
    } catch {}
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.load(cx);
  }

  /** Reads config.json and fills the form with what is connected, if anything. */
  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const { config } = await paths();
        this.config = parseConfig(await readTextFile(config));
        this.current = connection(this.config);
        if (this.current) {
          this.kind = this.current.base === GITLAB_COM ? "com" : "self";
          if (this.kind === "self") this.address.set_value(this.current.base);
          if (this.current.sections.length) this.picks = new Set(["code", ...this.current.sections]);
        }
        this.error = "";
      } catch (e) {
        this.error = e?.message ?? String(e);
      }
      if (this.kind === "self") this.address.focus();
      cx.notify();
    });
  }

  close() {
    this.open = false;
    closeOverlay(props()?.overlay);
  }

  /** The base address the form names now, or null with why in `error` when the typed one is not an address. */
  typedBase() {
    try {
      return baseOf(this.kind, this.address.value());
    } catch (e) {
      this.error = e?.message ?? String(e);
      return null;
    }
  }

  ready() {
    return this.phase === "form" && !this.busy && (this.kind === "com" || this.address.value().trim().length > 0);
  }

  connect(cx) {
    if (!this.ready()) return;
    const base = this.typedBase();
    if (!base) return cx.notify();
    this.base = base;
    this.list = steps(hostOf(base), [...this.picks].sort((a, b) => Object.keys(SECTIONS).indexOf(a) - Object.keys(SECTIONS).indexOf(b)));
    this.states = {};
    this.notes = {};
    this.error = "";
    this.runFrom(0, cx);
  }

  /** Runs the steps from `at` on, one after another; a failure stops there and Retry starts from it. */
  runFrom(at, cx) {
    this.phase = "running";
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      for (let i = at; i < this.list.length; i++) {
        const step = this.list[i];
        this.states[step.id] = "running";
        this.failedAt = i;
        if (this.open) cx.notify();
        try {
          const note = await this.run(step.id);
          this.states[step.id] = "done";
          if (note) this.notes[step.id] = note;
        } catch (e) {
          this.states[step.id] = "failed";
          this.error = e?.message ?? String(e);
          this.phase = "failed";
          if (this.open) cx.notify();
          else notify({ title: "GitLab is not connected", body: `${step.label}: ${this.error}`, level: "error", timeout: 12000 });
          return;
        }
      }
      this.phase = "done";
      const found = await readGitlab();
      if (this.open) cx.notify();
      else notify({ title: `Connected to ${found?.host ?? "GitLab"}`, body: this.notes.read ?? "", level: "success", timeout: 8000 });
    });
  }

  /** One step; what it found in a few words, if anything. */
  async run(id) {
    if (id === "check") return this.check();
    if (id === "save") {
      const { config } = await paths();
      await rewrite(config, (c) => withServer(c, this.base, [...this.picks]));
      await syncCopy();
      return null;
    }
    const kind = id.startsWith("map:") ? "map" : id;
    const r = await hub.cockpit(stepArgs(id), { timeout: LONG_MS[kind] });
    if (r.code !== 0) throw new Error(failure(r));
    if (kind === "map") {
      await syncCopy();
      return null;
    }
    if (kind === "read") {
      const { config } = await paths();
      return readWords(r.stdout, parseConfig(await readTextFile(config)).code?.fields?.prs ?? "");
    }
    return null;
  }

  /**
   * Finds the server: each candidate address in turn until one answers as GitLab with an MCP server. A pasted project
   * page tries its folders down to the host.
   */
  async check() {
    const tries = this.kind === "com" ? [GITLAB_COM] : candidates(this.address.value());
    let last = null;
    for (const base of tries) {
      const host = hostOf(base);
      const api = await probe(`${base}/api/v4/version`);
      const mcp = api.code === 0 && (api.status === 401 || api.status === 200) ? await probe(mcpUrl(base)) : { code: 0, status: 0 };
      const v = verdict(host, api, mcp);
      if (v.ok) {
        if (base !== this.base) {
          this.base = base;
          this.list = steps(host, this.list.filter((s) => s.id.startsWith("map:")).map((s) => s.id.slice(4)));
        }
        return `GitLab with its MCP server at ${host}`;
      }
      last = v;
      if (!v.next) break;
    }
    throw new Error(last?.next ? `${last.error} Use the address you open GitLab at, such as https://gitlab.acme.example.` : last?.error ?? "No GitLab server found");
  }

  /** Takes GitLab out of cockpit: its sections and server in config.json and the resolved copy, and its sign-in. */
  disconnect(cx) {
    const base = this.current?.base;
    if (!base || this.phase !== "form" || this.busy) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { config } = await paths();
        await rewrite(config, withoutGitlab);
        await syncCopy();
        await hub.cockpit(["connector", "logout", mcpUrl(base)]).catch(() => null);
        await readGitlab();
        notify({ title: `Disconnected from ${hostOf(base)}`, body: "Flow no longer reads GitLab.", level: "info", timeout: 6000 });
        this.close();
      } catch (e) {
        this.busy = false;
        this.error = e?.message ?? String(e);
        cx.notify();
      }
    });
  }

  /**
   * A key, from the window or `flow.key:` (tests): true when the dialog used it. Esc closes; Enter connects to GitLab.com,
   * never from a key sent from outside the window, since connecting opens the browser.
   */
  key(e, cx) {
    const k = e.keystroke ?? e.key;
    if (k === "escape") {
      this.close();
      return true;
    }
    if (k === "enter" && !e.injected && this.phase === "form" && this.kind === "com") {
      this.connect(cx);
      return true;
    }
    return false;
  }

  togglePick(section, cx) {
    if (section === "code" || this.phase !== "form") return;
    if (this.picks.has(section)) this.picks.delete(section);
    else this.picks.add(section);
    cx.notify();
  }

  formEl(k) {
    const label = (text) => div().text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child(text);
    const about = { code: "Yours, the ones waiting on your review, and those merged this week", ci: "Your pipelines, and the failed jobs in them", tickets: "The issues assigned to you" };
    const pick = (s) =>
      h_flex()
        .id(`gitlab-pick-${s}`)
        .gap(10)
        .items_start()
        .when(s !== "code", (e) => e.cursor_pointer().on_click((_e, cx) => this.togglePick(s, cx)))
        .child(div().pt(2).child(Checkbox(`gitlab-check-${s}`, { checked: this.picks.has(s), tooltip: s === "code" ? "Always: it is what connecting GitLab is for" : undefined })))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(div().text_size(TEXT.sm).font_medium().child(SECTIONS[s]))
            .child(div().text_size(TEXT.xs).text_color(k.dim).child(about[s])),
        );
    const replacing = replaces(this.config, [...this.picks]);
    return v_flex()
      .gap(12)
      .when(Boolean(this.current), (e) =>
        e.child(
          h_flex()
            .gap(8)
            .items_center()
            .p(10)
            .rounded(RADIUS.md)
            .bg(k.muted)
            .child(Icon(this.current.sections.length ? "circle-check" : "alert", { size: 14, color: this.current.sections.length ? k.success : k.warning }))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(TEXT.sm)
                .child(this.current.sections.length ? `Connected to ${this.current.host}: ${this.current.sections.map((s) => SECTIONS[s].toLowerCase()).join(", ")}` : `${this.current.host} is saved but nothing is mapped yet: connect again`),
            ),
        ),
      )
      .child(
        v_flex()
          .gap(6)
          .child(label("Where is your GitLab?"))
          .child(
            Pills("gitlab-kind", [["com", "GitLab.com"], ["self", "Self-hosted"]], this.kind, (kind, cx) => {
              this.kind = kind;
              this.error = "";
              if (kind === "self") this.address.focus();
              else this.handle.focus();
              cx.notify();
            }),
          ),
      )
      .when(this.kind === "self", (e) =>
        e.child(
          v_flex()
            .gap(6)
            .child(label("Server address"))
            .child(h_flex().child(TextField(this.address)))
            .child(div().text_size(TEXT.xs).text_color(k.dim).child("The address you open GitLab at. A page of it pasted whole works too: Flow finds the server in it.")),
        ),
      )
      .child(v_flex().gap(8).child(label("What Flow shows")).children(Object.keys(SECTIONS).map(pick)))
      .when(replacing.length > 0, (e) => e.child(v_flex().gap(2).children(replacing.map((line) => div().text_size(TEXT.xs).text_color(k.warning).child(line)))))
      .child(
        div()
          .text_size(TEXT.xs)
          .text_color(k.dim)
          .child("You sign in in your browser, so Flow reads GitLab as the account you are signed in to there. Then an agent maps GitLab's tools for cockpit, a minute or two for each part. Saved in ~/.config/cockpit/config.json."),
      );
  }

  stepsEl(k) {
    const mark = (state) => {
      if (state === "running") return Spinner({ size: 14, color: k.mutedFg });
      if (state === "done") return Icon("circle-check", { size: 14, color: k.success });
      if (state === "failed") return Icon("circle-x", { size: 14, color: k.destructive });
      return Icon("circle", { size: 14, color: k.dim });
    };
    return v_flex()
      .gap(8)
      .children(
        this.list.map((s) =>
          h_flex()
            .gap(10)
            .items_start()
            .child(div().pt(2).child(mark(this.states[s.id])))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .child(div().text_size(TEXT.sm).text_color(this.states[s.id] ? k.foreground : k.mutedFg).child(s.label))
                .when(Boolean(this.notes[s.id]), (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim).child(this.notes[s.id])))
                .when(s.id === "login" && this.states[s.id] === "running", (e) =>
                  e.child(div().text_size(TEXT.xs).text_color(k.dim).child("Your browser opened GitLab's sign-in page: allow cockpit there, then come back.")),
                ),
            ),
        ),
      )
      .when(this.phase === "done", (e) =>
        e.child(
          div()
            .pt(4)
            .text_size(TEXT.sm)
            .font_medium()
            .text_color(k.success)
            .child(`Connected to ${hostOf(this.base)}. cockpit's hub reads GitLab from now on.`),
        ),
      );
  }

  render() {
    const k = tokens();
    const form = this.phase === "form";
    const buttons = [];
    if (form) {
      if (this.current) buttons.push(Button("gitlab-disconnect", { label: "Disconnect", variant: "outline", disabled: Boolean(this.busy), onClick: (_e, cx) => this.disconnect(cx) }));
      buttons.push(this.busy ? h_flex().flex_1().gap(6).items_center().child(Spinner({ size: 14, color: k.mutedFg })).child(div().text_size(TEXT.xs).text_color(k.dim).child("Disconnecting…")) : div().flex_1());
      buttons.push(Button("gitlab-cancel", { label: "Cancel", variant: "outline", onClick: () => this.close() }));
      buttons.push(Button("gitlab-connect", { label: this.current ? "Connect again" : "Connect", icon: "link", disabled: !this.ready(), onClick: (_e, cx) => this.connect(cx) }));
    } else if (this.phase === "running") {
      buttons.push(div().flex_1().text_size(TEXT.xs).text_color(k.dim).child("Closing leaves it running: a notification says how it went."));
      buttons.push(Button("gitlab-hide", { label: "Close", variant: "outline", onClick: () => this.close() }));
    } else if (this.phase === "failed") {
      buttons.push(div().flex_1());
      buttons.push(
        Button("gitlab-back", {
          label: "Back",
          variant: "outline",
          onClick: (_e, cx) => {
            this.phase = "form";
            this.error = "";
            cx.notify();
          },
        }),
      );
      buttons.push(Button("gitlab-retry", { label: "Retry", icon: "rotate-ccw", onClick: (_e, cx) => this.runFrom(this.failedAt ?? 0, cx) }));
    } else {
      buttons.push(div().flex_1());
      buttons.push(Button("gitlab-done", { label: "Done", onClick: () => this.close() }));
    }
    return v_flex()
      .id("gitlab-form")
      .track_focus(this.handle)
      .key_context("FlowGitlab")
      .on_action("flow_gitlab_escape", () => this.close())
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .w_full()
      .p(18)
      .gap(14)
      .rounded(RADIUS.lg)
      .bg(k.popover)
      .text_color(k.foreground)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(Icon("git-merge", { size: 16, color: k.mutedFg }))
          .child(div().flex_1().text_size(TEXT.lg).font_semibold().child(form ? "Connect GitLab" : `Connecting ${hostOf(this.base ?? GITLAB_COM)}`))
          .child(div().text_size(TEXT.xs).text_color(k.dim).child("Esc")),
      )
      .child(form ? this.formEl(k) : this.stepsEl(k))
      .when(Boolean(this.error), (e) => e.child(div().text_size(TEXT.xs).text_color(k.destructive).child(this.error)))
      .child(h_flex().pt(4).gap(8).items_center().children(buttons));
  }
}
