// GitLab for Flow: a GitLab.com or self-hosted server's address turned into its MCP server's, the check that the server
// answers, the config.json changes that point cockpit's merge requests, pipelines and issues at it, and what a config
// says is connected. The connect dialog (gitlab-form.js) runs the steps; this file has no side effects.

export const GITLAB_COM = "https://gitlab.com";
/** The `servers` key cockpit's sections name the GitLab server by. */
export const SERVER_KEY = "GitLab";
/** cockpit's sections GitLab can feed, as the form names them, merge requests first. */
export const SECTIONS = { code: "Merge requests", ci: "Pipelines", tickets: "Issues" };
const MCP_PATH = "/api/v4/mcp";

/** GitLab's own top-level pages, which start a page only right after the host or the folder GitLab is served from. */
const RESERVED = new Set(["users", "dashboard", "explore", "admin", "help", "oauth", "search", "profile", "groups"]);

/** A pasted page's path cut where GitLab's page starts: at `/-/`, at `/api/v4`, or at one of its own top-level pages. */
function rootPath(pathname) {
  const parts = pathname.split(/\/-(?:\/|$)/)[0].split(/\/api\/v4(?:\/|$)/)[0].split("/").filter(Boolean);
  const at = parts.findIndex((p, i) => i < 2 && RESERVED.has(p));
  return at < 0 ? parts : parts.slice(0, at);
}

/**
 * The address typed or pasted as `{ origin, pathname }`, with https added when it has no scheme; throws with why it is
 * not one. A plain pattern rather than URL, which Herdr's runtime gives only through its `url` module.
 */
