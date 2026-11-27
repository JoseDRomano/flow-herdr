// The GitLab screen's data: what it asks GitLab's MCP server, and the rows it makes of each answer. `run` is faked, so
// these tests read no GitLab.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS, TABS, callArgs, parseAnswer, itemsOf, hasNext, pipelineState, pipelineOpen, agoText, whenText, eventKind, eventUrl,
  eventRow, mrRow, pipelineRow, workRow, todoRow, projectRow, groupOf, containersOf, pipelineProjects, pipelineFor,
  failedPipelines, mrProjects, inProject, filterRows, mrDetail, pipelineDetail, workDetail, plainText,
  loadCore, loadActivity, loadMergeRequests, loadPipelines, loadIssues, loadMrDetail, loadPipelineDetail, loadWorkDetail,
} from "../mods/flow/gitlab-data.js";

const CORE = {
  username: "maya",
  groups: [{ fullPath: "acme", name: "Acme" }],
  projects: [
    { id: 1, fullPath: "acme/api", name: "API", archived: false, webUrl: "https://gitlab.acme.example/acme/api" },
    { id: 2, fullPath: "maya/notes", name: "Notes", archived: false, webUrl: "https://gitlab.acme.example/maya/notes" },
  ],
};

/** A `run` that answers by tool, remembering every call. */
function fake(table, fallback = () => ({})) {
  const calls = [];
  const run = async (tool, args) => {
    calls.push([tool, args]);
    const answer = table[tool];
    return typeof answer === "function" ? answer(args) : answer ?? fallback(tool, args);
  };
  return { run, calls };
}

test("the calls and the answers", () => {
  assert.deepEqual(callArgs("list_projects", { first: 3 }), ["connector", "call", "GitLab", "list_projects", '{"first":3}']);
  assert.deepEqual(parseAnswer('{"nodes":[]}'), { nodes: [] });
  assert.deepEqual(parseAnswer(""), {});
  assert.throws(() => parseAnswer("cockpit: no"), /not JSON/);
  assert.deepEqual(itemsOf({ nodes: [1] }), [1]);
  assert.deepEqual(itemsOf({ work_items: [2] }), [2]);
  assert.deepEqual(itemsOf({}), []);
  assert.equal(hasNext({ pageInfo: { hasNextPage: true } }), true);
  assert.equal(hasNext({ page_info: { has_next_page: false } }), false);
  assert.equal(TABS.length, 5);
  assert.deepEqual(TABS.map((t) => t.key), ["1", "2", "3", "4", "5"]);
});

test("a pipeline's status reads the same in either API's spelling", () => {
  assert.deepEqual(pipelineState("FAILED"), { key: "failed", label: "Failed", icon: "circle-x", tone: "destructive" });
  assert.equal(pipelineState("success").label, "Passed");
  assert.equal(pipelineState("running").icon, "loader");
  assert.equal(pipelineState("skipped").tone, "mutedFg");
  assert.deepEqual(pipelineState("SOMETHING"), { key: "something", label: "SOMETHING", icon: "circle-help", tone: "mutedFg" });
  assert.equal(pipelineState(null).label, "Unknown");
  assert.equal(pipelineOpen("running"), true);
  assert.equal(pipelineOpen("waiting_for_resource"), true);
  assert.equal(pipelineOpen("success"), false);
});

test("an age is short, and a date is a day and a time", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(agoText("2026-11-27T11:59:40Z", now), "now");
  assert.equal(agoText("2026-11-27T11:30:00Z", now), "30m");
  assert.equal(agoText("2026-11-27T09:00:00Z", now), "3h");
  assert.equal(agoText("2026-11-25T12:00:00Z", now), "2d");
  assert.equal(agoText("2026-11-06T12:00:00Z", now), "3w");
  assert.equal(agoText(null, now), "");
  assert.match(whenText("2026-11-27T09:00:00Z"), /Nov/);
  assert.equal(whenText("nope"), "");
});

