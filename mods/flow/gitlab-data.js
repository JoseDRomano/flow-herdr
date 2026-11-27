// GitLab's own data for the GitLab screen: the calls it makes to GitLab's MCP server through cockpit's connector, and the
// rows it makes of each answer. `run(tool, args)` is the caller's call to the server; nothing here has side effects.

import { SERVER_KEY } from "./gitlab.js";

/** How much of GitLab a page reads: one page of each list, and the containers it asks them of. */
export const LIMITS = {
  groups: 100,
  projects: 100,
  containers: 8,
  pipelineProjects: 8,
  events: 50,
  mrs: 20,
  issues: 20,
  todos: 20,
  pipelines: 10,
  notes: 8,
  commits: 6,
  jobs: 12,
  projectsOn: 12,
};

/** The screen's tabs, in order, with the key that shows each. */
export const TABS = [
  { id: "activity", label: "Activity", icon: "activity", key: "1" },
  { id: "mrs", label: "Merge requests", icon: "git-merge", key: "2" },
  { id: "pipelines", label: "Pipelines", icon: "git-branch", key: "3" },
  { id: "issues", label: "Issues", icon: "circle-dot", key: "4" },
  { id: "projects", label: "Projects", icon: "folder", key: "5" },
];

/** cockpit's command line that calls one tool of GitLab's MCP server. */
export const callArgs = (tool, args = {}) => ["connector", "call", SERVER_KEY, tool, JSON.stringify(args)];

/** GitLab's brand orange, for its tanuki wherever the screen names it. */
export const GITLAB_ORANGE = "#FC6D26";

/** An answer as an object; `{}` for an empty one, and a thrown reason for one that is not JSON. */
export function parseAnswer(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return {};
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new Error("GitLab's answer was not JSON");
  }
  return answer && typeof answer === "object" ? answer : {};
}

/** The list in an answer, whichever key the tool puts it under; empty when it has none. */
export function itemsOf(answer) {
  if (Array.isArray(answer)) return answer;
  for (const key of ["nodes", "items", "work_items", "todo_items", "jobs"]) if (Array.isArray(answer?.[key])) return answer[key];
  return [];
}

/** Whether the answer has more after it. */
export const hasNext = (answer) => Boolean(answer?.pageInfo?.hasNextPage ?? answer?.page_info?.has_next_page);

/** A pipeline's status in words, an icon and a colour: the lower-cased status both APIs use. */
const PIPELINE = {
  success: ["Passed", "circle-check", "success"],
  failed: ["Failed", "circle-x", "destructive"],
  running: ["Running", "loader", "info"],
  pending: ["Pending", "clock", "warning"],
  created: ["Created", "clock", "warning"],
  preparing: ["Preparing", "loader", "info"],
  waiting_for_resource: ["Waiting", "hourglass", "warning"],
  waiting_for_callback: ["Waiting", "hourglass", "warning"],
  scheduled: ["Scheduled", "clock", "warning"],
  manual: ["Manual", "hand", "warning"],
  canceling: ["Canceling", "circle-stop", "warning"],
  canceled: ["Canceled", "circle-stop", "mutedFg"],
  skipped: ["Skipped", "skip-forward", "mutedFg"],
};

/** A status as `{ key, label, icon, tone }`; an unknown one is shown as it came. */
export function pipelineState(status) {
  const key = String(status ?? "").toLowerCase();
  const [label, icon, tone] = PIPELINE[key] ?? [status ? String(status) : "Unknown", "circle-help", "mutedFg"];
  return { key, label, icon, tone };
}

/** Whether a pipeline is over, for the header's count of what is still running. */
export const pipelineOpen = (status) => ["created", "preparing", "pending", "running", "scheduled", "waiting_for_resource", "waiting_for_callback", "manual"].includes(String(status ?? "").toLowerCase());

