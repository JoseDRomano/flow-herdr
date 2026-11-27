#!/usr/bin/env python3
"""Draws each Flow layout's preview from its themes (scripts/looks.py names them): layouts/<name>.svg (dark) and,
rendered by AppKit on macOS, the Layout tab's pictures mods/flow/layouts/<name>-dark.png and <name>-light.png."""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

from looks import LOOKS

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 320, 204.8


def palette(name):
    t = json.loads((ROOT / "themes" / f"{name}.json").read_text())
    c = t["colors"]
    return {**c, "fg": t["foreground"], "ansi": t["ansi"]}


def svg(p):
    fg, muted, dim, accent = p["fg"], p["muted"], p["dim"], p["accent"]
    red, green, yellow, blue = p["ansi"][1], p["done"], p["blocked"], p["working"]
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="800" height="512">']
    add = out.append
    # The sky behind everything: the theme's chrome at the top, its canvas at the bottom, as the layout paints it.
    add(f'<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{p["chrome"]}"/><stop offset="1" stop-color="{p["canvas"]}"/></linearGradient></defs>')
    add(f'<rect width="{W}" height="{H}" rx="10" fill="url(#sky)"/>')
    # The flow bar: window buttons, brand, tabs as pills, the bell.
    add(f'<circle cx="10" cy="10.5" r="2.6" fill="#ff5f57"/><circle cx="18" cy="10.5" r="2.6" fill="#febc2e"/><circle cx="26" cy="10.5" r="2.6" fill="#28c840"/>')
    add(f'<rect x="36" y="7" width="7" height="7" rx="2" fill="{accent}"/>')
    add(f'<g font-family="Geist, Helvetica, sans-serif" font-size="5.5" fill="{muted}">')
    add(f'<text x="47" y="12.5" fill="{fg}" font-weight="600">Flow</text>')
    for i, (label, on) in enumerate([("acme-api", True), ("acme-web", False), ("docs", False)]):
        x = 104 + i * 42
        if on:
            add(f'<rect x="{x}" y="5" width="38" height="11" rx="5.5" fill="{p["background"]}"/>')
        add(f'<text x="{x + 6}" y="12.5" fill="{fg if on else muted}">{label}</text>')
    add("</g>")
    add(f'<path d="M305 8.5a3.2 3.2 0 0 1 6.4 0v3l1 1.5h-8.4l1-1.5z" fill="none" stroke="{muted}" stroke-width="0.8"/>')
    add(f'<circle cx="312" cy="7.5" r="1.6" fill="{red}"/>')
    # The sidebar under the bar.
    top, bottom = 21, H - 13.6
    add(f'<rect x="6" y="{top + 2}" width="58" height="8" rx="4" fill="none" stroke="{p["border"]}"/>')
    for i, pct in enumerate([0.64, 0.31]):
        y = top + 15 + i * 9
        add(f'<rect x="6" y="{y}" width="58" height="6" rx="2" fill="{p["raised"]}"/>')
        add(f'<rect x="6" y="{y}" width="{58 * pct:.1f}" height="6" rx="2" fill="{accent}" opacity="0.85"/>')
    for i in range(6):
        add(f'<rect x="{6 + i * 10}" y="{top + 35}" width="8" height="8" rx="2" fill="{p["selected"] if i == 0 else p["raised"]}"/>')
    add(f'<rect x="6" y="{top + 48}" width="58" height="22" rx="3" fill="{red}" opacity="0.12"/>')
    add(f'<rect x="9" y="{top + 52}" width="34" height="2.6" rx="1.3" fill="{fg}"/>')
    add(f'<rect x="9" y="{top + 57}" width="48" height="2.2" rx="1.1" fill="{muted}"/>')
    add(f'<rect x="9" y="{top + 62}" width="22" height="4" rx="2" fill="{accent}"/>')
    for i, color in enumerate([yellow, blue, green, dim, blue]):
        y = top + 78 + i * 9
        add(f'<circle cx="9" cy="{y + 1.5}" r="1.6" fill="{color}"/>')
        add(f'<rect x="14" y="{y}" width="{44 - (i % 3) * 7}" height="3" rx="1.5" fill="{muted}" opacity="0.8"/>')
    add(f'<rect x="6" y="{bottom - 12}" width="40" height="3" rx="1.5" fill="{dim}"/>')
    # The center: Home as a borderless card; a look with a sky (Daylight) has glass cards and a serif greeting.
    sky = "sky_floor" in p
    cx, cy, cw, ch = 74, top + 2, W - 74 - 4, bottom - top - 6
    if sky:
        add(f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" rx="6" fill="{p["background"]}" stroke="{p["glass_line"]}" stroke-width="0.5"/>')
        add(f'<g font-family="Georgia" fill="{fg}"><text x="{cx + 9}" y="{cy + 13}" font-size="7.5" font-style="italic">Good afternoon</text>')
        add(f'<text x="{cx + 8}" y="{cy + 33}" font-size="22">1</text></g>')
        add(f'<rect x="{cx + 22}" y="{cy + 28}" width="38" height="2.4" rx="1.2" fill="{muted}"/>')
        cy += 18
    else:
        add(f'<rect x="{cx + 0.6}" y="{cy + 1.2}" width="{cw}" height="{ch}" rx="7" fill="#000" opacity="0.18"/>')
        add(f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" rx="7" fill="{p["background"]}"/>')
        add(f'<g font-family="Geist, Helvetica, sans-serif" font-size="7" fill="{fg}" font-weight="600"><text x="{cx + 9}" y="{cy + 14}">Good afternoon</text></g>')
    add(f'<rect x="{cx + 9}" y="{cy + 18}" width="80" height="2.4" rx="1.2" fill="{muted}"/>')
    for i in range(4):
        x = cx + 9 + i * 39
        add(f'<rect x="{x}" y="{cy + 26}" width="35" height="18" rx="3" fill="{p["surface"]}"/>')
        add(f'<rect x="{x + 4}" y="{cy + 30}" width="12" height="5" rx="1" fill="{[red, blue, accent, green][i]}"/>')
        add(f'<rect x="{x + 4}" y="{cy + 38}" width="22" height="2" rx="1" fill="{dim}"/>')
    add(f'<rect x="{cx + 9}" y="{cy + 50}" width="152" height="16" rx="3" fill="{red}" opacity="0.12"/>')
    add(f'<rect x="{cx + 13}" y="{cy + 55}" width="70" height="2.4" rx="1.2" fill="{fg}"/>')
    add(f'<rect x="{cx + 13}" y="{cy + 60}" width="18" height="3.4" rx="1.7" fill="{accent}"/>')
    add(f'<rect x="{cx + 9}" y="{cy + 72}" width="152" height="{ch - 80 - (18 if sky else 0)}" rx="4" fill="{p["raised"]}" opacity="0.45"/>')
    for i in range(4):
        x = cx + 13 + (i % 2) * 74
        y = cy + 80 + (i // 2) * 30
        add(f'<rect x="{x}" y="{y}" width="70" height="26" rx="3" fill="{p["background"]}" stroke="{p["border"]}" stroke-width="0.5"/>')
        add(f'<circle cx="{x + 5}" cy="{y + 5}" r="1.6" fill="{[yellow, blue, green, blue][i]}"/>')
        add(f'<rect x="{x + 9}" y="{y + 4}" width="40" height="2.4" rx="1.2" fill="{fg}"/>')
        add(f'<rect x="{x + 5}" y="{y + 11}" width="58" height="2" rx="1" fill="{muted}"/>')
        add(f'<rect x="{x + 5}" y="{y + 19}" width="18" height="2" rx="1" fill="{p["border"]}"/>')
        add(f'<rect x="{x + 5}" y="{y + 19}" width="{6 + i * 3}" height="2" rx="1" fill="{blue}"/>')
    rx = cx + 168
    for i, label_w in enumerate([30, 34, 26]):
        y = cy + 26 + i * 34
        add(f'<rect x="{rx}" y="{y}" width="{cw - 177}" height="30" rx="3" fill="{p["surface"]}"/>')
        add(f'<rect x="{rx + 4}" y="{y + 4}" width="{label_w}" height="2.4" rx="1.2" fill="{fg}"/>')
        add(f'<rect x="{rx + 4}" y="{y + 10}" width="{cw - 190}" height="2" rx="1" fill="{muted}"/>')
        add(f'<rect x="{rx + 4}" y="{y + 15}" width="{cw - 200}" height="2" rx="1" fill="{muted}"/>')
    # The status bar across the window.
    add(f'<rect x="4" y="{bottom + 2}" width="3.4" height="3.4" rx="1.7" fill="{green}"/>')
    add(f'<rect x="11" y="{bottom + 3}" width="40" height="2" rx="1" fill="{dim}"/>')
    add(f'<rect x="{W - 60}" y="{bottom + 3}" width="54" height="2" rx="1" fill="{dim}"/>')
    add("</svg>")
    return see_through("\n".join(out) + "\n")


def see_through(text):
    """The picture with each #rrggbbaa colour written as #rrggbb and its opacity, which every SVG renderer reads."""
    def split(m):
        attr, rgb, a = m.group(1), m.group(2), int(m.group(3), 16) / 255
        opacity = {"fill": "fill-opacity", "stroke": "stroke-opacity", "stop-color": "stop-opacity"}[attr]
        return f'{attr}="#{rgb}" {opacity}="{a:.3f}"'
    return re.sub(r'(fill|stroke|stop-color)="#([0-9a-fA-F]{6})([0-9a-fA-F]{2})"', split, text)


def png(text, to):
    """Renders an SVG to an 800x512 PNG with AppKit (scripts/svg2png.swift, macOS), or says it cannot."""
    if not shutil.which("swift"):
        print(f"no swift: {to} not rendered", file=sys.stderr)
        return
    with tempfile.TemporaryDirectory() as tmp:
        src = pathlib.Path(tmp) / "preview.svg"
        src.write_text(text)
        subprocess.run(["swift", str(ROOT / "scripts" / "svg2png.swift"), str(src), str(to), "800", "512"], check=True, timeout=300)


if __name__ == "__main__":
    for name, (dark_theme, light_theme) in LOOKS.items():
        dark, light = svg(palette(dark_theme)), svg(palette(light_theme))
        (ROOT / "layouts" / f"{name}.svg").write_text(dark)
        png(dark, ROOT / "mods" / "flow" / "layouts" / f"{name}-dark.png")
        png(light, ROOT / "mods" / "flow" / "layouts" / f"{name}-light.png")
