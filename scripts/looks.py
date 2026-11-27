#!/usr/bin/env python3
"""Writes Flow's looks as layouts of their own: layouts/flow-<look>.json is layouts/flow.json with the look's themes,
picture and the changes scripts/looks.json gives it, and keys.json gets a layout:flow-<look> section with the same keys
as layout:flow. Edit flow.json, looks.json and layout:flow, then run this; tests/looks.test.mjs fails while a look is
out of date."""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Each layout and its dark and light themes. `flow` is the source the others are written from.
LOOKS = {
    "flow": ("flow", "flow-light"),
    "flow-mist": ("flow-mist", "flow-mist-light"),
    "flow-daylight": ("flow-daylight", "flow-daylight-light"),
}

WIDTH = 172


def inline(value):
    """The value on one line, written as flow.json writes its short nodes."""
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{json.dumps(k)}: {inline(v)}" for k, v in value.items()) + " }" if value else "{}"
    if isinstance(value, list):
        return "[" + ", ".join(inline(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False)


def dump(value, indent=0):
    """The value as flow.json is written: a node on one line when it fits and holds no nodes, else one key or node a line."""
    pad = " " * indent
    one = inline(value)
    has_nodes = (isinstance(value, dict) and any(k in value for k in ("children", "floating"))) or (
        isinstance(value, list) and any(isinstance(v, dict) for v in value)
    )
    if not isinstance(value, (dict, list)) or (not has_nodes and len(pad) + len(one) <= WIDTH and indent > 0):
        return one
    inner = " " * (indent + 2)
    if isinstance(value, list):
        return "[\n" + ",\n".join(inner + dump(v, indent + 2) for v in value) + "\n" + pad + "]"
    return "{\n" + ",\n".join(f"{inner}{json.dumps(k)}: {dump(v, indent + 2)}" for k, v in value.items()) + "\n" + pad + "}"


def patched(tree, changes):
    """The layout tree with a look's changes: root keys, keys of named nodes, every card's frame and the panes' frame.
    A change to null takes the key out."""
    tree = json.loads(json.dumps(tree))

    def change(target, keys):
        for k, v in keys.items():
            if v is None:
                target.pop(k, None)
            else:
                target[k] = v

    change(tree, changes.get("root", {}))

    def walk(node):
        if not isinstance(node, dict):
            return
        change(node, changes.get("nodes", {}).get(node.get("id"), {}))
        if node.get("background") == "background" and "radius" in node:
            change(node, changes.get("cards", {}))
        pane = node.get("content", {}).get("pane") if isinstance(node.get("content"), dict) else None
        if pane is not None:
            change(pane, changes.get("panes", {}))
        for child in node.get("children", []) + node.get("floating", []):
            walk(child)

    walk(tree)
    return tree


def layout(name, source, changes):
    """The source layout with this look's themes, picture and changes."""
    tree = json.loads(source)
    dark, light = LOOKS[name]
    tree["theme"] = {"light": light, "dark": dark}
    tree["preview"] = f"layouts/{name}.svg"
    return dump(patched(tree, changes)) + "\n"


def main():
    source = (ROOT / "layouts" / "flow.json").read_text()
    assert dump(json.loads(source)) + "\n" == source, "layouts/flow.json is written as dump() writes it"
    changes = json.loads((ROOT / "scripts" / "looks.json").read_text())
    for name in LOOKS:
        if name != "flow":
            (ROOT / "layouts" / f"{name}.json").write_text(layout(name, source, changes.get(name, {})))
    keys_path = ROOT / "keys.json"
    keys = json.loads(keys_path.read_text())
    for name in LOOKS:
        if name != "flow":
            keys[f"layout:{name}"] = dict(keys["layout:flow"])
    keys_path.write_text(json.dumps(keys, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
