# Working on Flow as a coding agent

Flow is a Herdr app layout: `layouts/flow*.json`, one mod in `mods/flow/` (plain ES modules on Herdr's `gpui-kit`, no
build step), `themes/flow*.json` and `keys.json`. The mod is ported from cockpit's (`quaresc/cockpit`, `app/`) and
draws the data of cockpit's hub, which stays installed and is never part of this repo. Herdr's own guide to layouts
and mods is `AGENTS.md` in the Herdr app home (`~/.config/herdr-app/AGENTS.md`); read it, don't edit it.

## Names

Everything of Flow's is called `flow`: the mod (`"mod": "flow"`), the layout (`flow`), commands
(`flow.go:inbox`), shared keys (`flow.panel.open`), key contexts (`FlowPalette`), element ids, `data/flow/`. What
stays `cockpit` is cockpit's: the `cockpit` binary (`hub.cockpit([...])`), `cockpit.json`, `~/.config/cockpit`,
`~/.cache/cockpit`, the hub's views and acts, and cockpit's install instructions. Never name cockpit's mod or layouts
from Flow: they are another install's.

## Never touch the person's live setup

Flow runs on the machine you work on, probably beside you. Leave alone their Herdr window and herdr-core terminals,
their Herdr app home (`~/.config/herdr-app`, so no `scripts/install.sh` there unless they ask), their running cockpit hub
and data under `~/.cache/cockpit` and `~/.config/cockpit`, and their agents' settings.

Check visible work in the sandbox only: `COCKPIT_SANDBOX=/tmp/fl-<letter> HC_SESSION=fl-<letter> sh scripts/sandbox.sh
start`, then `show`, `shot`, `light`/`dark`, `check`, and `stop` when done.

## No real data

Fixtures, screenshots and examples use cockpit's acme demo world only (`acme/api`, `ENG-412`, Maya, Sam, Priya, Leo,
Omar, `me@acme.example`, `@example.com`). Never copy anything from the person's own work into the repo.

## House rules

- Doc comments: one or two plain sentences in the present tense, saying what the code does. No history, no issue or
  PR numbers.
- The mod is one folder: Herdr refuses imports outside a mod's folder, so don't split it.
- A layout node the mod names (`center`, `work`, `view`, `main`, `agent`, `panel`, `panel-body`, `home`, `home-agent`,
  `sidebar`, `status`, ...) keeps its id; `screens.js` lists each layout's screens. Moving the side panel or the status
  bar changes `INSETS` in `web.js`.
- Ported code keeps a header naming its source and licence, and an entry in `THIRD_PARTY_NOTICES.md`.
- Don't commit, push, tag or bump versions unless the person asks.

## Before saying it is done

```sh
node --experimental-vm-modules --test tests/*.test.mjs
for f in mods/flow/*.js; do node --input-type=module --check < "$f" || echo "$f"; done
for f in layouts/*.json themes/*.json keys.json mods/flow/mod.json; do jq empty "$f" || echo "$f"; done
shellcheck -S warning scripts/*.sh
```

For a visible change, screenshot it in the sandbox in both themes, and run `python3 scripts/preview.py` when the
layout's shape or theme changes. Report what failed honestly.
