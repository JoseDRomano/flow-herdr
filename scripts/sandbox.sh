#!/bin/sh
# A Herdr app window of its own on cockpit's acme demo world, showing Flow: never the person's window, never their
# cockpit data. Everything lives under $COCKPIT_SANDBOX (default: $TMPDIR/flow-gui). The hub is the cockpit binary
# installed on this machine (COCKPIT_BIN), and the demo world comes from a cockpit checkout (COCKPIT_REPO, default
# ../cockpit-herdr beside this one).
#
#   sh scripts/sandbox.sh start            fake HOME with the demo world (FRESH=1 rebuilds it), a separate Herdr window,
#                                      Flow linked into it and shown
#   sh scripts/sandbox.sh do <cmd> [json]  a Herdr command in that window (layout.select, app.theme, ...)
#   sh scripts/sandbox.sh show <app>       that app's screen in front (home, work, todo, runbook, ...)
#   sh scripts/sandbox.sh layout <name>    the window on that layout (flow)
#   sh scripts/sandbox.sh kit [tab]        the design kit's gallery as a window
#   sh scripts/sandbox.sh light|dark       the window's appearance
#   sh scripts/sandbox.sh key <keystroke>  a key pressed in the view in front (j, shift-d, ctrl-p, escape, ...)
#   sh scripts/sandbox.sh shot [file.png]  a screenshot of that window, its path printed
#   sh scripts/sandbox.sh check            herdr-app check on the Flow mod
#   sh scripts/sandbox.sh status           herdr-app status (errors from the mod show here)
#   sh scripts/sandbox.sh env              the variables to run cockpit or herdr-app against the sandbox yourself
#   sh scripts/sandbox.sh stop             quits the window and stops the sandbox's hub (and its herdr-core)
#
# The window gets an empty herdr-core of its own (HC_SESSION, default the sandbox folder's name). That herdr-core runs
# with the real HOME, so the sandbox's hc refuses to type into its terminals unless SANDBOX_ALLOW_SEND=1.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cockpit=${COCKPIT_REPO:-$repo/../cockpit-herdr}
tmp=${TMPDIR:-/tmp}
box=${COCKPIT_SANDBOX:-${tmp%/}/flow-gui}
box=${box%/}
fake_home="$box/home"
app_home="$box/herdr-home"
installed=$(command -v cockpit 2>/dev/null || echo "$HOME/.local/bin/cockpit")
bin=${COCKPIT_BIN:-$installed}
herdr_app=${HERDR_APP_BIN:-$HOME/.local/bin/herdr-app}
app_bundle=${HERDR_APP_BUNDLE:-$([ -d "$HOME/Applications/Herdr.app" ] && echo "$HOME/Applications/Herdr.app" || echo /Applications/Herdr.app)}
session=${HC_SESSION:-$(basename "$box")}

# Notifications show as the window's toasts and system ones only go to a log. hc runs on the real HOME: under the fake
# one it would start a herdr-core of its own, not the window's. The hub fetches nothing and asks no agent for models.
in_box() {
  HOME="$fake_home" HERDR_APP_HOME="$app_home" COCKPIT_FRONTEND=app COCKPIT_TOASTS=always COCKPIT_HUB_FEED=off \
    COCKPIT_HUB_MODELS=off COCKPIT_NOTIFY_PROGRAM="$box/notified.sh" COCKPIT_HC_BIN="$box/hc.sh" "$@"
}
app() { HERDR_APP_HOME="$app_home" "$herdr_app" "$@"; }

# The hc the sandbox's hub runs, written to $1: herdr-core's own hc on the real HOME and the sandbox's session. What it
# would type into a terminal there is refused, unless SANDBOX_ALLOW_SEND=1.
hc_wrapper() {
  {
    printf '#!/bin/sh\n'
    printf 'if [ "${1:-}" = send ] && [ "${SANDBOX_ALLOW_SEND:-%s}" != 1 ]; then\n' "${SANDBOX_ALLOW_SEND:-}"
    printf '  echo "sandbox: typing into a terminal with the real HOME is refused" >&2\n  exit 1\nfi\n'
    printf 'HOME="%s" %sexec "%s/.local/bin/hc" "$@"\n' "$HOME" "${session:+HC_SESSION=$session }" "$HOME"
  } >"$1"
  chmod +x "$1"
}

