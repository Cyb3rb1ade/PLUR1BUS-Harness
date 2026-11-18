// Parity vectors (modes V and B) for the collaboration store and its rules (P4-K K6a, plan P4-50): the real `CollabStore` of
// `packages/core/src/collab/store.ts` (with its `ProjectBoardStore`) runs scripted scenarios over a temporary `collab.sqlite`
// with a scripted clock (every read returns the current value and then adds `step`) and scripted ids (`<prefix>_<n>`, one counter per prefix), and
// every op's answer is recorded as `{ ok }` or `{ err }` (`CollabError`: code, reason, guardrail, message; `BoardError`:
// `board` and message; anything else: `raw`). `crates/plur1bus-core/src/collab/vectors.rs` replays every scenario over its own
// file and must give the same answers, the same stored bytes (raw `sql` ops) and the same schema text.
//
// The pure rules (limits, guardrails, capacity, the repeat key, the work budget) are recorded case by case. Where the order
// of members matters (a project's stored settings, an actor, an assignee, a link) the input is stored as JSON *text*
// (`settingsJson`, `actorJson`, ...), because the fixture writer sorts object keys.
//
// A scenario is `{ name, step, ops }`; `on: "b"` runs an op on a second store over the same file (two connections, one
// writer at a time). `afterLast: true` takes the cursor of the previous page.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-collab.ts [--check]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { exporterMain } from "./lib.mjs";
import { CollabStore } from "../../packages/core/src/collab/store.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../packages/core/src/collab/migrations.ts";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import { BoardError } from "../../packages/core/src/collab/board.ts";
import { DEFAULT_COLLAB_LIMITS, delegationWorkBudget, legacyCollabSettings, resolveCollabLimits } from "../../packages/core/src/collab/limits.ts";
import { DEFAULT_COLLAB_SETTINGS } from "../../packages/core/src/collab/defaults.ts";
import { evaluateGuardrails } from "../../packages/core/src/collab/guardrails.ts";
import { writerCapacity } from "../../packages/core/src/collab/capacity.ts";
import { pairKey, repeatKey, traceparent } from "../../packages/core/src/collab/ids.ts";

type Op = Record<string, any>;
const errOf = (e: unknown) => e instanceof CollabError
  ? { code: e.code, ...(e.reason !== undefined ? { reason: e.reason } : {}), ...(e.guardrail !== undefined ? { guardrail: e.guardrail } : {}), message: e.message }
  : e instanceof BoardError ? { board: e.code, message: e.message } : { raw: true };
const parse = (text: string | undefined) => (text === undefined ? undefined : JSON.parse(text));
const wire = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** One scenario over a fresh file. */
function run(name: string, ops: Op[], { start = 1_000_000, step = 1, config }: { start?: number; step?: number; config?: any } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-collab-"));
  const path = join(dir, "collab.sqlite");
  let now = start;
  const counters = new Map<string, number>();
  const ended: string[] = [];
  let grantMode: "ok" | "throw" = "ok";
  const warned: string[] = [];
  const open = () => new CollabStore({
    path, clock: () => { const v = now; now += step; return v; }, newId: (p) => { const c = (counters.get(p) ?? 0) + 1; counters.set(p, c); return `${p}_${c}`; },
    ...(config ? { limits: () => config } : {}),
    grants: { endTask(id: string) { ended.push(id); if (grantMode === "throw") throw new Error("grant store down"); } },
    logWarn: (m: string) => { warned.push(m); },
  });
  let a = open();
  let b: CollabStore | null = null;
  let raw: DatabaseSync | null = null;
  const rawDb = () => (raw ??= new DatabaseSync(path));
  let cursor: string | null = null;
  const steps: unknown[] = [];
  try {
    for (const op of ops) {
      let out: unknown;
      try {
        const s: CollabStore = op.on === "b" ? (b ??= open()) : a;
        const actor = parse(op.actorJson), assignee = parse(op.assigneeJson);
        switch (op.op) {
          case "setClock": now = op.to; out = { ok: null }; break;
          case "reopen": a.close(); a = open(); out = { ok: null }; break;
          case "grants": grantMode = op.mode; out = { ok: null }; break;
          case "ended": out = { ok: [...ended] }; break;
          case "warned": out = { ok: [...warned] }; break;
          case "sql": out = { ok: rawDb().prepare(op.sql).all(...(op.args ?? [])).map((r) => Object.values(r as object)) }; break;
          case "exec": rawDb().prepare(op.sql).run(...(op.args ?? [])); out = { ok: null }; break;
          case "createProject": out = { ok: wire(s.createProject({ name: op.name, owner: op.owner, ...(op.settingsJson !== undefined ? { settings: parse(op.settingsJson) } : {}), ...(op.id !== undefined ? { id: op.id } : {}) })) }; break;
          case "updateProject": out = { ok: wire(s.updateProject(op.id, op.name)) }; break;
          case "getProject": out = { ok: wire(s.getProject(op.id)) }; break;
          case "limits": out = { ok: wire(s.limits(op.id)) }; break;
          case "setSettings": out = { ok: wire(s.setSettings(op.id, parse(op.changesJson))) }; break;
          case "listProjects": out = { ok: wire(s.listProjects()) }; break;
          case "archive": out = { ok: wire(s.archiveProject(op.id)) }; break;
          case "addMember": out = { ok: wire(s.addMember(op.id, op.user, op.role)) }; break;
          case "removeMember": out = { ok: wire(s.removeMember(op.id, op.user)) }; break;
          case "addAgent": out = { ok: wire(s.addAgent(op.id, op.agent)) }; break;
          case "removeAgent": out = { ok: wire(s.removeAgent(op.id, op.agent)) }; break;
          case "setRepo": out = { ok: wire(s.setRepo(op.id, op.repo)) }; break;
          case "clearRepo": out = { ok: wire(s.clearRepo(op.id)) }; break;
          case "insertWorktree": out = { ok: wire(s.insertWorktree(op.input)) }; break;
          case "liveWorktree": out = { ok: wire(s.liveWorktree(op.project, op.card ?? null)) }; break;
          case "previousWorktree": out = { ok: wire(s.previousWorktree(op.project, op.card ?? null)) }; break;
          case "worktreeAt": out = { ok: wire(s.worktreeAt(op.path)) }; break;
          case "markRemoved": s.markWorktreeRemoved(op.project, op.card ?? null); out = { ok: null }; break;
          case "putArtifact": out = { ok: wire(s.putArtifact(op.project, op.body, op.contentType)) }; break;
          case "getArtifact": out = { ok: wire(s.getArtifact(op.id)) }; break;
          case "lastRepeat": out = { ok: wire(s.lastRepeat(op.key)) }; break;
          case "rememberRepeat": s.rememberRepeat(op.key, op.at); out = { ok: null }; break;
          case "insertTrace": s.insertTrace(op.input); out = { ok: null }; break;
          case "insertSpan": s.insertSpan(op.input); out = { ok: null }; break;
          case "bindSession": s.bindSession(op.span, op.session); out = { ok: null }; break;
          case "finishSpan": s.finishSpan(op.span, op.patch); out = { ok: null }; break;
          case "finishTrace": s.finishTrace(op.trace, op.status); out = { ok: null }; break;
          case "getTrace": out = { ok: wire(s.getTrace(op.trace)) }; break;
          case "listTraces": out = { ok: wire(s.listTraces(op.project)) }; break;
          case "insertTask": out = { ok: wire(s.insertTask(op.input)) }; break;
          case "updateTask": out = { ok: wire(s.updateTask(op.id, op.patch)) }; break;
          case "getTask": out = { ok: wire(s.getTask(op.id)) }; break;
          case "listTasks": out = { ok: wire(s.listTasks(op.trace)) }; break;
          case "cancelOpen": out = { ok: wire(s.cancelOpenTasks(op.trace)) }; break;
          case "bColumns": out = { ok: wire(s.board.columns(op.project)) }; break;
          case "bCreateColumn": out = { ok: wire(s.board.createColumn(op.project, op.input)) }; break;
          case "bUpdateColumn": out = { ok: wire(s.board.updateColumn(op.project, op.id, op.patch)) }; break;
          case "bMoveColumn": out = { ok: wire(s.board.moveColumn(op.project, op.id, op.position)) }; break;
          case "bDeleteColumn": out = { ok: wire(s.board.deleteColumn(op.project, op.id, op.target, actor, op.override)) }; break;
          case "bGetCard": out = { ok: wire(s.board.getCard(op.project, op.id)) }; break;
          case "bCards": {
            const filter = { ...(op.filter ?? {}), ...(op.assigneeJson !== undefined ? { assignee: assignee } : {}) };
            if (op.afterLast) filter.cursor = cursor ?? undefined;
            const r = s.board.cards(op.project, filter); cursor = r.nextCursor; out = { ok: wire(r) }; break;
          }
          case "bCreateCard": out = { ok: wire(s.board.createCard(op.project, op.input, actor, op.override)) }; break;
          case "bUpdateCard": out = { ok: wire(s.board.updateCard(op.project, op.id, op.patch, actor)) }; break;
          case "bMoveCard": out = { ok: wire(s.board.moveCard(op.project, op.id, op.column, op.position, actor, op.override)) }; break;
          case "bAssign": out = { ok: wire(s.board.assign(op.project, op.id, assignee, op.add, actor)) }; break;
          case "bArchive": out = { ok: wire(s.board.archiveCard(op.project, op.id, op.archived, actor, op.override)) }; break;
          case "bComment": out = { ok: wire(s.board.comment(op.project, op.id, op.text, actor)) }; break;
          case "bComments": { const r = s.board.comments(op.project, op.id, { ...(op.input ?? {}), ...(op.afterLast ? { cursor: cursor ?? undefined } : {}) }); cursor = r.nextCursor; out = { ok: wire(r) }; break; }
          case "bActivity": { const r = s.board.activity(op.project, op.id, { ...(op.input ?? {}), ...(op.afterLast ? { cursor: cursor ?? undefined } : {}) }); cursor = r.nextCursor; out = { ok: wire(r) }; break; }
          case "bBadCursor": { const r = s.board.cards(op.project, { cursor: op.cursor, ...(op.filter ?? {}) }); out = { ok: wire(r) }; break; }
          default: throw new Error(`unknown op ${op.op}`);
        }
      } catch (e) { out = { err: errOf(e) }; }
      // The fixture writer sorts object keys, and the member order of a link is part of the stored bytes: keep it as text.
      const recorded = structuredClone(op);
      for (const k of ["input", "patch"]) if (recorded[k]?.links) { recorded[k].linksJson = JSON.stringify(op[k].links); delete recorded[k].links; }
      steps.push({ op: recorded, out });
    }
  } finally { a.close(); b?.close(); raw?.close(); }
  return { name, step, ...(config ? { config } : {}), ops: steps };
}

