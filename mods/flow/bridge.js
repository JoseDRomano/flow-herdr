// Panes on another machine: a pane of this tab whose program reaches that machine's shell and attaches it here (a
// bridge). Herdr keeps a tab's panes on its own machine, so a split onto another one is a pane on the tab's machine
// holding the remote shell. The tab's machine reaches the other one as flow.json's routes say: hc (start, then attach)
// from this computer by default, ssh or any command from elsewhere. Pure helpers only: termmenu.js runs them in Herdr.

/** The shared-state key remembering each bridge pane: `{ [pane]: { machine, folder, argv } }`. */
export const BRIDGES = "flow.bridges";

/** The file in the Herdr home that says how each machine is reached from each other one (`routes`). */
export const ROUTES_FILE = "flow.json";

/** The name routes give this computer, as a target and as the machine a split starts from. */
export const LOCAL = "local";

/**
 * The script a bridge pane runs. `hc run` alone waits for its program like a script would and shows nothing, so this
 * starts the machine's shell there in the background (`hc run --bg`, this pane its parent so it ends with the pane),
 * then puts the pane on it (`hc attach`). hc is found on PATH or where Herdr installs it. When either step fails, its
 * error stays on screen until Enter instead of the pane closing at once.
 */
export const ATTACH_SCRIPT = [
  'h=$(command -v hc) || h="$HOME/.local/bin/hc"',
  'm=$1; d=$2',
  'set -- run --bg --json --no-notify --on "$m"',
  '[ -n "$d" ] && set -- "$@" --cwd "$d"',
  'out=$("$h" "$@") || { printf "\\nCould not start a shell on %s. Press Enter to close.\\n" "$m"; read -r _; exit 1; }',
  'a=$(printf "%s" "$out" | sed -n \'s/.*"address":"\\([^"]*\\)".*/\\1/p\')',
  '[ -n "$a" ] || { printf "%s\\nNo terminal from %s. Press Enter to close.\\n" "$out" "$m"; read -r _; exit 1; }',
  'case $a in */*) ;; *) a="$m/$a" ;; esac',
  'exec "$h" attach "$a"',
].join("; ");

/** The program a bridge pane runs: the machine's own shell, in `folder` there when given, attached to this pane. */
export function bridgeArgv(machine, folder = null) {
  return ["sh", "-c", ATTACH_SCRIPT, "flow-bridge", machine, ...(folder ? [folder] : [])];
}

/** A shell line that runs `argv` in place of the shell that reads it, so leaving the program closes the pane. */
export const execLine = (argv) => ["exec", ...argv].map(quote).join(" ");

/** A shell line that puts a pane back on its machine, as `bridgeArgv` started it; `exec` so leaving it closes the pane. */
export function bridgeLine(machine, folder = null) {
  return execLine(bridgeArgv(machine, folder));
}

/**
 * One route as flow.json writes it, read into `{ kind: "hc", name }`, `{ kind: "ssh", dest, jump, options }` or
 * `{ kind: "argv", argv }`; null when it says nothing usable. `"hc"` and `"ssh"` alone reach the target by its own name.
 */
export function parseRoute(rule, target) {
  if (typeof rule === "string") {
    const [kind, ...rest] = rule.split(":");
    const named = rest.join(":") || target;
    if (kind === "hc" && named !== LOCAL) return { kind: "hc", name: named };
    if (kind === "ssh" && named !== LOCAL) return { kind: "ssh", dest: named, jump: null, options: [] };
    return null;
  }
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  const words = (list) => (Array.isArray(list) && list.every((w) => typeof w === "string") ? list : null);
  if (typeof rule.hc === "string" && rule.hc && rule.hc !== LOCAL) return { kind: "hc", name: rule.hc };
  if (typeof rule.ssh === "string" && rule.ssh) {
    return { kind: "ssh", dest: rule.ssh, jump: typeof rule.jump === "string" && rule.jump ? rule.jump : null, options: words(rule.options) ?? [] };
  }
  const argv = words(rule.argv);
  return argv?.length ? { kind: "argv", argv } : null;
}

/**
 * How a split started on `origin` (a machine's name, null for this computer) reaches `target` (a name, or `local`):
 * `{ kind: "split" }` on its own machine, the route flow.json gives for that pair or for `*`, `hc` from this computer,
 * else null, which leaves it to the caller to ask the origin's hc whether it knows the target.
 */