test("a contribution event becomes a row onto the page it happened on", () => {
  const project = { fullPath: "acme/api", webUrl: "https://gitlab.acme.example/acme/api" };
  const push = {
    id: 9, action_name: "pushed to", target_type: "Project", target_title: "api", project_id: 1,
    created_at: "2026-11-27T11:00:00Z", push_data: { ref: "main", ref_type: "branch", commit_title: "Fix the lint", commit_to: "abc123" },
  };
  assert.equal(eventKind(push), "push");
  assert.equal(eventUrl(push, project), "https://gitlab.acme.example/acme/api/-/commit/abc123");
  assert.deepEqual(
    (({ key, kind, action, title, project: p, ref, url }) => ({ key, kind, action, title, project: p, ref, url }))(eventRow(push, project)),
    { key: "event:9", kind: "push", action: "pushed to", title: "Fix the lint", project: "acme/api", ref: "branch main", url: "https://gitlab.acme.example/acme/api/-/commit/abc123" },
  );
  const mr = { id: 10, action_name: "opened", target_type: "MergeRequest", target_iid: 7, target_title: "Add the endpoint", created_at: "2026-11-27T10:00:00Z" };
  assert.equal(eventKind(mr), "merge");
  assert.equal(eventUrl(mr, project), "https://gitlab.acme.example/acme/api/-/merge_requests/7");
  assert.equal(eventRow(mr, project).ref, "");
  const issue = { id: 11, action_name: "closed", target_type: "Issue", target_iid: 3 };
  assert.equal(eventUrl(issue, project), "https://gitlab.acme.example/acme/api/-/issues/3");
  assert.equal(eventUrl({ target_type: "WorkItem", target_iid: 4 }, project), "https://gitlab.acme.example/acme/api/-/work_items/4");
  assert.equal(eventUrl({ target_type: "Milestone", target_iid: 2 }, project), "https://gitlab.acme.example/acme/api/-/milestones/2");
  assert.equal(eventUrl({ target_type: "Note" }, project), project.webUrl, "a note has no page of its own: the project's");
  assert.equal(eventUrl(mr, null), null);
});

test("a merge request, a pipeline, a work item, a to-do and a project become rows", () => {
  const mr = mrRow({ id: "gid://gitlab/MergeRequest/1", iid: "7", title: "Add it", project: { fullPath: "acme/api" }, sourceBranch: "feat/x", targetBranch: "main", author: { username: "maya" }, state: "opened", webUrl: "https://gitlab.acme.example/acme/api/-/merge_requests/7" });
  assert.deepEqual([mr.key, mr.iid, mr.project, mr.branch, mr.base, mr.author, mr.state], ["mr:gid://gitlab/MergeRequest/1", "7", "acme/api", "feat/x", "main", "maya", "opened"]);
  const p = pipelineRow({ id: 5, ref: "main", sha: "abcdef1234", status: "FAILED", source: "push", web_url: "u" }, "acme/api");
  assert.deepEqual([p.key, p.project, p.ref, p.status, p.sha], ["pipeline:acme/api:5", "acme/api", "main", "failed", "abcdef1234"]);
  const w = workRow({ id: "gid://gitlab/WorkItem/2", iid: "3", reference: "acme/api#3", title: "Fix it", state: "OPEN", updatedAt: "2026-11-27T10:00:00Z", workItemType: { name: "Issue" }, webUrl: "u" });
  assert.deepEqual([w.key, w.project, w.projectId, w.iid, w.state, w.type], ["issue:gid://gitlab/WorkItem/2", "acme/api", "acme/api", "3", "open", "Issue"]);
  const todo = todoRow({ id: 4, action_name: "review_requested", target: { title: "Review me", target_type: "MERGEREQUEST", project: { path_with_namespace: "acme/api" }, web_url: "u" }, created_at: "2026-11-27T10:00:00Z" });
  assert.deepEqual([todo.key, todo.action, todo.title, todo.project, todo.type], ["todo:4", "review_requested", "Review me", "acme/api", "MERGEREQUEST"]);
  const row = projectRow({ fullPath: "acme/api", name: "API", visibility: "private", webUrl: "u" }, ["acme", "acme/api"]);
  assert.deepEqual([row.key, row.group, row.visibility], ["project:acme/api", "acme/api", "private"]);
  assert.equal(groupOf("acme/api", ["acme", "acme/api", "acme/apix"]), "acme/api");
  assert.equal(groupOf("maya/notes", ["acme"]), "");
});