/** How long ago an ISO date was, short: "now", "12m", "3h", "2d", "3w". */
export function agoText(iso, now = Date.now()) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 7) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (86_400 * 7))}w`;
}

/** An ISO date as the day and time a detail pane shows. */
export function whenText(iso) {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

const short = (sha) => String(sha ?? "").slice(0, 8);
const lower = (s) => String(s ?? "").toLowerCase();
const text = (s) => String(s ?? "").trim();

/** What kind of event a contribution is, for its icon: push, merge, issue, note, milestone, project, member or activity. */
export function eventKind(event) {
  if (event?.push_data) return "push";
  switch (event?.target_type) {
    case "MergeRequest": return "merge";
    case "Issue":
    case "WorkItem": return "issue";
    case "Note": return "note";
    case "Milestone": return "milestone";
    case "Project": return "project";
    default: return "activity";
  }
}

/** The page an event happened on: its target's, the pushed commit's, else the project's own. */
export function eventUrl(event, project) {
  const base = project?.webUrl ?? project?.web_url ?? null;
  if (!base) return null;
  const iid = event?.target_iid;
  if (event?.target_type === "MergeRequest" && iid) return `${base}/-/merge_requests/${iid}`;
  if (event?.target_type === "Issue" && iid) return `${base}/-/issues/${iid}`;
  if (event?.target_type === "WorkItem" && iid) return `${base}/-/work_items/${iid}`;
  if (event?.target_type === "Milestone" && iid) return `${base}/-/milestones/${iid}`;
  if (event?.push_data?.commit_to) return `${base}/-/commit/${event.push_data.commit_to}`;
  return base;
}

/** One contribution event as a row; `project` is the project the event names, once it is known. */
export function eventRow(event, project = null) {
  const push = event?.push_data ?? null;
  const projectName = project?.fullPath ?? project?.path_with_namespace ?? (event?.target_type === "Project" ? text(event?.target_title) : "");
  return {
    key: `event:${event?.id ?? `${event?.created_at}-${event?.action_name}`}`,
    kind: eventKind(event),
    action: text(event?.action_name) || "did something",
    title: text(push?.commit_title) || text(event?.target_title) || "(event)",
    subject: push ? text(event?.target_title) : "",
    project: projectName,
    ref: push?.ref ? `${push.ref_type ?? "branch"} ${push.ref}` : "",
    at: event?.created_at ?? null,
    url: eventUrl(event, project),
    event,
  };
}

/** A merge request as a row. */
export function mrRow(node) {
  const project = node?.project?.fullPath ?? node?.project?.path_with_namespace ?? node?.project?.name ?? "";
  return {
    key: `mr:${node?.id ?? `${project}!${node?.iid}`}`,
    iid: String(node?.iid ?? ""),
    title: text(node?.title) || "(merge request)",
    project,
    projectId: project,
    branch: text(node?.sourceBranch ?? node?.source_branch),
    base: text(node?.targetBranch ?? node?.target_branch),
    author: text(node?.author?.username ?? node?.author?.name),
    state: lower(node?.state) || "opened",
    draft: Boolean(node?.draft ?? node?.workInProgress),
    url: node?.webUrl ?? node?.web_url ?? null,
  };
}

/** A pipeline as a row. */
export function pipelineRow(item, project) {
  return {
    key: `pipeline:${project}:${item?.id}`,
    id: item?.id ?? null,
    project,
    ref: text(item?.ref) || "(no ref)",
    sha: text(item?.sha),
    status: lower(item?.status),
    source: text(item?.source),
    name: text(item?.name),
    createdAt: item?.created_at ?? item?.createdAt ?? null,
    updatedAt: item?.updated_at ?? item?.updatedAt ?? null,
    url: item?.web_url ?? item?.webUrl ?? null,
    pipeline: item,
  };
}

/** A work item (issue, task, incident…) as a row. */
export function workRow(item) {
  const reference = text(item?.reference);
  const project = reference.includes("#") ? reference.slice(0, reference.indexOf("#")) : "";
  return {
    key: `issue:${item?.id ?? item?.webUrl ?? reference}`,
    iid: String(item?.iid ?? reference.split("#").pop() ?? ""),
    reference,
    project,
    projectId: project,
    title: text(item?.title) || "(work item)",
    type: text(item?.workItemType?.name) || "Work item",
    state: lower(item?.state) || "open",
    createdAt: item?.createdAt ?? item?.created_at ?? null,
    updatedAt: item?.updatedAt ?? item?.updated_at ?? null,
    url: item?.webUrl ?? item?.web_url ?? null,
  };
}

/** A to-do as a row. */
export function todoRow(item) {
  const target = item?.target ?? null;
  const project = target?.project?.path_with_namespace ?? target?.project?.fullPath ?? item?.project?.path_with_namespace ?? item?.project?.fullPath ?? "";
  return {
    key: `todo:${item?.id ?? `${project}-${item?.action_name}`}`,
    action: text(item?.action_name ?? item?.actionName) || "To-do",
    title: text(target?.title ?? item?.body ?? item?.target_title) || "(to-do)",
    type: text(target?.target_type ?? item?.target_type ?? item?.targetType),
    project,
    at: item?.created_at ?? item?.createdAt ?? null,
    url: item?.target_url ?? item?.targetUrl ?? target?.web_url ?? target?.webUrl ?? null,
  };
}

/** A project as a row, with the group it belongs to among `groups` (full paths). */
export function projectRow(project, groups = []) {
  const path = text(project?.fullPath ?? project?.path_with_namespace);
  return {
    key: `project:${path || project?.id}`,
    id: project?.id ?? null,
    name: text(project?.name) || path,
    path,
    group: groupOf(path, groups),
    visibility: text(project?.visibility),
    archived: Boolean(project?.archived),
    url: project?.webUrl ?? project?.web_url ?? null,
  };
}

/** The deepest group in `groups` (full paths) that holds `path`, or "". */
export function groupOf(path, groups = []) {
  return groups.filter((g) => path === g || path.startsWith(`${g}/`)).sort((a, b) => b.length - a.length)[0] ?? "";
}

/**
 * The containers (groups, and projects outside any group) the merge requests and issues are read from; a chosen
 * project is the only one.
 */
export function containersOf(core = {}, project = null) {
  if (project) return [{ id: project, group: false, label: project }];
  const groups = (core.groups ?? []).map((g) => ({ id: g.fullPath ?? g, group: true, label: g.fullPath ?? g }));
  const covered = (path) => groups.some((g) => path === g.id || path.startsWith(`${g.id}/`));
  const own = (core.projects ?? [])
    .filter((p) => !p.archived && p.fullPath && !covered(p.fullPath))
    .map((p) => ({ id: p.fullPath, group: false, label: p.fullPath }));
  return [...groups, ...own].slice(0, LIMITS.containers);
}

/** The projects a pipeline list is read from: a chosen project, otherwise those with a merge request, then the person's. */
export function pipelineProjects(core = {}, projects = [], project = null) {
  if (project) return [project];
  const out = [];
  const seen = new Set();
  const add = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const path of projects ?? []) add(path);
  for (const p of core.projects ?? []) if (!p.archived) add(p.fullPath);
  return out.slice(0, LIMITS.pipelineProjects);
}

/** The newest pipeline of a merge request's branch, among pipelines rows: null when none ran for it. */
export function pipelineFor(mr, pipelines = []) {
  const same = pipelines.filter((p) => p.project === mr.project && p.ref === mr.branch);
  const at = (p) => Date.parse(p.updatedAt ?? p.createdAt ?? "") || 0;
  return same.sort((a, b) => at(b) - at(a))[0] ?? null;
}

/** The failed pipelines in a list. */
export const failedPipelines = (rows = []) => rows.filter((p) => p.status === "failed");

/** The projects named by merge request rows, each once, in their order. */
export function mrProjects(rows = []) {
  const out = [];
  for (const row of rows) if (row.project && !out.includes(row.project)) out.push(row.project);
  return out;
}

/** Whether a row belongs to `project`; with no project chosen, every row does. */
export const inProject = (row, project) => !project || row?.project === project;

/** Rows whose title, project, ref or action contains every word of `filter` (case apart). */
export function filterRows(rows = [], filter = "") {
  const words = lower(filter).split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const hay = lower([row.title, row.project, row.ref, row.action, row.reference, row.path, row.branch, row.type, row.name].filter(Boolean).join(" "));
    return words.every((w) => hay.includes(w));
  });
}

/** A merge request's detail from `get_merge_request`: its state, approvals, commits, notes and pipelines. */
export function mrDetail(answer = {}) {
  const origin = /^(https?:\/\/[^/]+)/.exec(answer.webUrl ?? answer.web_url ?? "")?.[1] ?? "";
  return {
    kind: "mr",
    state: lower(answer.state) || "opened",
    draft: Boolean(answer.draft),
    title: text(answer.title),
    description: text(answer.description),
    createdAt: answer.createdAt ?? null,
    updatedAt: answer.updatedAt ?? null,
    mergedAt: answer.mergedAt ?? null,
    approved: Boolean(answer.approved),
    approvedBy: (answer.approvedBy?.nodes ?? []).map((u) => text(u?.name ?? u?.username)).filter(Boolean),
    commits: (answer.commits?.nodes ?? []).map((c) => ({ sha: text(c.shortId) || short(c.sha), title: text(c.title), author: text(c.authorName), at: c.authoredDate ?? null, url: c.webUrl ?? null })),
    notes: (answer.notes?.nodes ?? []).filter((n) => !n.system).map((n) => ({ id: n.id, author: text(n.author?.name ?? n.author?.username), body: plainText(n.body).slice(0, 1200), at: n.createdAt ?? null, url: n.webUrl ?? null })),
    pipelines: (answer.pipelines?.nodes ?? []).map((p) => ({ status: lower(p.status), ref: text(p.ref), sha: text(p.shortId) || short(p.sha), at: p.createdAt ?? null, url: p.path && origin ? `${origin}${p.path}` : null })),
  };
}

/** A pipeline's detail from `get_pipeline` with its jobs. */
export function pipelineDetail(answer = {}) {
  return {
    kind: "pipeline",
    status: lower(answer.status),
    ref: text(answer.ref),
    sha: text(answer.sha),
    source: text(answer.source),
    jobs: (answer.jobs ?? []).map((j) => ({ id: j.id, name: text(j.name), stage: text(j.stage), status: lower(j.status), url: j.web_url ?? j.webUrl ?? null })),
  };
}

/** A work item's detail from `get_work_item`. */
export function workDetail(answer = {}) {
  return {
    kind: "issue",
    title: text(answer.title),
    state: lower(answer.state),
    type: text(answer.workItemType?.name) || "Work item",
    description: text(answer.description),
    namespace: text(answer.namespace?.fullPath ?? answer.namespace?.name),
    createdAt: answer.createdAt ?? null,
    updatedAt: answer.updatedAt ?? null,
    confidential: Boolean(answer.confidential),
  };
}

/** An answer's text without GitLab's HTML: its tags out, its common entities back. */
export function plainText(html) {
  return String(html ?? "")
    .replace(/<\s*(?:br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// The reads

/** Who the person is on GitLab, their groups and their projects: what every tab narrows by. */
export async function loadCore(run) {
  const [me, groups, projects] = await Promise.all([
    run("get_user", { me: true }),
    run("list_groups", { first: LIMITS.groups }),
    run("list_projects", { first: LIMITS.projects }),
  ]);
  const username = text(me?.username);
  if (!username) throw new Error("GitLab did not say who you are: sign in again from Flow settings → Data");
  return {
    me,
    username,
    groups: itemsOf(groups).map((g) => ({ fullPath: text(g.fullPath ?? g.full_path), name: text(g.name) })).filter((g) => g.fullPath),
    projects: itemsOf(projects)
      .map((p) => ({ id: p.id ?? null, fullPath: text(p.fullPath ?? p.path_with_namespace), name: text(p.name), archived: Boolean(p.archived), webUrl: p.webUrl ?? p.web_url ?? null, visibility: text(p.visibility) }))
      .filter((p) => p.fullPath),
  };
}

/** The person's contribution events, their project pages resolved where the event only names a number, and their to-dos; a chosen project keeps only its own. */
export async function loadActivity(run, core, project = null) {
  const [eventsAnswer, todosAnswer] = await Promise.all([
    run("list_user_events", { id: core.username, per_page: LIMITS.events }),
    run("list_todos", { state: "pending", first: LIMITS.todos }).catch(() => ({})),
  ]);
  const events = itemsOf(eventsAnswer);
  const known = new Map((core.projects ?? []).map((p) => [p.id, p]));
  const need = [...new Set(events.map((e) => e.project_id).filter((id) => id !== undefined && id !== null && !known.has(id)))].slice(0, LIMITS.projectsOn);
  const resolved = await Promise.all(need.map((id) => run("get_project", { project_id: id }).catch(() => null)));
  for (const p of resolved) if (p) known.set(p.id ?? p.project_id, { id: p.id, fullPath: text(p.fullPath ?? p.path_with_namespace), name: text(p.name), webUrl: p.webUrl ?? p.web_url ?? null });
  return {
    rows: events.map((e) => eventRow(e, known.get(e.project_id) ?? null)).filter((row) => inProject(row, project)),
    todos: itemsOf(todosAnswer).map(todoRow).filter((row) => inProject(row, project)),
    projects: need.length > 0 ? need.length : 0,
  };
}

/** The person's open merge requests, the ones waiting on their review, and the ones of theirs already merged, from `project` when one is chosen. */
export async function loadMergeRequests(run, core, project = null) {
  const containers = containersOf(core, project);
  const calls = [];
  for (const container of containers) {
    for (const [scope, args] of [
      ["yours", { author_username: core.username, state: "opened" }],
      ["review", { reviewer_username: core.username, state: "opened" }],
      ["merged", { author_username: core.username, state: "merged", first: 10 }],
    ]) calls.push({ container, scope, args });
  }
  const answers = await Promise.allSettled(
    calls.map(({ container, args }) => run("list_merge_requests", { ...(container.group ? { group_id: container.id } : { project_id: container.id }), first: LIMITS.mrs, ...args })),
  );
  const rows = [];
  const seen = new Set();
  const errors = [];
  answers.forEach((answer, i) => {
    if (answer.status === "rejected") return errors.push(answer.reason);
    for (const node of itemsOf(answer.value)) {
      const row = { ...mrRow(node), scope: calls[i].scope };
      if (!inProject(row, project) || seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
    }
  });
  if (!rows.length && errors.length && errors.length === answers.length) throw errors[0];
  return { rows, containers: containers.map((c) => c.label), failed: errors.length };
}

/** Pipelines for a chosen project, else the merge requests' projects and then the person's own, newest first per project. */
export async function loadPipelines(run, core, projects = [], project = null) {
  const paths = pipelineProjects(core, projects, project);
  const answers = await Promise.allSettled(
    paths.map((path) => run("list_pipelines", { id: path, per_page: LIMITS.pipelines, order_by: "updated_at", sort: "desc" })),
  );
  const rows = [];
  const errors = [];
  answers.forEach((answer, i) => {
    if (answer.status === "rejected") return errors.push(answer.reason);
    for (const item of itemsOf(answer.value)) {
      const row = pipelineRow(item, paths[i]);
      if (inProject(row, project)) rows.push(row);
    }
  });
  if (!rows.length && errors.length && errors.length === answers.length) throw errors[0];
  return { rows, projects: paths, failed: errors.length };
}

/** Work items across the containers, the ones assigned to the person (else every open one), newest first; a chosen project is the only container. */
export async function loadIssues(run, core, project = null) {
  const containers = containersOf(core, project);
  const read = async (extra) => {
    const answers = await Promise.allSettled(
      containers.map((container) =>
        run("list_work_items", {
          ...(container.group ? { group_id: container.id } : { project_id: container.id }),
          state: "opened",
          sort: "UPDATED_DESC",
          first: LIMITS.issues,
          ...extra,
        }),
      ),
    );
    const rows = [];
    const errors = [];
    answers.forEach((answer) => {
      if (answer.status === "rejected") return errors.push(answer.reason);
      for (const item of itemsOf(answer.value)) {
        const row = workRow(item);
        if (inProject(row, project)) rows.push(row);
      }
    });
    return { rows, errors };
  };
  let mine = await read({ assignee_usernames: [core.username] });
  let scope = "mine";
  if (!mine.rows.length) {
    mine = await read({});
    scope = "all";
  }
  const rows = [];
  const seen = new Set();
  for (const row of mine.rows.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0))) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  if (!rows.length && mine.errors.length && mine.errors.length === containers.length) throw mine.errors[0];
  return { rows, scope, failed: mine.errors.length };
}

/** One merge request's detail, its notes newest last. */
export async function loadMrDetail(run, mr) {
  const answer = await run("get_merge_request", {
    project_id: mr.projectId,
    merge_request_iid: Number(mr.iid),
    include: ["commits", "notes", "pipelines", "approvals"],
    commits_first: LIMITS.commits,
    notes_last: LIMITS.notes,
    pipelines_first: 5,
  });
  return mrDetail(answer);
}

/** One pipeline's detail with its jobs. */
export async function loadPipelineDetail(run, pipeline) {
  const answer = await run("get_pipeline", { id: pipeline.project, pipeline_id: pipeline.id, include: ["jobs"], first: LIMITS.jobs });
  return pipelineDetail(answer);
}

/** One work item's detail. */
export async function loadWorkDetail(run, issue) {
  const answer = await run("get_work_item", { project_id: issue.projectId, work_item_iid: Number(issue.iid) });
  return workDetail(answer);
}
