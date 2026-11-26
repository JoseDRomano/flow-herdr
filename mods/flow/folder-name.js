// The dialog that names a Spaces folder: a new one (`props.machine` moves that machine into it) or an existing one
// (`props.id`, renamed). Enter saves, Esc cancels; it writes the folders to shared state itself.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, shared, setShared, closeOverlay, openOverlay } from "herdr";
import { tokens, TEXT, RADIUS, Button, TextField } from "./ui.js";
import { FOLDERS, normalize, addFolder, renameFolder } from "./folders.js";

/** Opens the dialog: `{ id }` renames that folder, `{ machine }` makes a folder holding that machine key. */
export function openFolderName({ id = null, machine = null } = {}) {
  openOverlay({ mod: "flow", kind: "dialog", width: 380, props: { app: "folder-name", id, machine } });
}

export default class FolderName {
  init(_props, cx) {
    const id = props()?.id ?? null;
    const current = id ? normalize(shared(FOLDERS)).find((g) => g.id === id) : null;
    this.input = InputState.new({ placeholder: "Folder name", value: current?.name ?? "" });
    if (current?.name) this.input.set_selected_range({ start: 0, end: current.name.length });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", () => this.save());
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
  }

  save() {
    const p = props() ?? {};
    const name = this.input.value().trim();
    if (!name) return;
    const groups = shared(FOLDERS);
    setShared(FOLDERS, p.id ? renameFolder(groups, p.id, name) : addFolder(groups, name, p.machine ?? null).groups);
    closeOverlay(p.overlay);
  }

  render() {
    const k = tokens();
    const p = props() ?? {};
    const empty = !this.input.value().trim();
    return v_flex()
      .id("folder-name")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          closeOverlay(p.overlay);
          cx.stop_propagation();
        }
      })
      .w_full()
      .p(18)
      .gap(12)
      .rounded(RADIUS.lg)
      .bg(k.popover)
      .text_color(k.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(TEXT.lg).font_semibold().child(p.id ? "Rename folder" : "New folder")).child(div().text_size(TEXT.xs).text_color(k.dim).child("Esc")))
      .child(h_flex().child(TextField(this.input)))
      .when(!p.id, (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim).child(p.machine ? "The machine moves into it. Right-click other machines to add them." : "Right-click a machine in Spaces to move it into this folder.")))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .justify_end()
          .child(Button("folder-name-cancel", { label: "Cancel", variant: "outline", onClick: () => closeOverlay(p.overlay) }))
          .child(Button("folder-name-save", { label: p.id ? "Rename" : "Create", disabled: empty, onClick: () => this.save() })),
      );
  }
}