function parse(typed) {
  let text = String(typed ?? "").trim();
  if (!text) throw new Error("Type your GitLab server's address, such as https://gitlab.acme.example");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const found = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]*)([^?#\s]*)/i.exec(text);
  const scheme = found?.[1].toLowerCase();
  if (scheme !== "https" && scheme !== "http") throw new Error("A GitLab server's address starts with https://");
  const authority = found[2];
  if (authority.includes("@")) throw new Error("Leave the user and password out of the address: you sign in in the browser");
  const host = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(authority);
  if (!host) throw new Error(`${String(typed).trim()} is not a web address`);
  const hostname = host[1].toLowerCase();
  if (!hostname.includes(".") && hostname !== "localhost") throw new Error(`${hostname} is not a full server name, such as gitlab.acme.example`);
  const port = host[2] && !(scheme === "https" && host[2] === "443") && !(scheme === "http" && host[2] === "80") ? `:${host[2]}` : "";
  return { origin: `${scheme}://${hostname}${port}`, pathname: found[3] || "/" };
}

/**
 * The addresses the server may live at, most likely first: what was typed, cut where a GitLab page starts, then each
 * shorter folder down to the bare host. GitLab can be served from a folder (`https://acme.example/gitlab`), which only
 * the check tells from a group or project path.
 */
export function candidates(typed) {
  const url = parse(typed);
  const parts = rootPath(url.pathname);
  const out = [];
  for (let n = Math.min(parts.length, 3); n >= 0; n--) out.push(`${url.origin}${n ? `/${parts.slice(0, n).join("/")}` : ""}`);
  return out;
}

/** The server's base address once chosen: GitLab.com's, or the first self-hosted candidate. */
export function baseOf(kind, typed) {
  return kind === "com" ? GITLAB_COM : candidates(typed)[0];
}

/** The MCP server's address on a GitLab server. */
export const mcpUrl = (base) => `${base.replace(/\/+$/, "")}${MCP_PATH}`;

/** The server's host and folder, as the settings and dialog name it: "gitlab.acme.example". */
export const hostOf = (base) => base.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** curl's arguments to read one address's HTTP status, without following redirects or saving the body. */
export const probeArgs = (url) => ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", url];

/** curl's exit codes that mean the server was never reached, with what to tell the person. */
const UNREACHED = {
  6: "the name does not resolve: check the address, or connect to the VPN it sits behind",
  7: "nothing answers there: check the address, or connect to the VPN it sits behind",
  28: "it did not answer within 10 seconds: connect to the VPN it sits behind, or try again",
  35: "the secure connection failed",
  51: "its certificate does not match the address",
  60: "its certificate is not one this Mac trusts (an internal certificate authority): add it to the Keychain",
};

/**
 * What the two reads of a candidate say, each `{ code, status }` (curl's exit code and the HTTP status): `api` is
 * `/api/v4/version`, `mcp` the MCP server. Gives `{ ok: true }`, or `{ ok: false, next, error }` where `next` says to try
 * the next candidate because this address is not a GitLab server's.
 */
export function verdict(host, api, mcp) {
  if (api.code !== 0) return { ok: false, next: false, error: `Flow can't reach ${host}: ${UNREACHED[api.code] ?? `curl exited with ${api.code}`}.` };
  // An unsigned read of the API gets 401 from GitLab, 200 from one that lets anyone read; anything else is no GitLab.
  if (api.status !== 401 && api.status !== 200) return { ok: false, next: true, error: `${host} does not answer like a GitLab server (${api.status || "no answer"} at /api/v4/version).` };
  if (mcp.code !== 0) return { ok: false, next: false, error: `Flow can't reach ${host}'s MCP server: ${UNREACHED[mcp.code] ?? `curl exited with ${mcp.code}`}.` };
  if (mcp.status === 404) {
    return {
      ok: false,
      next: false,
      error: `${host} has no MCP server: it needs GitLab 18.6 or later with the MCP server and OAuth dynamic client registration turned on by an administrator.`,
    };
  }
  if (mcp.status >= 500) return { ok: false, next: false, error: `${host}'s MCP server fails (${mcp.status}): try again later, or ask an administrator.` };
  return { ok: true };
}

/** curl's status output as a number, 0 when it printed none. */
export const statusOf = (stdout) => Number.parseInt(String(stdout ?? "").trim(), 10) || 0;

/** config.json's text as an object, `{}` when there is none yet; throws with why when it can't be read. */
export function parseConfig(text) {
  if (!text || !text.trim()) return {};
  try {
    const config = JSON.parse(text);
    if (config && typeof config === "object" && !Array.isArray(config)) return config;
  } catch {}
  throw new Error("~/.config/cockpit/config.json is not valid JSON: fix it, or run cockpit setup");
}

/** The config as config.json writes it: two spaces, a final newline. */
export const configText = (config) => `${JSON.stringify(config, null, 2)}\n`;

/**
 * The config with the GitLab server at `base` among its `servers`, every other server kept. Given the sections picked,
 * a section that read from GitLab and is no longer picked goes.
 */
export function withServer(config, base, picked = null) {
  const next = { ...config, servers: { ...(config.servers ?? {}), [SERVER_KEY]: { url: mcpUrl(base) } } };
  if (picked) for (const s of Object.keys(SECTIONS)) if (next[s]?.server === SERVER_KEY && !picked.includes(s)) delete next[s];
  return next;
}

/** The base address the config's GitLab server is at, or null. */
export function serverBase(config) {
  const url = config?.servers?.[SERVER_KEY]?.url;
  return typeof url === "string" && url.endsWith(MCP_PATH) ? url.slice(0, -MCP_PATH.length) : null;
}

/** Whether a section reads from the GitLab server and has its tools mapped. */
const mapped = (config, section) => {
  const s = config?.[section];
  return s?.server === SERVER_KEY && s.enabled !== false && Object.keys(s.tools ?? {}).length > 0;
};

/**
 * What the config says of GitLab: null when no GitLab server is set, else `{ base, host, sections }`, the sections
 * (in SECTIONS' order) that read from it with their tools mapped. A server with no section mapped is half connected.
 */
export function connection(config) {
  const base = serverBase(config);
  if (!base) return null;
  return { base, host: hostOf(base), sections: Object.keys(SECTIONS).filter((s) => mapped(config, s)) };
}

/**
 * What connecting `sections` replaces, one line each: a section set to another server, or CI read from GitHub's checks
 * (cockpit reads one CI source at a time).
 */
export function replaces(config, sections) {
  const out = [];
  for (const s of sections) {
    const server = config?.[s]?.server;
    if (server && server !== SERVER_KEY) out.push(`${SECTIONS[s]} replace ${config[s].name || server} as cockpit's ${s === "ci" ? "CI" : s === "tickets" ? "tickets" : "pull requests"} source`);
    else if (s === "ci" && !server && config?.github?.enabled !== false && config?.ci?.enabled !== false) out.push("Pipelines replace GitHub's checks as cockpit's CI source");
  }
  return out;
}

/** The config with GitLab gone: its server, and every section that reads from it. */
export function withoutGitlab(config) {
  const next = { ...config };
  for (const s of Object.keys(SECTIONS)) if (next[s]?.server === SERVER_KEY) delete next[s];
  if (next.servers?.[SERVER_KEY]) {
    const { [SERVER_KEY]: _gone, ...rest } = next.servers;
    next.servers = rest;
  }
  return next;
}

/**
 * The resolved copy of the config (the cache's config.json, which the hub reads sections from first) with its GitLab
 * sections as config.json now has them: each one config.json points at GitLab copied over, each one it no longer does
 * taken out. The copy holds no `servers`: the hub reads those from config.json itself.
 */
export function synced(copy, config) {
  const next = { ...copy };
  for (const s of Object.keys(SECTIONS)) {
    if (config?.[s]?.server === SERVER_KEY) next[s] = config[s];
    else if (next[s]?.server === SERVER_KEY) delete next[s];
  }
  return next;
}

/** The steps a connect runs, each `{ id, label }`: check, save, sign in, one map per section, then the first read. */
export function steps(host, sections) {
  return [
    { id: "check", label: `Reach ${host}` },
    { id: "save", label: "Save the server in cockpit's config.json" },
    { id: "login", label: `Sign in to ${host} in your browser` },
    ...sections.map((s) => ({ id: `map:${s}`, label: `Map ${SECTIONS[s].toLowerCase()}: an agent reads GitLab's tools, a minute or two` })),
    { id: "read", label: sections.includes("code") ? "Read your merge requests" : "Read from GitLab" },
  ];
}

/** cockpit's command line for each step that runs one (`cockpit <args>`), by step id. */
export function stepArgs(id) {
  if (id === "login") return ["connector", "login", SERVER_KEY];
  if (id.startsWith("map:")) return ["connector", "map", id.slice(4), SERVER_KEY];
  if (id === "read") return ["connector", "read", "code", "listMine"];
  return null;
}

/**
 * What the first read found, in a few words: "3 open merge requests of yours". `prs` is the mapping's dotted path to
 * the list in the answer ("" for the answer itself); an answer with no list there just answered.
 */
export function readWords(stdout, prs = "") {
  let answer;
  try {
    answer = JSON.parse(String(stdout ?? "").trim());
  } catch {
    return "GitLab answered";
  }
  const list = String(prs ?? "").split(".").filter(Boolean).reduce((at, key) => at?.[key], answer);
  if (!Array.isArray(list)) return "GitLab answered";
  const n = list.length;
  return n === 0 ? "No open merge requests of yours yet" : `${n} open merge request${n === 1 ? "" : "s"} of yours`;
}

/** A failed command's reason, its last line of output, without cockpit's own prefix. */
export function failure(r) {
  const text = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`.trim();
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return last.replace(/^(?:cockpit:\s*)?(?:error:\s*)?/i, "") || `exited with ${r?.code ?? "an error"}`;
}

/** A GitLab merge request's address, cut at its number: "https://gitlab.acme.example/acme/api/-/merge_requests/7". */
export const MR_URL = /^(https?:\/\/[^\s]*?\/-\/merge_requests\/\d+)/;