test("the containers are the groups, then the projects outside any of them", () => {
  const containers = containersOf(CORE);
  assert.deepEqual(containers, [
    { id: "acme", group: true, label: "acme" },
    { id: "maya/notes", group: false, label: "maya/notes" },
  ]);
  const many = containersOf({ groups: Array.from({ length: 12 }, (_, i) => ({ fullPath: `g${i}` })), projects: [] });
  assert.equal(many.length, LIMITS.containers);
  assert.deepEqual(containersOf(CORE, "maya/notes"), [{ id: "maya/notes", group: false, label: "maya/notes" }]);
});

test("pipelines are read from the merge requests' projects first, then the person's, each once", () => {
  assert.deepEqual(pipelineProjects(CORE, ["maya/notes", "acme/api"]), ["maya/notes", "acme/api"]);
  assert.deepEqual(pipelineProjects(CORE, ["maya/notes"], "acme/api"), ["acme/api"]);
  assert.deepEqual(pipelineProjects({ projects: [{ fullPath: "a", archived: false }, { fullPath: "b", archived: true }, { fullPath: "a" }] }), ["a"]);
  assert.equal(pipelineProjects({ projects: [{ fullPath: "a" }, { fullPath: "b" }, { fullPath: "c" }] }, []).length, 3);
  assert.ok(pipelineProjects({ projects: Array.from({ length: 20 }, (_, i) => ({ fullPath: `p${i}` })) }).length <= LIMITS.pipelineProjects);
  const pipes = [
    pipelineRow({ id: 1, ref: "main", status: "success", updated_at: "2026-11-26T10:00:00Z" }, "acme/api"),
    pipelineRow({ id: 2, ref: "main", status: "failed", updated_at: "2026-11-27T10:00:00Z" }, "acme/api"),
    pipelineRow({ id: 3, ref: "main", status: "running", updated_at: "2026-11-27T11:00:00Z" }, "acme/other"),
  ];
  assert.equal(pipelineFor({ project: "acme/api", branch: "main" }, pipes).id, 2, "the newest of that branch");
  assert.equal(pipelineFor({ project: "acme/web", branch: "main" }, pipes), null);
  assert.deepEqual(failedPipelines(pipes).map((p) => p.id), [2]);
  assert.deepEqual(mrProjects([{ project: "a" }, { project: "b" }, { project: "a" }, { project: "" }]), ["a", "b"]);
});

test("a filter keeps the rows with every word, in any field", () => {
  const rows = [{ title: "Fix the lint", project: "acme/api", ref: "main" }, { title: "Add it", project: "acme/web" }];
  assert.equal(filterRows(rows, "").length, 2);
  assert.deepEqual(filterRows(rows, "lint acme"), [rows[0]]);
  assert.deepEqual(filterRows(rows, "ACME"), rows);
  assert.deepEqual(filterRows(rows, "nope"), []);
  assert.equal(inProject(rows[0], "acme/api"), true);
  assert.equal(inProject(rows[0], "acme/web"), false);
  assert.equal(inProject(rows[0], null), true);
});