running() { [ -S "$app_home/herdr-app.sock" ] && app status >/dev/null 2>&1; }

start() {
  [ -x "$bin" ] || { echo "no cockpit binary at $bin: install cockpit or set COCKPIT_BIN" >&2; exit 1; }
  [ -f "$cockpit/docs/screenshots/demo_data.py" ] || { echo "no cockpit checkout at $cockpit: set COCKPIT_REPO" >&2; exit 1; }
  [ -d "$app_bundle" ] || { echo "no Herdr app at $app_bundle: set HERDR_APP_BUNDLE" >&2; exit 1; }
  mkdir -p "$fake_home" "$app_home"
  # The welcome window would cover every screenshot.
  [ -f "$app_home/shared.json" ] || printf '{"frame.welcomed": "skipped"}\n' >"$app_home/shared.json"
  printf '#!/bin/sh\nprintf "%%s | " "$@" >> "%s/notified.log"; echo >> "%s/notified.log"\n' "$box" "$box" >"$box/notified.sh"
  chmod +x "$box/notified.sh"
  hc_wrapper "$box/hc.sh"
  if [ ! -f "$fake_home/.config/cockpit/config.json" ] || [ "${FRESH:-}" = 1 ]; then
    # The window's mod would start a hub again at once, and the hub's store keeps the documents of the last run.
    if running; then
      app "do" app.quit >/dev/null 2>&1 || true
      i=0
      while running && [ $i -lt 40 ]; do i=$((i + 1)); sleep 0.25; done
    fi
    in_box "$bin" hub stop >/dev/null 2>&1 || true
    rm -f "$fake_home/.cache/cockpit/store.redb" "$fake_home/.cache/cockpit/hub.stopped"
    python3 "$cockpit/docs/screenshots/demo_data.py" "$fake_home" >/dev/null
  fi
  if ! running; then
    # The app writes its home on its first start; its environment says it is a sandbox that takes keys from a shell.
    open -n "$app_bundle" --env HERDR_APP_HOME="$app_home" --env COCKPIT_SANDBOX="$box" --env COCKPIT_TEST_KEYS=1 --env HC_SESSION="$session"
    i=0
    until running; do
      i=$((i + 1))
      [ $i -gt 60 ] && { echo "the sandbox's Herdr window did not start" >&2; exit 1; }
      sleep 0.5
    done
  fi
  # cockpit's install writes the cockpit.json Flow reads to reach the hub; Flow goes in beside it.
  in_box "$bin" app install --from "$cockpit/app" >/dev/null
  in_box "$bin" hub stop >/dev/null 2>&1 || true
  rm -f "$fake_home/.cache/cockpit/hub.stopped"
  HERDR_APP_HOME="$app_home" sh "$repo/scripts/install.sh" >/dev/null
  app "do" overlay.close >/dev/null 2>&1 || true
  app "do" layout.switch '{"name": "flow"}' >/dev/null
  echo "sandbox: $box (HOME $fake_home, HERDR_APP_HOME $app_home)"
}

case "${1:-}" in
  start) start ;;
  do) shift; app "do" "$@" ;;
  show) app "do" "flow.go:$2" ;;
  layout) app "do" layout.switch "{\"name\": \"$2\"}" ;;
  kit) app "do" "flow.kit${2:+:$2}" ;;
  light | dark)
    python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['appearance']=sys.argv[2]; json.dump(d, open(p, 'w'), indent=2)" \
      "$app_home/settings.json" "$1"
    ;;
  key) app "do" "flow.key:$2" >/dev/null ;;
  shot) sleep "${SETTLE:-1}"; app shot "${2:-$box/shot.png}" ;;
  check) app check "$app_home/mods/flow" ;;
  status) app status ;;
  env) echo "HOME=$fake_home HERDR_APP_HOME=$app_home COCKPIT_FRONTEND=app" ;;
  stop)
    in_box "$bin" hub stop >/dev/null 2>&1 || true
    running && app "do" app.quit >/dev/null 2>&1 || true
    [ -z "$session" ] || "$box/hc.sh" server stop >/dev/null 2>&1 || true
    ;;
  *) sed -n '2,23p' "$0"; exit 1 ;;
esac
