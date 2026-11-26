// The form that says how a pane's machine reaches another one: an ssh host, and a jump host when it goes through one,
// written into flow.json's routes. It checks the host answers before saving, and a form opened from a split makes that
// split once saved. Enter saves, Esc cancels.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, closeOverlay, openOverlay, exec, appHome, readTextFile, writeTextFile } from "herdr";
import { tokens, TEXT, RADIUS, Button, TextField, Pills, Spinner, Icon } from "./ui.js";
import { LOCAL, ROUTES_FILE, machineWords, setRoute, sshCheck, sshFields, sshRule } from "./bridge.js";
import { splitOnto } from "./termmenu.js";

/**
 * Opens the form. `origin`: the machine the route starts from (null: this computer). `target`: the machine it reaches,
 * or null to pick one of `targets` in the form. `direction` and `pane`: the split to make once it is saved
 * (`direction` "none": no split).
 */
export function openMachineForm({ origin = null, target = null, targets = [], direction = "none", pane = null }) {
  openOverlay({ mod: "flow", kind: "dialog", width: 440, props: { app: "machine-form", origin, target, targets, direction, pane } });
}

const routesPath = () => `${appHome()}/${ROUTES_FILE}`;

export default class MachineForm {
  init(_props, cx) {
    const p = props() ?? {};
    this.target = p.target ?? p.targets?.[0] ?? null;
    this.busy = false;
    this.error = "";
    // A host that didn't answer is saved on a second press, as typed.
    this.unchecked = false;
    this.config = {};
    this.host = InputState.new({ placeholder: "me@host, or a Host in that machine's ~/.ssh/config" });
    this.jump = InputState.new({ placeholder: "Jump host (optional)" });
    for (const input of [this.host, this.jump]) {
      input.on("change", (_e, cx) => {
        this.error = "";
        this.unchecked = false;
        cx.notify();
      });
      input.on("submit", (_e, cx) => this.save(cx));
    }
    this.handle = cx.focus_handle();
    this.host.focus();
    cx.timer.after(50, () => this.host.focus());
    this.loadRoutes(cx);
  }

  /** Reads flow.json and fills the fields with the route already there, if any. */
  loadRoutes(cx) {
    cx.spawn(async (cx) => {
      let error = "";
      try {
        this.config = JSON.parse((await readTextFile(routesPath())) ?? "{}") ?? {};
      } catch (e) {
        error = `${ROUTES_FILE} can't be read: ${e?.message ?? e}`;
      }
      this.fill();
      // Filling the fields counts as a change, which clears the error: say it after.
      this.error = error;
      cx.notify();
    });
  }

  fill() {
    const { host, jump } = sshFields(this.config, this.target, props()?.origin ?? null);
    this.host.set_value(host);
    this.jump.set_value(jump);
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  /** Whether the form came from a split, which it makes once saved. */
  splits() {
    const p = props() ?? {};
    return Boolean(p.pane) && (p.direction === "right" || p.direction === "down");
  }

  ready() {
    return Boolean(this.target) && sshRule(this.host.value(), this.jump.value()) !== null;
  }

  save(cx) {
    if (this.busy || !this.ready()) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.saveRoute();
      } catch (e) {
        this.error = e?.message ?? String(e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  async saveRoute() {
    const p = props() ?? {};
    const host = this.host.value().trim();
    const jump = this.jump.value().trim();
    if (!this.unchecked) {
      const on = p.origin && p.origin !== LOCAL ? { on: p.origin } : {};
      const [cmd, ...args] = sshCheck(host, jump);
      const r = await exec(cmd, args, { ...on, timeout: 15000 }).catch((e) => ({ code: -1, stderr: e?.message ?? String(e) }));
      if (r.code !== 0) {
        this.unchecked = true;
        const why = (r.stderr || "").trim() || `ssh exited with ${r.code}`;
        throw new Error(`${machineWords(p.origin)} couldn't get into ${host} without a password: ${why}`);
      }
    }
    // Read again right before writing, so an edit made meanwhile is kept; a file changed in between rejects the write.
    const text = await readTextFile(routesPath());
    const next = setRoute(text ? JSON.parse(text) : {}, this.target, p.origin ?? null, sshRule(host, jump));
    await writeTextFile(routesPath(), `${JSON.stringify(next, null, 2)}\n`, text);
    this.close();
    if (this.splits()) void splitOnto(p.direction, p.pane, this.target);
  }

  render() {
    const k = tokens();
    const p = props() ?? {};
    const from = machineWords(p.origin);
    const label = (text) => div().text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child(text);
    const title = p.target ? `How ${from} reaches ${machineWords(p.target)}` : `How ${from} reaches the others`;
    const action = this.unchecked ? "Save anyway" : this.splits() ? "Save and split" : "Save";
    return v_flex()
      .id("machine-form")
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
          .child(Icon("route", { size: 16, color: k.mutedFg }))
          .child(div().flex_1().text_size(TEXT.lg).font_semibold().child(title))
          .child(div().text_size(TEXT.xs).text_color(k.dim).child("Esc")),
      )
      .when(!p.target && (p.targets?.length ?? 0) > 0, (e) =>
        e.child(
          v_flex()
            .gap(6)
            .child(label("To"))
            .child(
              Pills("machine-form-target", p.targets.map((t) => [t, machineWords(t)]), this.target, (t, cx) => {
                this.target = t;
                this.fill();
                this.error = "";
                this.unchecked = false;
                cx.notify();
              }),
            ),
        ),
      )
      .child(v_flex().gap(6).child(label("ssh host")).child(h_flex().child(TextField(this.host))))
      .child(v_flex().gap(6).child(label("Through")).child(h_flex().child(TextField(this.jump, { active: false }))))
      .child(
        div()
          .text_size(TEXT.xs)
          .text_color(k.dim)
          .child(`Each split opens an ssh shell from ${from}, so the host is as ${from}'s ssh knows it, and it must get in without a password (an ssh key). Saved in ${ROUTES_FILE}.`),
      )
      .when(Boolean(this.error), (e) => e.child(div().text_size(TEXT.xs).text_color(k.destructive).child(this.error)))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .items_center()
          .justify_end()
          .when(this.busy, (e) => e.child(Spinner({ size: 14, color: k.mutedFg })).child(div().text_size(TEXT.xs).text_color(k.dim).child("Checking…")))
          .child(Button("machine-form-cancel", { label: "Cancel", variant: "outline", onClick: () => this.close() }))
          .child(Button("machine-form-save", { label: action, disabled: this.busy || !this.ready(), onClick: (_e, cx) => this.save(cx) })),
      );
  }
}