test("an answer's detail is read into facts, commits, notes and pipelines", () => {
  const mr = mrDetail({
    state: "OPENED", title: "Add it", description: "Body", approved: true, webUrl: "https://gitlab.acme.example/acme/api/-/merge_requests/7",
    approvedBy: { nodes: [{ name: "Sam" }] },
    commits: { nodes: [{ shortId: "abc12345", title: "Fix", authorName: "Maya", authoredDate: "2026-11-27T10:00:00Z" }] },
    notes: { nodes: [{ id: "n1", author: { name: "Sam" }, body: "<p>Looks <b>good</b></p>", createdAt: "2026-11-27T11:00:00Z" }, { id: "n2", system: true, body: "added a commit" }] },
    pipelines: { nodes: [{ status: "FAILED", ref: "main", sha: "abc1234567", path: "/acme/api/-/pipelines/5" }] },
  });
  assert.equal(mr.state, "opened");
  assert.deepEqual(mr.approvedBy, ["Sam"]);
  assert.equal(mr.commits[0].sha, "abc12345");
  assert.equal(mr.notes.length, 1, "system notes are left out");
  assert.equal(mr.notes[0].body, "Looks good");
  assert.equal(mr.pipelines[0].status, "failed");
  assert.equal(mr.pipelines[0].url, "https://gitlab.acme.example/acme/api/-/pipelines/5");
  const pipeline = pipelineDetail({ status: "failed", ref: "main", sha: "abc", jobs: [{ id: 1, name: "test", stage: "test", status: "failed", web_url: "u" }] });
  assert.equal(pipeline.jobs[0].status, "failed");
  const work = workDetail({ title: "Fix", state: "OPEN", workItemType: { name: "Task" }, description: "Body", namespace: { fullPath: "acme/api" } });
  assert.deepEqual([work.state, work.type, work.namespace], ["open", "Task", "acme/api"]);
  assert.equal(plainText("<p>a<br>b</p> &amp; <b>c</b>"), "a\nb\n & c");
});

// ---------------------------------------------------------------------------------------------------------------------

test("the person, their groups and their projects are one read", async () => {
  const { run, calls } = fake({
    get_user: { username: "maya" },
    list_groups: { nodes: [{ fullPath: "acme", name: "Acme" }] },
    list_projects: { nodes: [{ id: 1, fullPath: "acme/api", name: "API", archived: false, webUrl: "u" }, { fullPath: "" }] },
  });
  const core = await loadCore(run);
  assert.equal(core.username, "maya");
  assert.deepEqual(core.groups, [{ fullPath: "acme", name: "Acme" }]);
  assert.deepEqual(core.projects.map((p) => p.fullPath), ["acme/api"]);
  assert.deepEqual(calls.map((c) => c[0]).sort(), ["get_user", "list_groups", "list_projects"]);
  const none = fake({ get_user: {}, list_groups: {}, list_projects: {} });
  await assert.rejects(loadCore(none.run), /did not say who you are/);
});

test("the activity resolves an event's project only when it does not know it, and adds the to-dos", async () => {
  const events = [
    { id: 1, action_name: "pushed to", target_type: "Project", target_title: "API", project_id: 1, created_at: "2026-11-27T11:00:00Z", push_data: { ref: "main", commit_title: "Fix", commit_to: "abc" } },
    { id: 2, action_name: "opened", target_type: "MergeRequest", target_iid: 7, target_title: "Add", project_id: 2, created_at: "2026-11-27T10:00:00Z" },
    { id: 3, action_name: "joined", target_type: "Project", target_title: "Extra", project_id: 9, created_at: "2026-11-27T09:00:00Z" },
  ];
  const { run, calls } = fake({
    list_user_events: { items: events },
    list_todos: { nodes: [{ id: 3, action_name: "review_requested", target: { title: "Review", target_type: "MERGEREQUEST" } }] },
    get_project: (args) => ({ id: args.project_id, fullPath: args.project_id === 9 ? "acme/extra" : "maya/notes", webUrl: args.project_id === 9 ? "https://gitlab.acme.example/acme/extra" : "https://gitlab.acme.example/maya/notes" }),
  });
  const activity = await loadActivity(run, CORE);
  assert.equal(activity.rows[0].project, "acme/api", "a project the person's list has needs no look-up");
  assert.equal(activity.rows[1].project, "maya/notes");
  assert.equal(activity.rows[1].url, "https://gitlab.acme.example/maya/notes/-/merge_requests/7");
  assert.equal(activity.rows[2].project, "acme/extra");
  assert.equal(activity.todos.length, 1);
  assert.deepEqual(calls.filter((c) => c[0] === "get_project").map((c) => c[1]), [{ project_id: 9 }]);
});