// ---- scenarios -------------------------------------------------------------------------------------------------------

const actorP = JSON.stringify({ kind: "person", id: "u-owner" });
const actorFlip = JSON.stringify({ id: "u-owner", kind: "person", note: "x" });
const proj = (settingsJson?: string): Op[] => [{ op: "createProject", name: "alpha", owner: "u-owner", ...(settingsJson ? { settingsJson } : {}) }];
const P = "prj_1";

function storeScenarios() {
  const out: unknown[] = [];
  out.push(run("project-lifecycle", [
    ...proj(),
    { op: "getProject", id: P },
    { op: "addMember", id: P, user: "u-mem", role: "member" },
    { op: "addMember", id: P, user: "u-mem", role: "reviewer" },
    { op: "addMember", id: P, user: "u-owner", role: "member" },
    { op: "addMember", id: P, user: "", role: "member" },
    { op: "addMember", id: P, user: "x", role: "admin" },
    { op: "addMember", id: "nope", user: "x", role: "member" },
    { op: "removeMember", id: P, user: "u-owner" },
    { op: "removeMember", id: P, user: "u-mem" },
    { op: "addAgent", id: P, agent: "b" }, { op: "addAgent", id: P, agent: "a" }, { op: "addAgent", id: P, agent: "a" }, { op: "addAgent", id: P, agent: "" },
    { op: "removeAgent", id: P, agent: "b" },
    { op: "updateProject", id: P, name: "  beta  " },
    { op: "updateProject", id: P, name: "   " },
    { op: "updateProject", id: "nope", name: "x" },
    { op: "listProjects" },
    { op: "archive", id: P }, { op: "archive", id: P }, { op: "archive", id: "nope" },
    { op: "addAgent", id: P, agent: "c" }, { op: "removeMember", id: P, user: "u-mem" }, { op: "updateProject", id: P, name: "late" },
    { op: "sql", sql: "SELECT id, name, owner, settings, created_at, updated_at, archived_at FROM projects" },
    { op: "sql", sql: "SELECT project_id, user_id, role, added_at FROM project_members ORDER BY user_id" },
    { op: "sql", sql: "SELECT project_id, agent_id, added_at FROM project_agents ORDER BY agent_id" },
  ]));
  out.push(run("names-and-owners", [
    { op: "createProject", name: "", owner: "u" },
    { op: "createProject", name: "﻿   ", owner: "u" },
    { op: "createProject", name: "x", owner: "" },
    { op: "createProject", name: "a".repeat(257), owner: "u" },
    { op: "createProject", name: "a".repeat(256), owner: "u" },
    { op: "createProject", name: `  ${"b".repeat(256)}  `, owner: "u" },
    { op: "createProject", name: "\u{1F600}".repeat(128), owner: "u" },
    { op: "createProject", name: "\u{1F600}".repeat(129), owner: "u" },
    { op: "createProject", name: "named", owner: "u", id: "fixed-id" },
    { op: "createProject", name: "dup", owner: "u", id: "fixed-id" },
    { op: "updateProject", id: "fixed-id", name: "a".repeat(257) },
    { op: "updateProject", id: "fixed-id", name: "\u{1F600}".repeat(129) },
    { op: "updateProject", id: "fixed-id", name: ` ${"c".repeat(256)} ` },
    { op: "listProjects" },
  ]));
  out.push(run("settings-forms", [
    { op: "createProject", name: "legacy", owner: "u", settingsJson: JSON.stringify({ maxDepth: 1, maxFanout: 3, maxPairPerTurn: 2, maxTurns: 25, timeoutMs: 300000, returnTokens: 2000 }) },
    { op: "getProject", id: "prj_1" },
    { op: "exec", sql: "UPDATE projects SET settings = ? WHERE id = ?", args: ['{"maxDepth":1,"maxFanout":3,"maxPairPerTurn":2,"maxTurns":25,"timeoutMs":300000,"returnTokens":2000,"allowCrossProject":true}', "prj_1"] },
    { op: "getProject", id: "prj_1" }, { op: "limits", id: "prj_1" },
    { op: "addAgent", id: "prj_1", agent: "x" },
    { op: "sql", sql: "SELECT settings FROM projects" },
    { op: "createProject", name: "v2", owner: "u", settingsJson: '{"settingsVersion":2,"maxDepth":1,"maxFanout":3,"tokenBudget":null}' },
    { op: "getProject", id: "prj_2" },
    { op: "setSettings", id: "prj_2", changesJson: '{"maxFanout":5,"repeatWindowMs":0.5,"zzz":1}' },
    { op: "sql", sql: "SELECT settings FROM projects WHERE id = 'prj_2'" },
    { op: "setSettings", id: "prj_2", changesJson: '{"tokenBudget":-1}' }, { op: "limits", id: "prj_2" },
    { op: "setSettings", id: "prj_2", changesJson: '{"tokenBudget":"7","maxDepth":"1","allowCrossProject":"true"}' }, { op: "limits", id: "prj_2" },
    { op: "setSettings", id: "prj_2", changesJson: '{"tokenBudget":12.5,"maxDepth":1.9,"maxFanout":-0,"repeatWindowMs":-1,"returnTokens":99999,"timeoutMs":1000,"maxTurns":3}' }, { op: "limits", id: "prj_2" }, { op: "getProject", id: "prj_2" },
    { op: "createProject", name: "team", owner: "u", settingsJson: '{"collaboration":{"teams":{"enabled":true}},"settingsVersion":3}' },
    { op: "getProject", id: "prj_3" },
    { op: "createProject", name: "falsy", owner: "u", settingsJson: '{"collaboration":0,"settingsVersion":2}' },
    { op: "getProject", id: "prj_4" },
    { op: "setSettings", id: "nope", changesJson: "{}" },
    { op: "archive", id: "prj_2" }, { op: "setSettings", id: "prj_2", changesJson: "{}" },
    { op: "exec", sql: "UPDATE projects SET settings = 'null' WHERE id = ?", args: ["prj_3"] },
    { op: "getProject", id: "prj_3" },
    { op: "exec", sql: "UPDATE projects SET settings = '{bad' WHERE id = ?", args: ["prj_3"] },
    { op: "limits", id: "prj_3" }, { op: "listProjects" },
    { op: "limits", id: "nope" },
  ]));
  out.push(run("limits-from-configuration", [
    ...proj('{"settingsVersion":2,"maxFanout":50,"maxTurns":10,"timeoutMs":60000}'),
    { op: "limits", id: P }, { op: "getProject", id: P },
  ], { config: { readHelpers: { perTurn: 4, depth: 1 }, writers: { perProject: 2 }, consults: { perPairPerTurn: 3 }, workTokens: 1000, taskClasses: { consult: { rounds: 5, wallTimeMs: 90000, stallTimeMs: 100000 }, research: { rounds: 6, wallTimeMs: 1000, stallTimeMs: 500 }, review: { rounds: 7, wallTimeMs: 2000, stallTimeMs: 3000 }, "code-small": { rounds: 8, wallTimeMs: 3000, stallTimeMs: 4000 }, "code-large": { rounds: 9, wallTimeMs: 4000, stallTimeMs: 1 } } } }));
  out.push(run("repo-and-worktrees", [
    ...proj(),
    { op: "setRepo", id: P, repo: { repoPath: "/r", baseBranch: "main" } },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: null, branch: "b1", path: "/w/1", baseSha: "abc" } },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: null, branch: "b2", path: "/w/2", baseSha: "abc" } },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: "c1", branch: "b3", path: "/w/3", baseSha: "def", gitDir: "/g", commonGitDir: "/cg", dev: "1", ino: "2" } },
    { op: "liveWorktree", project: P }, { op: "liveWorktree", project: P, card: "c1" }, { op: "liveWorktree", project: P, card: "" }, { op: "liveWorktree", project: P, card: "zz" },
    { op: "worktreeAt", path: "/w/3" }, { op: "worktreeAt", path: "/w/nope" },
    { op: "setRepo", id: P, repo: { repoPath: "/r2", baseBranch: "dev" } },
    { op: "clearRepo", id: P },
    { op: "markRemoved", project: P, card: "c1" },
    { op: "previousWorktree", project: P, card: "c1" }, { op: "previousWorktree", project: P }, { op: "previousWorktree", project: P, card: "" },
    { op: "worktreeAt", path: "/w/3" },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: "c1", branch: "b4", path: "/w/4", baseSha: "x" } },
    { op: "previousWorktree", project: P, card: "c1" },
    { op: "markRemoved", project: P, card: "" },
    { op: "liveWorktree", project: P },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: "", branch: "b5", path: "/w/5", baseSha: "x" } },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: "", branch: "b6", path: "/w/6", baseSha: "x" } },
    { op: "markRemoved", project: P },
    { op: "clearRepo", id: P }, { op: "getProject", id: P },
    { op: "markRemoved", project: P, card: "c1" },
    { op: "clearRepo", id: P }, { op: "getProject", id: P },
    { op: "setRepo", id: "nope", repo: { repoPath: "/r", baseBranch: "main" } },
    { op: "sql", sql: "SELECT id, project_id, root_id, card_id, branch, path, base_sha, created_at, removed_at, git_dir, common_git_dir, device, inode FROM project_worktrees ORDER BY id" },
  ]));
  out.push(run("artifacts-and-repeats", [
    { op: "putArtifact", project: "p", body: "full body \u{1F600}" }, { op: "putArtifact", project: "p", body: "x", contentType: "application/json" },
    { op: "getArtifact", id: "art_1" }, { op: "getArtifact", id: "art_2" }, { op: "getArtifact", id: "nope" },
    { op: "lastRepeat", key: "k" }, { op: "rememberRepeat", key: "k", at: 5 }, { op: "lastRepeat", key: "k" }, { op: "rememberRepeat", key: "k", at: 9 }, { op: "lastRepeat", key: "k" },
  ], { step: 7 }));
  const span = (id: string, trace: string, parent: string | null, agent: string, kind: string) => ({ op: "insertSpan", input: { spanId: id, traceId: trace, parentSpanId: parent, agentId: agent, kind, inputPreview: `in ${id}` } });
  out.push(run("traces-spans-tasks", [
    ...proj(),
    { op: "insertTrace", input: { traceId: "t1", projectId: P, rootAgent: "lead", rootSpanId: "s1" } },
    { op: "insertTrace", input: { traceId: "t1", projectId: P, rootAgent: "lead", rootSpanId: "s1" } },
    { op: "insertTrace", input: { traceId: "t2", projectId: "nope", rootAgent: "lead", rootSpanId: "s9" } },
    span("s1", "t1", null, "worker", "consult"), span("s2", "t1", "s1", "spec", "delegate"), span("s3", "t1", "s1", "spec", "guardrail"), span("s4", "t1", null, "x", "bogus"), span("s5", "zz", null, "x", "consult"),
    { op: "bindSession", span: "s2", session: "ses_1" }, { op: "bindSession", span: "s1", session: "" },
    { op: "finishSpan", span: "s1", patch: { status: "succeeded", outputPreview: "out", inputTokens: 3, outputTokens: 4, targetKind: "external" } },
    { op: "finishSpan", span: "s2", patch: { status: "failed", error: "boom", guardrail: "depth", origin: "a2a", targetKind: "a2a" } },
    { op: "finishSpan", span: "s3", patch: { status: "refused" } },
    { op: "getTrace", trace: "t1" }, { op: "getTrace", trace: "nope" },
    { op: "finishTrace", trace: "t1", status: "succeeded" }, { op: "getTrace", trace: "t1" },
    { op: "insertTrace", input: { traceId: "t3", projectId: P, rootAgent: "lead", rootSpanId: "s7", status: "partial" } },
    { op: "listTraces", project: P }, { op: "listTraces", project: "nope" },
    { op: "insertTask", input: { id: "k1", projectId: P, traceId: "t1", spanId: "s1", parentTaskId: null, fromAgent: "lead", toAgent: "worker", kind: "delegate", status: "queued", task: "do", acceptance: "ok", path: ["lead", "worker"] } },
    { op: "insertTask", input: { id: "k2", projectId: P, traceId: "t1", spanId: "s2", parentTaskId: "k1", fromAgent: "worker", toAgent: "spec", kind: "delegate", status: "running", task: "sub", acceptance: "", path: ["lead", "worker", "spec"] } },
    { op: "insertTask", input: { id: "k3", projectId: P, traceId: "t1", spanId: "s2", parentTaskId: null, fromAgent: "a", toAgent: "b", kind: "weird", status: "queued", task: "x", acceptance: "", path: [] } },
    { op: "insertTask", input: { id: "k4", projectId: P, traceId: "t1", spanId: "s2", parentTaskId: null, fromAgent: "a", toAgent: "b", kind: "consult", status: "queued", task: "x\u0000y \u{1F600}", acceptance: "", path: ["é"] } },
    { op: "getTask", id: "k1" }, { op: "getTask", id: "nope" }, { op: "listTasks", trace: "t1" },
    { op: "updateTask", id: "k1", patch: { status: "running" } },
    { op: "updateTask", id: "k1", patch: { status: "succeeded", result: "[truncated 5 chars; artifact:art_1]", truncated: true, artifactId: "art_1", inputTokens: 5, outputTokens: 6, targetKind: "local" } },
    { op: "updateTask", id: "k2", patch: { status: "failed", error: "boom", inputTokens: 1 } },
    { op: "updateTask", id: "k4", patch: { status: "succeeded", artifactId: "", origin: "a2a", targetKind: "" } },
    { op: "updateTask", id: "nope", patch: { status: "failed" } },
    { op: "updateTask", id: "k3", patch: { status: "queued" } },
    { op: "ended" },
    { op: "grants", mode: "throw" }, { op: "updateTask", id: "k3", patch: { status: "cancelled" } }, { op: "warned" },
    { op: "insertTask", input: { id: "k5", projectId: P, traceId: "t1", spanId: "s2", parentTaskId: null, fromAgent: "a", toAgent: "b", kind: "delegate", status: "queued", task: "q", acceptance: "", path: [] } },
    { op: "insertTask", input: { id: "k6", projectId: P, traceId: "t1", spanId: "s2", parentTaskId: null, fromAgent: "a", toAgent: "b", kind: "delegate", status: "running", task: "r", acceptance: "", path: [] } },
    { op: "cancelOpen", trace: "t1" }, { op: "cancelOpen", trace: "t1" }, { op: "cancelOpen", trace: "nope" }, { op: "ended" }, { op: "warned" },
    { op: "listTasks", trace: "t1" },
    { op: "sql", sql: "SELECT id, status, error, started_at, ended_at, truncated, result_artifact_id, target_kind, origin, input_tokens, output_tokens, path FROM tasks ORDER BY id" },
    { op: "sql", sql: "SELECT span_id, status, started_at, ended_at, session_id, guardrail, target_kind, origin FROM spans ORDER BY span_id" },
  ]));
  out.push(run("two-connections", [
    ...proj(),
    { op: "addAgent", id: P, agent: "x", on: "b" }, { op: "getProject", id: P },
    { op: "addMember", id: P, user: "m", role: "member", on: "b" }, { op: "removeMember", id: P, user: "m" },
    { op: "getProject", id: P, on: "b" },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: "c", branch: "b", path: "/p", baseSha: "s" } },
    { op: "insertWorktree", input: { projectId: P, rootId: P, cardId: "c", branch: "b2", path: "/p2", baseSha: "s" }, on: "b" },
    { op: "setRepo", id: P, repo: { repoPath: "/r", baseBranch: "main" }, on: "b" },
    { op: "reopen" }, { op: "getProject", id: P }, { op: "listProjects", on: "b" },
  ]));
  return out;
}

