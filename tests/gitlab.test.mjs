import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITLAB_COM, SERVER_KEY, candidates, baseOf, mcpUrl, hostOf, probeArgs, verdict, statusOf, parseConfig, configText,
  withServer, serverBase, connection, replaces, withoutGitlab, synced, steps, stepArgs, readWords, failure, MR_URL,
} from "../mods/flow/gitlab.js";

test("a self-hosted address is read however it was typed or pasted", () => {
  assert.deepEqual(candidates("gitlab.acme.example"), ["https://gitlab.acme.example"]);
  assert.deepEqual(candidates("  https://gitlab.acme.example/  "), ["https://gitlab.acme.example"]);
  assert.deepEqual(candidates("http://gitlab.acme.example:8080"), ["http://gitlab.acme.example:8080"]);
  assert.deepEqual(candidates("HTTPS://GitLab.Acme.Example:443/?tab=1#top"), ["https://gitlab.acme.example"], "case, the default port and the query go");
  // A page pasted whole is cut where GitLab's page starts; what is left may be a folder GitLab is served from, or not.
  assert.deepEqual(candidates("https://gitlab.acme.example/acme/api/-/merge_requests/7"), [
    "https://gitlab.acme.example/acme/api",
    "https://gitlab.acme.example/acme",
    "https://gitlab.acme.example",
  ]);
  assert.deepEqual(candidates("https://acme.example/gitlab/users/sign_in"), ["https://acme.example/gitlab", "https://acme.example"]);
  assert.deepEqual(candidates("https://gitlab.acme.example/api/v4/mcp"), ["https://gitlab.acme.example"]);
  assert.equal(candidates("https://gitlab.acme.example/a/b/c/d/e").length, 4, "three folders deep at most, then the host");
});