test("a chosen project narrows every read to that project", async () => {
  const activity = fake({
    list_user_events: {
      items: [
        { id: 1, action_name: "pushed to", target_type: "Project", target_title: "API", project_id: 1, push_data: { ref: "main", commit_title: "Fix" } },
        { id: 2, action_name: "pushed to", target_type: "Project", target_title: "Notes", project_id: 2, push_data: { ref: "main", commit_title: "Write" } },
      ],
    },
    list_todos: { nodes: [
      { id: 3, action_name: "review_requested", target: { title: "Review API", project: { path_with_namespace: "acme/api" } } },
      { id: 4, action_name: "review_requested", target: { title: "Review Notes", project: { path_with_namespace: "maya/notes" } } },
    ] },
  });
  const scoped = await loadActivity(activity.run, CORE, "maya/notes");
  assert.deepEqual(scoped.rows.map((r) => r.project), ["maya/notes"]);
  assert.deepEqual(scoped.todos.map((t) => t.project), ["maya/notes"]);

  const mrs = fake({ list_merge_requests: { nodes: [
    { id: "mr-1", iid: 1, title: "Mine", project: { fullPath: "maya/notes" } },
    { id: "mr-2", iid: 2, title: "Another project's", project: { fullPath: "acme/api" } },
  ] } });
  const mergeRequests = await loadMergeRequests(mrs.run, CORE, "maya/notes");
  assert.deepEqual(mergeRequests.rows.map((r) => r.title), ["Mine"], "an answer from another project is left out");
  const asked = mrs.calls.filter(([tool]) => tool === "list_merge_requests").map(([, args]) => args);
  assert.equal(asked.length, 3);
  assert.ok(asked.every((args) => args.project_id === "maya/notes" && !args.group_id));

  const pipes = fake({ list_pipelines: { items: [{ id: 1, ref: "main", status: "success" }] } });
  const pipelines = await loadPipelines(pipes.run, CORE, ["acme/api"], "maya/notes");
  assert.deepEqual(pipelines.projects, ["maya/notes"]);
  assert.deepEqual(pipes.calls.map(([, args]) => args.id), ["maya/notes"]);

  const issues = fake({ list_work_items: { work_items: [
    { id: "w1", iid: "1", reference: "maya/notes#1", title: "Mine", state: "OPEN" },
    { id: "w2", iid: "2", reference: "acme/api#2", title: "Another project's", state: "OPEN" },
  ] } });
  const scopedIssues = await loadIssues(issues.run, CORE, "maya/notes");
  assert.deepEqual(scopedIssues.rows.map((r) => r.title), ["Mine"]);
  assert.ok(issues.calls.filter(([tool]) => tool === "list_work_items").every(([, args]) => args.project_id === "maya/notes" && !args.group_id));
});

test("merge requests are read as yours, waiting on your review, and merged, and listed once", async () => {
  const node = (iid, project, title) => ({ id: `mr-${project}-${iid}`, iid, title, project: { fullPath: project }, sourceBranch: "feat", targetBranch: "main", state: "opened", webUrl: `u/${iid}` });
  const { run, calls } = fake({
    list_merge_requests: (args) => {
      if (args.group_id === "acme" && args.state === "opened" && args.author_username === "maya") return { nodes: [node(7, "acme/api", "Mine")] };
      if (args.group_id === "acme" && args.reviewer_username === "maya") return { nodes: [node(8, "acme/api", "Review")] };
      if (args.group_id === "acme" && args.state === "merged") return { nodes: [node(5, "acme/api", "Merged")] };
      if (args.project_id === "maya/notes") return { nodes: [] };
      return { nodes: [] };
    },
  });
  const mrs = await loadMergeRequests(run, CORE);
  assert.deepEqual(mrs.rows.map((r) => [r.title, r.scope]), [["Mine", "yours"], ["Review", "review"], ["Merged", "merged"]]);
  assert.deepEqual(mrs.containers, ["acme", "maya/notes"]);
  assert.equal(mrs.failed, 0);
  const queried = calls.filter((c) => c[0] === "list_merge_requests").map((c) => c[1]);
  assert.ok(queried.some((a) => a.group_id === "acme" && a.author_username === "maya" && a.state === "opened"));
  assert.ok(queried.some((a) => a.group_id === "acme" && a.reviewer_username === "maya"));
  assert.ok(queried.some((a) => a.project_id === "maya/notes" && a.state === "merged"));
});