function boardScenarios() {
  const out: unknown[] = [];
  const colId = (n: number) => `${P}:${["backlog", "in-progress", "review", "done"][n]}`;
  const card = (title: string, column = 0, extra: Op = {}) => ({ op: "bCreateCard", project: P, input: { title, columnId: colId(column), ...extra }, actorJson: actorP });
  out.push(run("board-columns", [
    ...proj(),
    { op: "bColumns", project: P }, { op: "sql", sql: "SELECT data FROM project_boards" },
    { op: "bCreateColumn", project: P, input: { title: "Extra" } }, { op: "bCreateColumn", project: P, input: { titleKey: "k", position: 0, wipLimit: 2 } },
    { op: "bCreateColumn", project: P, input: {} }, { op: "bCreateColumn", project: P, input: { title: "" } }, { op: "bCreateColumn", project: P, input: { title: " " } },
    { op: "bCreateColumn", project: P, input: { title: "t", wipLimit: 0 } }, { op: "bCreateColumn", project: P, input: { title: "t", wipLimit: 1.5 } },
    { op: "bCreateColumn", project: P, input: { title: "t", position: -1 } }, { op: "bCreateColumn", project: P, input: { title: "t", position: 1.5 } }, { op: "bCreateColumn", project: P, input: { title: "t", position: 99 } },
    { op: "bCreateColumn", project: P, input: { title: "x".repeat(257) } }, { op: "bCreateColumn", project: P, input: { title: "x".repeat(256) } },
    { op: "bCreateColumn", project: P, input: { title: `${"\u{1F600}".repeat(128)}` } }, { op: "bCreateColumn", project: P, input: { title: `${"\u{1F600}".repeat(129)}` } },
    { op: "bColumns", project: P },
    { op: "bUpdateColumn", project: P, id: "col_1", patch: { title: "Renamed" } }, { op: "bUpdateColumn", project: P, id: "col_1", patch: { titleKey: "tk" } },
    { op: "bUpdateColumn", project: P, id: "col_1", patch: { wipLimit: 3 } }, { op: "bUpdateColumn", project: P, id: "col_1", patch: { wipLimit: null } }, { op: "bUpdateColumn", project: P, id: "col_1", patch: { wipLimit: 0 } },
    { op: "bUpdateColumn", project: P, id: "nope", patch: {} },
    { op: "bMoveColumn", project: P, id: "col_1", position: 0 }, { op: "bMoveColumn", project: P, id: "col_1", position: 99 }, { op: "bMoveColumn", project: P, id: "col_1", position: -1 }, { op: "bMoveColumn", project: P, id: "col_1", position: 2.5 },
    { op: "bColumns", project: P },
    { op: "bDeleteColumn", project: P, id: "col_1", actorJson: actorP }, { op: "bDeleteColumn", project: P, id: "col_1", target: "col_1", actorJson: actorP },
    { op: "bDeleteColumn", project: P, id: "nope", actorJson: actorP }, { op: "bColumns", project: P }, { op: "sql", sql: "SELECT data FROM project_boards" },
    { op: "bColumns", project: "nope" }, { op: "archive", id: P }, { op: "bCreateColumn", project: P, input: { title: "late" } }, { op: "bColumns", project: P },
  ]));
  out.push(run("board-cards", [
    ...proj(), { op: "addAgent", id: P, agent: "bot" }, { op: "addMember", id: P, user: "u2", role: "worker" },
    card("one"), card("two", 0, { description: "desc", labels: ["a", "b", "a"], priority: "high", dueAt: 5, links: [{ kind: "url", id: "https://example.com/x" }, { kind: "session", id: "s1", extra: 1 }] }),
    card("three", 1), card("four", 0, { position: 0 }), card("five", 0, { position: 99 }), card("six", 0, { position: -1 }), card("seven", 0, { position: 1.5 }),
    { op: "bCreateCard", project: P, input: { title: "  ", columnId: colId(0) }, actorJson: actorP }, { op: "bCreateCard", project: P, input: { title: "x", columnId: "nope" }, actorJson: actorP },
    card("t".repeat(257)), card("bad desc", 0, { description: "d".repeat(65537) }), card("ok desc", 0, { description: "d".repeat(65536) }), card("emoji desc", 0, { description: "\u{1F600}".repeat(32769) }),
    card("lbl", 0, { labels: Array.from({ length: 33 }, (_, i) => `l${i}`) }), card("lbl2", 0, { labels: Array.from({ length: 32 }, (_, i) => `l${i}`) }), card("lbl3", 0, { labels: [""] }), card("lbl4", 0, { labels: ["x".repeat(65)] }), card("lbl5", 0, { labels: ["x".repeat(64)] }),
    card("pri", 0, { priority: "bogus" }), card("pri2", 0, { priority: "none" }), card("due", 0, { dueAt: -1 }), card("due2", 0, { dueAt: 1.5 }), card("due3", 0, { dueAt: 0 }), card("due4", 0, { dueAt: 9007199254740992 }), card("due5", 0, { dueAt: null }),
    card("lk1", 0, { links: [{ kind: "url", id: "ftp://x" }] }), card("lk2", 0, { links: [{ kind: "url", id: "https://a b" }] }), card("lk3", 0, { links: [{ kind: "url", id: "HTTPS://EXAMPLE.COM" }] }),
    card("lk4", 0, { links: [{ kind: "url", id: "mailto:a@b.c" }] }), card("lk5", 0, { links: [{ kind: "url", id: "https://" }] }), card("lk6", 0, { links: [{ kind: "url", id: "https://x\u0001y" }] }), card("lk7", 0, { links: [{ kind: "url", id: "https://x y" }] }),
    card("lk8", 0, { links: [{ kind: "url", id: "https://x﻿y" }] }), card("lk9", 0, { links: [{ kind: "url", id: "https://[::1" }] }), card("lk10", 0, { links: [{ kind: "url", id: "mailto:" }] }), card("lk11", 0, { links: [{ kind: "url", id: "https://exa\u007fmple.com" }] }),
    card("lk12", 0, { links: [{ kind: "url", id: "https://éxample.com/\u{1F600}" }] }), card("lk13", 0, { links: [{ kind: "url", id: "https://a.b:99999" }] }), card("lk14", 0, { links: [{ kind: "url", id: "http://[::1]:80/" }] }), card("lk15", 0, { links: [{ kind: "url", id: "https://a b" }] }),
    card("lk16", 0, { links: [{ kind: "job", id: "" }] }), card("lk17", 0, { links: [{ kind: "nope", id: "x" }] }), card("lk18", 0, { links: [{ kind: "media", id: "m".repeat(4097) }] }), card("lk19", 0, { links: [{ kind: "media", id: "m".repeat(4096) }] }), card("lk20", 0, { links: Array.from({ length: 65 }, () => ({ kind: "job", id: "j" })) }),
    { op: "bColumns", project: P }, { op: "bCards", project: P, filter: {} }, { op: "sql", sql: "SELECT data FROM project_boards" },
  ]));
  out.push(run("board-moves-wip", [
    ...proj(),
    { op: "bUpdateColumn", project: P, id: colId(1), patch: { wipLimit: 2 } },
    card("a"), card("b"), card("c"), card("d", 1), card("e", 1), card("over", 1), { op: "bCreateCard", project: P, input: { title: "forced", columnId: colId(1) }, actorJson: actorP, override: true },
    { op: "bMoveCard", project: P, id: "card_3", column: colId(1), actorJson: actorP }, { op: "bMoveCard", project: P, id: "card_3", column: colId(1), actorJson: actorP, override: true },
    { op: "bMoveCard", project: P, id: "card_1", column: colId(2), position: 0, actorJson: actorP }, { op: "bMoveCard", project: P, id: "card_2", column: colId(2), position: 0, actorJson: actorP },
    { op: "bMoveCard", project: P, id: "card_2", column: colId(2), position: 5, actorJson: actorP }, { op: "bMoveCard", project: P, id: "card_2", column: colId(2), position: -1, actorJson: actorP },
    { op: "bMoveCard", project: P, id: "card_2", column: "nope", actorJson: actorP }, { op: "bMoveCard", project: P, id: "nope", column: colId(2), actorJson: actorP },
    { op: "bArchive", project: P, id: "card_4", archived: true, actorJson: actorP }, { op: "bMoveCard", project: P, id: "card_4", column: colId(0), actorJson: actorP }, { op: "bArchive", project: P, id: "card_4", archived: true, actorJson: actorP },
    { op: "bArchive", project: P, id: "card_4", archived: false, actorJson: actorP }, { op: "bArchive", project: P, id: "card_4", archived: false, actorJson: actorP, override: true },
    { op: "bCards", project: P, filter: { archived: true } }, { op: "bCards", project: P, filter: {} },
    { op: "bDeleteColumn", project: P, id: colId(1), actorJson: actorP }, { op: "bDeleteColumn", project: P, id: colId(1), target: colId(3), actorJson: actorP }, { op: "bDeleteColumn", project: P, id: colId(2), target: "nope", actorJson: actorP },
    { op: "bUpdateColumn", project: P, id: colId(0), patch: { wipLimit: 1 } }, { op: "bDeleteColumn", project: P, id: colId(2), target: colId(0), actorJson: actorP }, { op: "bDeleteColumn", project: P, id: colId(2), target: colId(0), actorJson: actorP, override: true },
    { op: "bColumns", project: P }, { op: "bCards", project: P, filter: {} }, { op: "bActivity", project: P, id: "card_1" }, { op: "sql", sql: "SELECT data FROM project_boards" },
  ]));
  out.push(run("board-assign-comment", [
    ...proj(), { op: "addAgent", id: P, agent: "bot" }, { op: "addMember", id: P, user: "u2", role: "worker" },
    card("a"), card("b"),
    { op: "bAssign", project: P, id: "card_1", assigneeJson: JSON.stringify({ kind: "person", id: "u2" }), add: true, actorJson: actorP },
    { op: "bAssign", project: P, id: "card_1", assigneeJson: JSON.stringify({ id: "bot", kind: "agent", extra: true }), add: true, actorJson: actorFlip },
    { op: "bAssign", project: P, id: "card_1", assigneeJson: JSON.stringify({ kind: "person", id: "u2" }), add: true, actorJson: actorP },
    { op: "bAssign", project: P, id: "card_1", assigneeJson: JSON.stringify({ kind: "person", id: "stranger" }), add: true, actorJson: actorP },
    { op: "bAssign", project: P, id: "card_1", assigneeJson: JSON.stringify({ kind: "robot", id: "bot" }), add: true, actorJson: actorP },
    { op: "bAssign", project: P, id: "nope", assigneeJson: JSON.stringify({ kind: "person", id: "u2" }), add: true, actorJson: actorP },
    { op: "bAssign", project: P, id: "card_2", assigneeJson: JSON.stringify({ kind: "person", id: "nobody" }), add: false, actorJson: actorP },
    { op: "bCards", project: P, filter: {}, assigneeJson: JSON.stringify({ kind: "person", id: "u2" }) }, { op: "bCards", project: P, filter: {}, assigneeJson: JSON.stringify({ id: "bot", kind: "agent" }) },
    { op: "bCards", project: P, filter: { label: "none" } }, { op: "bCards", project: P, filter: { text: "A" } }, { op: "bCards", project: P, filter: { text: "" } }, { op: "bCards", project: P, filter: { columnId: "nope" } },
    { op: "bComment", project: P, id: "card_1", text: "first", actorJson: actorP }, { op: "bComment", project: P, id: "card_1", text: "second \u{1F600}", actorJson: actorFlip },
    { op: "bComment", project: P, id: "card_1", text: "   ", actorJson: actorP }, { op: "bComment", project: P, id: "card_1", text: "﻿", actorJson: actorP }, { op: "bComment", project: P, id: "card_1", text: "x".repeat(65537), actorJson: actorP }, { op: "bComment", project: P, id: "nope", text: "x", actorJson: actorP },
    { op: "bComments", project: P, id: "card_1", input: { limit: 1 } }, { op: "bComments", project: P, id: "card_1", input: { limit: 1 }, afterLast: true }, { op: "bComments", project: P, id: "card_1", input: { limit: 1 }, afterLast: true },
    { op: "bComments", project: P, id: "card_1", input: { limit: 0 } }, { op: "bComments", project: P, id: "card_1", input: { limit: 101 } }, { op: "bComments", project: P, id: "card_1", input: { limit: 1.5 } }, { op: "bComments", project: P, id: "card_1", input: { limit: 100 } },
    { op: "bActivity", project: P, id: "card_1", input: { limit: 2 } }, { op: "bActivity", project: P, id: "card_1", input: { limit: 2 }, afterLast: true }, { op: "bActivity", project: P, id: "card_1", input: { limit: 2 }, afterLast: true }, { op: "bActivity", project: P, id: "card_1", input: { limit: 2, cursor: "garbage" } },
    { op: "bUpdateCard", project: P, id: "card_1", patch: { title: "renamed", labels: ["z"] }, actorJson: actorP }, { op: "bUpdateCard", project: P, id: "card_1", patch: { title: "ok", priority: "bogus" }, actorJson: actorP }, { op: "bGetCard", project: P, id: "card_1" },
    { op: "removeMember", id: P, user: "u2" }, { op: "removeAgent", id: P, agent: "bot" }, { op: "bGetCard", project: P, id: "card_1" }, { op: "bActivity", project: P, id: "card_1", input: { limit: 100 } },
    { op: "removeMember", id: P, user: "u2" }, { op: "sql", sql: "SELECT data FROM project_boards" },
  ]));
  const many = Array.from({ length: 7 }, (_, i) => card(`card ${i}`, i % 2));
  out.push(run("board-paging", [
    ...proj(), ...many,
    { op: "bCards", project: P, filter: { limit: 3 } }, { op: "bCards", project: P, filter: { limit: 3 }, afterLast: true }, { op: "bCards", project: P, filter: { limit: 3 }, afterLast: true },
    { op: "bCards", project: P, filter: { limit: 3 } }, { op: "bMoveCard", project: P, id: "card_1", column: colId(3), actorJson: actorP }, { op: "bCards", project: P, filter: { limit: 3 }, afterLast: true },
    { op: "bCards", project: P, filter: { limit: 2, archived: false } }, { op: "bCards", project: P, filter: { limit: 2, archived: true }, afterLast: true },
    { op: "bBadCursor", project: P, cursor: "" }, { op: "bBadCursor", project: P, cursor: "!!!" }, { op: "bBadCursor", project: P, cursor: Buffer.from('{"hash":"x","after":"y"}').toString("base64url") },
    { op: "bBadCursor", project: P, cursor: "A".repeat(2049) },
    { op: "bCards", project: P, filter: { limit: 1 } },
    { op: "bBadCursor", project: P, cursor: cursorFor(P, 1) },
  ]));
  return out;
}