export function routeFor(config, target, origin = null) {
  const from = origin ?? LOCAL;
  if (target === from) return { kind: "split" };
  const rules = config?.routes?.[target];
  const rule = rules && typeof rules === "object" ? (rules[from] ?? rules["*"]) : undefined;
  if (rule !== undefined) return parseRoute(rule, target);
  return from === LOCAL ? { kind: "hc", name: target } : null;
}

/** The program a pane runs to reach its machine by `route`, in `folder` there when given. */
export function routeArgv(route, folder = null) {
  if (route.kind === "hc") return bridgeArgv(route.name, folder);
  if (route.kind === "ssh") {
    const shell = folder ? [`cd ${quote(folder)} && exec "$SHELL" -l`] : [];
    return ["ssh", "-t", ...(route.jump ? ["-J", route.jump] : []), ...route.options, route.dest, ...shell];
  }
  return route.argv.flatMap((w) => (w === "{folder}" ? (folder ? [folder] : []) : [w.replaceAll("{folder}", folder ?? "~")]));
}

/** A machine's name as a person reads it: `local` is this computer. */
export const machineWords = (name) => (!name || name === LOCAL ? "this computer" : name);

/** How ssh is told where to go (`vps`, `me@10.0.0.7`, `me@10.0.0.7:2222`, a Host in ~/.ssh/config): one word, no option. */
export const validHost = (host) => /^[^\s-][^\s]*$/.test(String(host ?? ""));

/** The route a form's fields make: `"ssh:<host>"`, `{ ssh, jump }` through a jump host; null without a usable host. */
export function sshRule(host, jump = "") {
  const h = String(host ?? "").trim();
  const j = String(jump ?? "").trim();
  if (!validHost(h) || (j && !validHost(j))) return null;
  return j ? { ssh: h, jump: j } : `ssh:${h}`;
}

/** The ssh host and jump host the route from `origin` to `target` names in flow.json, for the form to start from. */
export function sshFields(config, target, origin = null) {
  const rule = config?.routes?.[target]?.[origin ?? LOCAL];
  const r = rule === undefined ? null : parseRoute(rule, target);
  return r?.kind === "ssh" ? { host: r.dest, jump: r.jump ?? "" } : { host: "", jump: "" };
}

/** flow.json with `rule` as the way `origin` (null: this computer) reaches `target`, the rest kept as it was. */
export function setRoute(config, target, origin, rule) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const routes = base.routes && typeof base.routes === "object" && !Array.isArray(base.routes) ? base.routes : {};
  const pairs = routes[target] && typeof routes[target] === "object" && !Array.isArray(routes[target]) ? routes[target] : {};
  return { ...base, routes: { ...routes, [target]: { ...pairs, [origin ?? LOCAL]: rule } } };
}

/** The ssh line that checks a route answers without asking anything, before it is saved. */
export const sshCheck = (host, jump = "") => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(jump ? ["-J", jump] : []), host, "true"];