test("pipelines are asked for each project of the merge requests and the person's own", async () => {
  const { run, calls } = fake({
    list_pipelines: (args) => ({ items: [{ id: args.id === "acme/api" ? 1 : 2, ref: "main", status: "success", updated_at: "2026-11-27T10:00:00Z", web_url: "u" }] }),
  });
  const pipelines = await loadPipelines(run, CORE, ["maya/notes"]);
  assert.deepEqual(pipelines.projects, ["maya/notes", "acme/api"]);
  assert.deepEqual(pipelines.rows.map((p) => [p.project, p.id]), [["maya/notes", 2], ["acme/api", 1]]);
  assert.ok(calls.filter((c) => c[0] === "list_pipelines").every(([, args]) => args.order_by === "updated_at" && args.sort === "desc"));
});

test("issues are the ones assigned to the person, and every open one when none is", async () => {
  let round = 0;
  const { run } = fake({
    list_work_items: (args) => {
      if (!args.assignee_usernames) round += 1;
      return { work_items: args.assignee_usernames ? [] : [{ id: `w${round}`, iid: "3", reference: "acme/api#3", title: "Open one", state: "OPEN", updatedAt: "2026-11-27T10:00:00Z" }] };
    },
  });
  const issues = await loadIssues(run, CORE);
  assert.equal(issues.scope, "all");
  assert.deepEqual(issues.rows.map((r) => r.title), ["Open one", "Open one"], "once per container, both kept");
  const mine = fake({ list_work_items: { work_items: [{ id: "w1", iid: "4", reference: "acme/api#4", title: "Mine", state: "OPEN" }] } });
  assert.equal((await loadIssues(mine.run, CORE)).scope, "mine");
});

test("a detail asks for what it shows", async () => {
  const mr = { projectId: "acme/api", iid: "7" };
  const mrCall = fake({ get_merge_request: { title: "Add", commits: { nodes: [] }, notes: { nodes: [] }, pipelines: { nodes: [] } } });
  await loadMrDetail(mrCall.run, mr);
  assert.deepEqual(mrCall.calls[0][1], { project_id: "acme/api", merge_request_iid: 7, include: ["commits", "notes", "pipelines", "approvals"], commits_first: LIMITS.commits, notes_last: LIMITS.notes, pipelines_first: 5 });
  const p = { project: "acme/api", id: 9 };
  const pCall = fake({ get_pipeline: { jobs: [] } });
  await loadPipelineDetail(pCall.run, p);
  assert.deepEqual(pCall.calls[0], ["get_pipeline", { id: "acme/api", pipeline_id: 9, include: ["jobs"], first: LIMITS.jobs }]);
  const w = { projectId: "acme/api", iid: "3" };
  const wCall = fake({ get_work_item: { title: "Fix" } });
  await loadWorkDetail(wCall.run, w);
  assert.deepEqual(wCall.calls[0], ["get_work_item", { project_id: "acme/api", work_item_iid: 3 }]);
});

test("a read that fails says why instead of showing nothing", async () => {
  const failing = async () => {
    throw new Error("GitLab is not signed in");
  };
  await assert.rejects(loadMergeRequests(failing, CORE), /not signed in/);
  await assert.rejects(loadPipelines(failing, CORE), /not signed in/);
  const issues = async () => {
    throw new Error("no");
  };
  await assert.rejects(loadIssues(issues, CORE), /no/);
});