/** A syntactically valid cursor bound to nothing: the replay must refuse it like TypeScript does. */
function cursorFor(_p: string, _n: number) { return Buffer.from(JSON.stringify({ hash: createHash("sha256").update("[]").digest("hex"), after: "card_1" })).toString("base64url"); }

// ---- pure rules ------------------------------------------------------------------------------------------------------

function pureCases() {
  const configs: any[] = [DEFAULT_COLLAB_LIMITS, { readHelpers: { perTurn: 4, depth: 1 }, writers: { perProject: 2 }, consults: { perPairPerTurn: 3 }, workTokens: 1000, taskClasses: { ...DEFAULT_COLLAB_LIMITS.taskClasses, consult: { rounds: 5, wallTimeMs: 90000, stallTimeMs: 100000 } } }];
  const overrides = [
    "{}", "5", '"x"', "[]", '{"maxDepth":0}', '{"maxDepth":1}', '{"maxDepth":3}', '{"maxDepth":-1}', '{"maxDepth":1.9}', '{"maxDepth":"1"}', '{"maxDepth":null}', '{"maxDepth":true}', '{"maxDepth":1e300}', '{"maxDepth":-0}',
    '{"maxFanout":0}', '{"maxFanout":7.99}', '{"maxFanout":8}', '{"maxFanout":9}', '{"maxPairPerTurn":2}', '{"maxPairPerTurn":5}', '{"maxTurns":1}', '{"maxTurns":26}', '{"maxTurns":0.5}',
    '{"timeoutMs":0}', '{"timeoutMs":1}', '{"timeoutMs":119999}', '{"timeoutMs":120000}', '{"timeoutMs":120001}', '{"timeoutMs":299999.9}', '{"timeoutMs":300000}', '{"timeoutMs":9999999}', '{"timeoutMs":"60000"}',
    '{"returnTokens":0}', '{"returnTokens":1999.5}', '{"returnTokens":2000}', '{"returnTokens":2001}', '{"returnTokens":-5}',
    '{"allowCrossProject":true}', '{"allowCrossProject":"true"}', '{"allowCrossProject":1}', '{"allowCrossProject":false}',
    '{"repeatWindowMs":0}', '{"repeatWindowMs":0.5}', '{"repeatWindowMs":-1}', '{"repeatWindowMs":"5"}', '{"repeatWindowMs":null}', '{"repeatWindowMs":1e21}',
    '{"tokenBudget":0}', '{"tokenBudget":null}', '{"tokenBudget":-1}', '{"tokenBudget":12.5}', '{"tokenBudget":"7"}', '{"tokenBudget":true}', '{"tokenBudget":false}', '{"tokenBudget":[]}',
    '{"maxDepth":1,"maxFanout":2,"maxPairPerTurn":1,"maxTurns":3,"timeoutMs":1000,"returnTokens":10,"allowCrossProject":true,"repeatWindowMs":5,"tokenBudget":100,"extra":1}',
  ];
  const limits: unknown[] = [];
  for (const ci of [0, 1]) for (const projectJson of overrides) {
    const r = resolveCollabLimits(configs[ci], JSON.parse(projectJson) as any);
    limits.push({ config: ci === 0 ? null : configs[ci], projectJson, limits: wire(r), legacy: wire(legacyCollabSettings(r)) });
  }
  const base = () => ({ settings: DEFAULT_COLLAB_SETTINGS, fromAgent: "a", toAgent: "b", path: ["a"], fanout: 0, pairCount: 0, now: 1000, chainStartedAt: 0, lastRepeatAt: null, sameProject: true, tokensUsed: 0, nextTokens: 1 });
  const g: unknown[] = [];
  const add = (label: string, over: Op) => { const input = { ...base(), ...over }; g.push({ label, input: wire(input), result: evaluateGuardrails(input as any) }); };
  const S = (o: Op) => ({ ...DEFAULT_COLLAB_SETTINGS, ...o });
  add("clean", {});
  add("self", { toAgent: "a" }); add("self-beats-cycle", { toAgent: "a", path: ["a", "b"] });
  add("cycle", { fromAgent: "b", path: ["a", "b"], toAgent: "a" }); add("cycle-not-by-prefix", { path: ["ab"], toAgent: "a", fromAgent: "x" });
  add("cycle-case", { path: ["A"], toAgent: "a", fromAgent: "x" });
  for (const len of [1, 2, 3, 4]) { const path = Array.from({ length: len }, (_, i) => `p${i}`); add(`depth-read-${len}`, { path, fromAgent: "z", toAgent: "t" }); add(`depth-write-${len}`, { path, fromAgent: "z", toAgent: "t", callClass: "write" }); add(`depth-review-${len}`, { path, fromAgent: "z", toAgent: "t", callClass: "review" }); }
  for (const d of [0, 1]) add(`depth-max-${d}`, { settings: S({ maxDepth: d }), path: ["a", "c"], fromAgent: "c" });
  for (const f of [7, 8, 9]) { add(`fanout-${f}`, { fanout: f }); add(`fanout-write-${f}`, { fanout: f, callClass: "write", pairCount: 0, consult: false }); }
  add("fanout-max-0", { settings: S({ maxFanout: 0 }) });
  for (const p of [3, 4, 5]) { add(`pair-${p}`, { pairCount: p }); add(`pair-delegate-${p}`, { pairCount: p, consult: false }); add(`pair-consult-true-${p}`, { pairCount: p, consult: true }); }
  add("fanout-then-pair", { fanout: 8, pairCount: 4 });
  for (const diff of [0, 9, 10, 11, 100]) add(`repeat-diff-${diff}`, { lastRepeatAt: 1000 - diff, settings: S({ repeatWindowMs: 10 }) });
  add("repeat-future", { lastRepeatAt: 1100, settings: S({ repeatWindowMs: 10 }) }); add("repeat-zero-window", { lastRepeatAt: 1000, settings: S({ repeatWindowMs: 0 }) }); add("repeat-fraction", { lastRepeatAt: 999, settings: S({ repeatWindowMs: 1.5 }) }); add("repeat-fraction-edge", { lastRepeatAt: 998, settings: S({ repeatWindowMs: 2 }) });
  add("boundary", { sameProject: false }); add("boundary-allowed", { sameProject: false, settings: S({ allowCrossProject: true }) });
  add("boundary-before-budget", { sameProject: false, settings: S({ tokenBudget: 0 }) });
  for (const [used, next, cap] of [[0, 1, 1], [1, 1, 1], [0, 2, 1], [5, 5, 10], [5, 6, 10], [0, 0, 0], [0, 1, 0], [0, 1, 0.5], [0, 0, 0.5], [3, 0, 2]]) add(`budget-${used}-${next}-${cap}`, { tokensUsed: used, nextTokens: next, settings: S({ tokenBudget: cap }) });
  add("budget-null", { tokensUsed: 1e9, nextTokens: 1e9, settings: S({ tokenBudget: null }) });
  const cap: unknown[] = [];
  const settings = (o: Op = {}) => ({ coresPerWriter: 2, memoryPerWriter: 4294967296, ...o });
  const facts = (o: Op = {}, s: Op = {}) => ({ cores: 8, availableMemory: 17179869184, settings: settings(s), ...o });
  const addc = (label: string, f: Op, per: number, running = 0) => cap.push({ label, perProject: per, running, facts: wire(f), result: wire(writerCapacity(per, f as any, running)) });
  addc("plenty", facts(), 4); addc("two-projects-4", facts(), 4); addc("override-up", facts(), 12); addc("override-down", facts(), 1); addc("override-default-equal", facts(), 4);
  addc("cores-bound", facts({ cores: 3 }), 4); addc("memory-bound", facts({ availableMemory: 5e9 }), 4); addc("memory-bound-running", facts({ availableMemory: 5e9 }), 4, 2); addc("total-memory-bound", facts({ totalMemory: 9e9 }), 4, 3);
  addc("floor-one", facts({ cores: 1, availableMemory: 1 }), 4); addc("zero-cores", facts({ cores: 0 }), 4); addc("zero-per-core", facts({}, { coresPerWriter: 0 }), 4); addc("zero-per-memory", facts({}, { memoryPerWriter: 0 }), 4);
  addc("zero-both", facts({ cores: 0 }, { coresPerWriter: 0 }), 4); addc("max-writers", facts({}, { maxWriters: 2 }), 9); addc("max-writers-zero", facts({}, { maxWriters: 0 }), 9); addc("max-writers-over", facts({}, { maxWriters: 50 }), 1);
  addc("negative-memory", facts({ availableMemory: -1 }), 4); addc("fractional", facts({ cores: 7 }, { coresPerWriter: 1.5 }), 4);
  const keys: unknown[] = [];
  const names: [string, string, string][] = [["a", "b", "Hello World"], ["a", "b", "hello   world"], ["a", "b", "  HELLO\tWORLD\n"], ["a", "b", "hello world"], ["a", "b", "hello﻿world"], ["a", "b", "﻿hello﻿"], ["a", "b", "hello world"], ["a", "b", "hello\u0085world"], ["a", "b", "hello​world"], ["a", "b", "hello᠎world"],
    ["a", "b", "İstanbul"], ["a", "b", "İ"], ["a", "b", "Σ"], ["a", "b", "ΑΣ"], ["a", "b", "ΑΣ Α"], ["a", "b", "ß"], ["a", "b", "STRASSE"], ["a", "b", "ẞ"], ["a", "b", "\u{1F600} X"], ["a", "b", "K"], ["a", "b", ""], ["a", "b", "   "],
    ["a", "b\u0000c", "x"], ["a\u0000b", "c", "x"], ["a", "b", "x\u0000y"], ["", "", ""], ["b", "a", "Hello World"], ["A", "b", "Hello World"], ["a", "b", "line1\r\nline2"], ["a", "b", "line1 line2"], ["a", "b", "t\u000bt\u000ct"], ["a", "b", "     　x"]];
  for (const [f, t, q] of names) keys.push({ from: f, to: t, question: q, key: repeatKey(f, t, q) });
  const ids = { pair: [["a", "b"], ["", ""], ["x\u0000", "y"]].map(([a, b]) => ({ a, b, key: pairKey(a!, b!) })), traceparent: [["0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", true], ["0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", false]].map(([t, s, smp]) => ({ trace: t, span: s, sampled: smp, text: traceparent(t as string, s as string, smp as boolean) })) };
  const budgets: unknown[] = [];
  const bs = (label: string, limit: number, parentLimit: number | null, steps: Op[]) => {
    const parent = parentLimit === null ? undefined : delegationWorkBudget(parentLimit);
    const b = delegationWorkBudget(limit, parent);
    const held = new Map<string, { settle(n: number): void; release(): void }>();
    const out: unknown[] = [];
    for (const st of steps) {
      try {
        if (st.reserve !== undefined) { held.set(st.as, b.reserve(st.reserve)); out.push({ ok: null }); }
        else if (st.settle !== undefined) { held.get(st.as)!.settle(st.settle); out.push({ ok: null }); }
        else if (st.release) { held.get(st.as)!.release(); out.push({ ok: null }); }
        else if (st.child !== undefined) { out.push({ ok: null }); }
      } catch (e) { out.push({ err: errOf(e) }); }
      out.push({ used: b.used, parentUsed: parent?.used ?? null });
    }
    budgets.push({ label, limit, parentLimit, steps, out });
  };
  bs("fits", 10, null, [{ reserve: 10, as: "a" }, { reserve: 1, as: "b" }, { settle: 4, as: "a" }, { reserve: 6, as: "c" }, { reserve: 1, as: "d" }]);
  bs("release-frees", 10, null, [{ reserve: 10, as: "a" }, { release: true, as: "a" }, { reserve: 10, as: "b" }, { settle: 10, as: "b" }, { settle: 1, as: "b" }, { release: true, as: "b" }]);
  bs("settle-above-reserve", 10, null, [{ reserve: 5, as: "a" }, { settle: 12, as: "a" }, { reserve: 1, as: "b" }]);
  bs("zero", 0, null, [{ reserve: 0, as: "a" }, { reserve: 1, as: "b" }]);
  bs("invalid", 100, null, [{ reserve: 1.5, as: "a" }, { reserve: -1, as: "b" }, { reserve: 9007199254740992, as: "c" }, { reserve: 1e21, as: "d" }, { reserve: 0, as: "e" }]);
  bs("parent-binds", 10, 4, [{ reserve: 5, as: "a" }, { reserve: 4, as: "b" }, { settle: 3, as: "b" }, { reserve: 2, as: "c" }, { release: true, as: "c" }]);
  bs("parent-reserved-not-leaked", 10, 4, [{ reserve: 5, as: "a" }, { reserve: 4, as: "b" }, { release: true, as: "b" }, { reserve: 4, as: "c" }]);
  bs("double-settle", 10, 10, [{ reserve: 5, as: "a" }, { settle: 2, as: "a" }, { settle: 3, as: "a" }, { release: true, as: "a" }]);
  const defaults = { limits: wire(DEFAULT_COLLAB_LIMITS), settings: wire(DEFAULT_COLLAB_SETTINGS) };
  return { defaults, limits, guardrails: g, capacity: cap, repeatKeys: keys, ids, budgets };
}