/** A word as a POSIX shell reads it back: bare when it is plain, else in single quotes. */
export function quote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The machines a split can go to, from `hc machine ls --json`: named, not an agent's short-lived one, by name. */
export function machineChoices(listed) {
  const list = Array.isArray(listed) ? listed : (listed?.machines ?? []);
  return list
    .filter((m) => m && typeof m.name === "string" && m.name && !m.temporary)
    .map((m) => ({ name: m.name, state: typeof m.state === "string" ? m.state : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A machine's state as a menu says it: nothing when connected or unknown, else its words ("needs login"). */
export const stateWords = (state) => (!state || state === "connected" ? "" : state.replace(/_/g, " "));

/** The bridges as stored, cleaned: entries naming a machine, those of panes no longer shown dropped when `live` is given. */
export function normalize(stored, live = null) {
  const out = {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  for (const [pane, b] of Object.entries(stored)) {
    if (!b || typeof b.machine !== "string" || !b.machine) continue;
    if (live && !live.has(pane)) continue;
    const argv = Array.isArray(b.argv) && b.argv.length && b.argv.every((w) => typeof w === "string") ? b.argv : null;
    out[pane] = { machine: b.machine, folder: typeof b.folder === "string" && b.folder ? b.folder : null, ...(argv ? { argv } : {}) };
  }
  return out;
}

/** The bridges with this pane on `machine` added (with the program that reached it), and the panes that went dropped. */
export const remember = (stored, pane, machine, folder, live, argv = null) => ({
  ...normalize(stored, live),
  [pane]: { machine, folder: folder ?? null, ...(argv ? { argv } : {}) },
});

/**
 * The line that puts a lost bridge pane back: the program it was opened with, else the attach script to its machine.
 * A pane opened with a bare `hc run` (which shows nothing) gets the attach script too.
 */
export const reconnectLine = (bridge) =>
  execLine(bridge.argv && bridge.argv[0] !== "hc" ? bridge.argv : bridgeArgv(bridge.machine, bridge.folder));

/** The bridge a pane is, or null. */
export const bridgeOf = (stored, pane) => normalize(stored)[pane] ?? null;

/**
 * Whether a bridge pane lost its machine: Herdr gives a terminal lost to a reboot or a core restart a shell in its
 * last folder, and never runs the bridge program again, so a bridge pane running a shell is one to reconnect.
 */
export const lost = (bridge, pane) => Boolean(bridge && pane?.program?.shell);

/**
 * The right-click menu of a terminal, as Herdr's own has it plus the splits onto another machine. `inTab`: the terminal
 * has a pane in a tab (a layout terminal block or a window has none, so no pane items). `run` items are Herdr commands;
 * `command` items are cockpit's window commands.
 */
export function paneItems({ pane, terminal, inTab, parent = null, toProgram = false, bridge = null, reconnect = false }) {
  const items = [];
  if (inTab) {
    items.push(
      { label: "Rename", icon: "pencil", run: ["pane.rename", { pane }] },
      "separator",
      { label: "Split right", icon: "columns", run: ["pane.split", { direction: "right", pane }] },
      { label: "Split down", icon: "square-split", run: ["pane.split", { direction: "down", pane }] },
      { label: "Split right on…", icon: "server", command: `split:on|right|${pane}` },
      { label: "Split down on…", icon: "server", command: `split:on|down|${pane}` },
      "separator",
      { label: "Zoom", icon: "maximize", run: ["pane.zoom", { pane }] },
    );
    if (bridge && reconnect) items.push({ label: `Reconnect to ${bridge.machine}`, icon: "refresh-cw", command: `split:again|${pane}` });
  }
  if (terminal) {
    items.push(
      toProgram
        ? { label: "Use Herdr right-click menu", icon: "hand", run: ["terminal.right_click", { terminal, to: "menu" }] }
        : { label: "Send right-clicks to pane", icon: "hand", run: ["terminal.right_click", { terminal, to: "program" }] },
    );
  }
  if (parent) items.push({ label: `Send back to ${parent}`, icon: "undo", run: ["terminal.park", { terminal }] });
  if (inTab) items.push("separator", { label: "Close pane", icon: "x", destructive: true, run: ["pane.close", { pane }] });
  return items;
}

/**
 * The dropdown of machines a split goes to: the machine the pane's thread works on first (`thread`, a name or `local`,
 * when it isn't the pane's own), then the pane's own machine, then this computer when the pane is on another one, then
 * each other machine with its state when it isn't connected. `origin` is the machine the pane's tab lives on (null: this
 * computer). `direction` null lists both directions, each under its own heading. It ends with Add a machine… (Herdr's
 * own dialog), and from another machine's pane the form that says how it reaches the others.
 */
export function machineItems(direction, pane, machines, origin = null, thread = null) {
  const to = (dir, target) => `split:to|${dir}|${pane}|${target}`;
  const lead = thread && thread !== (origin ?? LOCAL) ? thread : null;
  const section = (dir) => [
    ...(lead ? [{ label: `${lead === LOCAL ? "This computer" : lead} · this thread's machine`, icon: "server", command: to(dir, lead) }] : []),
    origin
      ? { label: `${origin} · this pane's machine`, icon: "server", command: to(dir, origin) }
      : { label: "This computer", icon: "terminal", command: to(dir, LOCAL) },
    ...(origin && lead !== LOCAL ? [{ label: "This computer", icon: "terminal", command: to(dir, LOCAL) }] : []),
    ...machines
      .filter((m) => m.name !== origin && m.name !== lead)
      .map((m) => {
        const words = stateWords(m.state);
        return { label: words ? `${m.name} · ${words}` : m.name, icon: "server", command: to(dir, m.name) };
      }),
  ];
  const dir = direction ?? "none";
  const notes = [
    "separator",
    { label: "Add a machine…", icon: "plus", run: ["mod.open", { name: "machine-add" }] },
    ...(origin ? [{ label: `How ${origin} reaches the others…`, icon: "route", command: `split:route|${dir}|${pane}` }] : []),
  ];
  if (direction) return [...section(direction), ...notes];
  return [{ info: true, label: "Split right on" }, ...section("right"), "separator", { info: true, label: "Split down on" }, ...section("down"), ...notes];
}