test("an address that is no server's says why", () => {
  assert.throws(() => candidates(""), /Type your GitLab server's address/);
  assert.throws(() => candidates("gitlab"), /not a full server name/);
  assert.throws(() => candidates("ftp://gitlab.acme.example"), /starts with https/);
  assert.throws(() => candidates("https://maya:secret@gitlab.acme.example"), /Leave the user and password out/);
  assert.throws(() => candidates("https://"), /not a web address/);
});

test("GitLab.com or a self-hosted server gives the MCP server's address", () => {
  assert.equal(baseOf("com", "ignored"), GITLAB_COM);
  assert.equal(baseOf("self", "gitlab.acme.example/"), "https://gitlab.acme.example");
  assert.equal(mcpUrl("https://gitlab.acme.example/"), "https://gitlab.acme.example/api/v4/mcp");
  assert.equal(mcpUrl(GITLAB_COM), "https://gitlab.com/api/v4/mcp");
  assert.equal(hostOf("https://acme.example/gitlab/"), "acme.example/gitlab");
  assert.deepEqual(probeArgs("https://gitlab.acme.example/api/v4/version").slice(-1), ["https://gitlab.acme.example/api/v4/version"]);
  assert.equal(statusOf("401\n"), 401);
  assert.equal(statusOf(""), 0);
});

test("the check tells a GitLab with an MCP server from one without, and from no GitLab at all", () => {
  const h = "gitlab.acme.example";
  const ok = { code: 0, status: 401 };
  assert.deepEqual(verdict(h, ok, ok), { ok: true });
  assert.deepEqual(verdict(h, { code: 0, status: 200 }, { code: 0, status: 405 }), { ok: true });
  const vpn = verdict(h, { code: 6, status: 0 }, ok);
  assert.equal(vpn.next, false);
  assert.match(vpn.error, /can't reach gitlab\.acme\.example: the name does not resolve.*VPN/);
  assert.match(verdict(h, { code: 60, status: 0 }, ok).error, /certificate is not one this Mac trusts/);
  const page = verdict(h, { code: 0, status: 404 }, ok);
  assert.equal(page.next, true, "a project path is not where the server is: try a shorter address");
  const old = verdict(h, ok, { code: 0, status: 404 });
  assert.equal(old.next, false);
  assert.match(old.error, /has no MCP server: it needs GitLab 18\.6 or later/);
  assert.match(verdict(h, ok, { code: 0, status: 502 }).error, /MCP server fails \(502\)/);
});

test("connecting adds the server and keeps every other one; disconnecting takes GitLab out and nothing else", () => {
  const before = parseConfig(JSON.stringify({ github: { org: "acme" }, servers: { linear: { url: "https://mcp.linear.app/mcp" } }, tickets: { server: "linear", name: "Linear" } }));
  const after = withServer(before, "https://gitlab.acme.example");
  assert.deepEqual(after.servers, { linear: { url: "https://mcp.linear.app/mcp" }, [SERVER_KEY]: { url: "https://gitlab.acme.example/api/v4/mcp" } });
  assert.deepEqual(before.servers, { linear: { url: "https://mcp.linear.app/mcp" } }, "the config read stays as it was");
  assert.equal(serverBase(after), "https://gitlab.acme.example");
  const mapped = { ...after, code: { server: SERVER_KEY, name: "GitLab", enabled: true, tools: { listMine: { tool: "list_merge_requests" } } } };
  assert.deepEqual(withoutGitlab(mapped), before);
  const both = { ...mapped, ci: { server: SERVER_KEY, tools: { listRuns: {} } } };
  const again = withServer(both, "https://gitlab.acme.example", ["code"]);
  assert.equal(again.ci, undefined, "connecting again without pipelines drops them");
  assert.deepEqual(again.code, mapped.code);
  assert.deepEqual(again.tickets, before.tickets, "a section on another server is never touched");
  assert.ok(configText(after).endsWith("}\n"));
  assert.deepEqual(parseConfig(""), {});
  assert.throws(() => parseConfig("{ nope"), /not valid JSON/);
  assert.throws(() => parseConfig("[]"), /not valid JSON/);
});

test("the settings read what is connected: a section counts once its tools are mapped", () => {
  assert.equal(connection({}), null);
  const half = withServer({}, "https://gitlab.acme.example");
  assert.deepEqual(connection(half), { base: "https://gitlab.acme.example", host: "gitlab.acme.example", sections: [] });
  const full = {
    ...half,
    ci: { server: SERVER_KEY, tools: { listRuns: {} } },
    code: { server: SERVER_KEY, tools: { listMine: {} } },
    tickets: { server: SERVER_KEY, enabled: false, tools: { listMine: {} } },
  };
  assert.deepEqual(connection(full).sections, ["code", "ci"]);
});

test("the hub's resolved copy follows config.json's GitLab sections and keeps the rest", () => {
  const config = { code: { server: SERVER_KEY, name: "GitLab", tools: { listMine: {} } }, ci: { server: "circleci" }, servers: { [SERVER_KEY]: { url: "https://gitlab.acme.example/api/v4/mcp" } } };
  const copy = { reposDir: "/Users/maya/src", ci: { server: "circleci", name: "CircleCI" }, tickets: { server: SERVER_KEY } };
  const next = synced(copy, config);
  assert.deepEqual(next.code, config.code);
  assert.deepEqual(next.ci, copy.ci, "a section on another server stays as the copy has it");
  assert.equal(next.tickets, undefined, "a GitLab section config.json dropped goes");
  assert.equal(next.servers, undefined, "servers stay in config.json alone");
  assert.equal(next.reposDir, "/Users/maya/src");
  assert.deepEqual(synced(next, withoutGitlab(config)).code, undefined);
});

test("the dialog says what connecting replaces", () => {
  assert.deepEqual(replaces({}, ["code"]), []);
  assert.deepEqual(replaces({}, ["code", "ci"]), ["Pipelines replace GitHub's checks as cockpit's CI source"]);
  assert.deepEqual(replaces({ github: { enabled: false } }, ["ci"]), []);
  assert.deepEqual(replaces({ ci: { server: "circleci", name: "CircleCI" }, tickets: { server: "jira" } }, ["ci", "tickets"]), [
    "Pipelines replace CircleCI as cockpit's CI source",
    "Issues replace jira as cockpit's tickets source",
  ]);
  assert.deepEqual(replaces({ code: { server: SERVER_KEY } }, ["code"]), [], "reconnecting replaces nothing");
});

test("the steps run cockpit's own connector commands, one map per section", () => {
  const s = steps("gitlab.acme.example", ["code", "ci"]);
  assert.deepEqual(s.map((x) => x.id), ["check", "save", "login", "map:code", "map:ci", "read"]);
  assert.match(s[2].label, /Sign in to gitlab\.acme\.example in your browser/);
  assert.deepEqual(stepArgs("login"), ["connector", "login", "GitLab"]);
  assert.deepEqual(stepArgs("map:ci"), ["connector", "map", "ci", "GitLab"]);
  assert.deepEqual(stepArgs("read"), ["connector", "read", "code", "listMine"]);
  assert.equal(stepArgs("check"), null);
  assert.equal(steps("gitlab.acme.example", ["ci"]).at(-1).label, "Read from GitLab");
});

test("the first read counts the merge requests at the mapping's path", () => {
  const mrs = [{ iid: 7, title: "Store and enforce daily quotas", references: { full: "acme/api!7" } }, { iid: 9 }];
  assert.equal(readWords(JSON.stringify(mrs)), "2 open merge requests of yours");
  assert.equal(readWords(JSON.stringify({ data: { items: [mrs[0]] } }), "data.items"), "1 open merge request of yours");
  assert.equal(readWords("[]"), "No open merge requests of yours yet");
  assert.equal(readWords(JSON.stringify({ content: [{ type: "text" }] })), "GitLab answered", "an envelope is not the list");
  assert.equal(readWords("not json"), "GitLab answered");
});

test("a failure reads as its last line, and a merge request's page as its address", () => {
  assert.equal(failure({ code: 1, stderr: "Opening the login page\ncockpit: error: access_denied\n" }), "access_denied");
  assert.equal(failure({ code: 2, stderr: "", stdout: "" }), "exited with 2");
  assert.equal(MR_URL.exec("https://gitlab.acme.example/acme/api/-/merge_requests/7/diffs")?.[1], "https://gitlab.acme.example/acme/api/-/merge_requests/7");
  assert.equal(MR_URL.exec("https://github.com/acme/api/pull/4"), null);
});