// ---- schema ----------------------------------------------------------------------------------------------------------

function schemaCases() {
  const rows = (db: DatabaseSync) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
  const fresh = (version: number) => { const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); migrate(db, MIGRATIONS.slice(0, version)); const out = rows(db); db.close(); return out; };
  const migratedFrom = (version: number) => { const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); migrate(db, MIGRATIONS.slice(0, version)); migrate(db); const out = rows(db); const v = (db.prepare("PRAGMA user_version").get() as any).user_version; db.close(); return { out, v }; };
  const full = fresh(SCHEMA_VERSION);
  const migrated: Record<string, unknown> = {};
  for (let v = 1; v <= SCHEMA_VERSION; v++) { const m = migratedFrom(v); if (JSON.stringify(m.out) !== JSON.stringify(full) || m.v !== SCHEMA_VERSION) throw new Error(`migrating from v${v} differs from a fresh file`); migrated[String(v)] = m.v; }
  const prefixes: Record<string, unknown> = {};
  for (let v = 1; v <= SCHEMA_VERSION; v++) prefixes[String(v)] = fresh(v);
  const newer = new DatabaseSync(":memory:"); newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  let refusal: unknown; try { migrate(newer); } catch (e) { refusal = errOf(e); }
  return { version: SCHEMA_VERSION, migrations: [...MIGRATIONS], schema: full, prefixes, migratedUserVersions: migrated, newerRefusal: refusal };
}

export async function buildCollabVectors() {
  return { schema: schemaCases(), pure: pureCases(), store: { scenarios: storeScenarios() }, board: { scenarios: boardScenarios() } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await exporterMain({ area: "collab", build: buildCollabVectors }));
}
