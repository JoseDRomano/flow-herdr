#!/bin/sh
# Puts Flow's layouts, mod and themes in a Herdr app home and merges its keys, beside cockpit's own files, which it never
# touches. Flow draws the data of cockpit's hub, so cockpit stays installed: https://github.com/quaresc/cockpit#install
#
#   sh scripts/install.sh [--copy] [--switch]   links this checkout's files into the Herdr home (--copy copies them),
#                                               --switch shows the Flow layout once installed
#   sh scripts/install.sh --uninstall           takes Flow's files and key sections out again
#
# HERDR_APP_HOME names the Herdr home (default ~/.config/herdr-app); HERDR_APP_BIN the herdr-app used for --switch.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
herdr_app=${HERDR_APP_BIN:-$HOME/.local/bin/herdr-app}
mode=link
switch=0
uninstall=0
for arg in "$@"; do
  case "$arg" in
    --copy) mode=copy ;;
    --switch) switch=1 ;;
    --uninstall) uninstall=1 ;;
    *) sed -n '2,10p' "$0"; exit 1 ;;
  esac
done

# Every path Flow owns in the Herdr home, relative to it and to this checkout alike.
owned() {
  echo mods/flow
  for f in "$repo"/layouts/flow*.json "$repo"/layouts/flow*.svg "$repo"/themes/flow*.json; do
    [ -e "$f" ] && echo "${f#"$repo"/}"
  done
}

# Clears the spot a Flow file goes to: a link or an earlier install of Flow's goes, anything else moves to flow-backups/
# (outside mods/, where Herdr would load a copied folder as a mod of its own).
clear_spot() {
  to=$1
  if [ -L "$to" ] || { [ -e "$to" ] && [ -f "$home/.flow-installed" ]; }; then
    rm -rf "$to"
  elif [ -e "$to" ]; then
    aside="$home/flow-backups/$(date +%Y%m%d%H%M%S)/${to#"$home"/}"
    mkdir -p "$(dirname "$aside")"
    mv "$to" "$aside"
    echo "moved the earlier ${to#"$home"/} to $aside"
  fi
}

# The key sections of ours ($1) merged into theirs ($2): a key the person bound in one of them stays theirs.
merge_keys() {
  jq -n --slurpfile ours "$1" --slurpfile theirs "$2" \
    'reduce ($ours[0] | keys[]) as $s ($theirs[0]; .[$s] = ($ours[0][$s] + ($theirs[0][$s] // {})))'
}

# Their keys ($1) without the sections ours ($2) has.
drop_keys() {
  jq -n --slurpfile ours "$2" --slurpfile theirs "$1" 'reduce ($ours[0] | keys[]) as $s ($theirs[0]; del(.[$s]))'
}

command -v jq >/dev/null 2>&1 || { echo "install.sh needs jq" >&2; exit 1; }
[ -d "$home" ] || { echo "no Herdr app home at $home: start the Herdr app once first" >&2; exit 1; }

if [ "$uninstall" = 1 ]; then
  for rel in $(owned); do
    if [ -L "$home/$rel" ] || [ -e "$home/$rel" ]; then rm -rf "$home/$rel"; fi
  done
  if [ -f "$home/keys.json" ]; then
    cp "$home/keys.json" "$home/keys.json.bak-flow"
    drop_keys "$home/keys.json.bak-flow" "$repo/keys.json" >"$home/keys.json"
  fi
  rm -f "$home/.flow-installed"
  echo "removed Flow from $home (cockpit's own files are untouched)"
  exit 0
fi

mkdir -p "$home/mods" "$home/layouts" "$home/themes"
for rel in $(owned); do
  clear_spot "$home/$rel"
  if [ "$mode" = link ]; then ln -s "$repo/$rel" "$home/$rel"; else cp -R "$repo/$rel" "$home/$rel"; fi
done
echo "$mode $repo" >"$home/.flow-installed"

if [ -f "$home/keys.json" ]; then
  cp "$home/keys.json" "$home/keys.json.bak-flow"
  merge_keys "$repo/keys.json" "$home/keys.json.bak-flow" >"$home/keys.json"
else
  cp "$repo/keys.json" "$home/keys.json"
fi

verb=$([ "$mode" = link ] && echo linked || echo copied)
echo "$verb Flow's layouts, mod and themes into $home"
[ -f "$home/cockpit.json" ] || echo "cockpit is not installed in this Herdr home: Flow's Home shows how to install it"

if [ "$switch" = 1 ]; then
  HERDR_APP_HOME="$home" "$herdr_app" do layout.switch '{"name": "flow"}' >/dev/null && echo "switched the window to Flow"
fi
