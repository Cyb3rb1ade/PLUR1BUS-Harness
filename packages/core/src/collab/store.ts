import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_COLLAB_SETTINGS } from "./defaults.ts";
import { CollabError } from "./errors.ts";
import { newId } from "./ids.ts";
import { migrate, SCHEMA_VERSION } from "./migrations.ts";
import type {
  CollabSettings, CollabSpan, CollabTrace, DelegateTask, Project, ProjectMember, ProjectRole, SpanStatus, TaskStatus,
} from "./types.ts";
import { traceparent } from "./ids.ts";

export { SCHEMA_VERSION };

type Row = Record<string, unknown>;

export interface StoreOptions { path: string; clock?: () => number; newId?: (prefix: string) => string }

function mergeSettings(raw: unknown): CollabSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<CollabSettings>;
  return {
    maxDepth: num(o.maxDepth, DEFAULT_COLLAB_SETTINGS.maxDepth),
    maxFanout: num(o.maxFanout, DEFAULT_COLLAB_SETTINGS.maxFanout),
    maxPairPerTurn: num(o.maxPairPerTurn, DEFAULT_COLLAB_SETTINGS.maxPairPerTurn),
    maxTurns: num(o.maxTurns, DEFAULT_COLLAB_SETTINGS.maxTurns),
    timeoutMs: num(o.timeoutMs, DEFAULT_COLLAB_SETTINGS.timeoutMs),
    returnTokens: num(o.returnTokens, DEFAULT_COLLAB_SETTINGS.returnTokens),
    allowCrossProject: o.allowCrossProject === true,
    repeatWindowMs: num(o.repeatWindowMs, DEFAULT_COLLAB_SETTINGS.repeatWindowMs),
    tokenBudget: o.tokenBudget == null ? null : num(o.tokenBudget, 0),
    costBudget: o.costBudget == null ? null : num(o.costBudget, 0),
  };
}
function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d;
}

export class CollabStore {
  readonly #db: DatabaseSync;
  readonly #clock: () => number;
  readonly #newId: (prefix: string) => string;

  constructor(o: StoreOptions) {
    this.#clock = o.clock ?? Date.now;
    this.#newId = o.newId ?? newId;
    this.#db = new DatabaseSync(o.path);
    try {
      this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (o.path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      migrate(this.#db);
    } catch (e) { this.#db.close(); throw e; }
    if (o.path !== ":memory:" && process.platform !== "win32") { try { chmodSync(o.path, 0o600); } catch { /* best effort */ } }
  }

  close(): void { this.#db.close(); }
  now(): number { return this.#clock(); }
  id(prefix: string): string { return this.#newId(prefix); }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.#db.exec("COMMIT"); return r; }
    catch (e) { try { this.#db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
  }
  #get(sql: string, ...args: (string | number | null)[]): Row | undefined { return this.#db.prepare(sql).get(...args) as Row | undefined; }
  #all(sql: string, ...args: (string | number | null)[]): Row[] { return this.#db.prepare(sql).all(...args) as Row[]; }
  #run(sql: string, ...args: (string | number | bigint | null)[]): void { this.#db.prepare(sql).run(...args); }

  // ---- projects --------------------------------------------------------------------------------

  createProject(i: { name: string; owner: string; settings?: Partial<CollabSettings>; id?: string }): Project {
    const name = i.name.trim();
    if (!name) throw new CollabError("invalid", "project name is required", { reason: "name" });
    if (!i.owner) throw new CollabError("invalid", "owner is required", { reason: "owner" });
    const now = this.#clock();
    const id = i.id ?? this.#newId("prj");
    const settings = mergeSettings(i.settings ?? {});
    return this.#tx(() => {
      this.#run(
        "INSERT INTO projects (id, name, owner, settings, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        id, name, i.owner, JSON.stringify(settings), now, now,
      );
      this.#run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)", id, i.owner, "lead", now);
      return this.#project(id)!;
    });
  }

  getProject(id: string): Project | null { return this.#project(id); }

  listProjects(): Project[] {
    return this.#all("SELECT id FROM projects ORDER BY created_at, id").map((r) => this.#project(r.id as string)!);
  }

  archiveProject(id: string): Project {
    const now = this.#clock();
    return this.#tx(() => {
      const p = this.#project(id);
      if (!p) throw new CollabError("not-found", `project ${id} not found`, { reason: "project" });
      if (p.archivedAt !== null) return p;
      this.#run("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, id);
      return this.#project(id)!;
    });
  }

  addMember(projectId: string, userId: string, role: ProjectRole): Project {
    if (!userId) throw new CollabError("invalid", "userId is required", { reason: "userId" });
    if (role !== "member" && role !== "lead") throw new CollabError("invalid", "role must be member or lead", { reason: "role" });
    const now = this.#clock();
    return this.#tx(() => {
      const p = this.#live(projectId);
      this.#run(
        "INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role",
        projectId, userId, role, now,
      );
      this.#touch(projectId, now);
      return this.#project(p.id)!;
    });
  }

  removeMember(projectId: string, userId: string): Project {
    const now = this.#clock();
    return this.#tx(() => {
      const p = this.#live(projectId);
      if (userId === p.owner) throw new CollabError("conflict", "the project owner cannot be removed", { reason: "owner" });
      this.#run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", projectId, userId);
      this.#touch(projectId, now);
      return this.#project(projectId)!;
    });
  }

  addAgent(projectId: string, agentId: string): Project {
    if (!agentId) throw new CollabError("invalid", "agentId is required", { reason: "agentId" });
    const now = this.#clock();
    return this.#tx(() => {
      this.#live(projectId);
      this.#run("INSERT OR IGNORE INTO project_agents (project_id, agent_id, added_at) VALUES (?,?,?)", projectId, agentId, now);
      this.#touch(projectId, now);
      return this.#project(projectId)!;
    });
  }

  removeAgent(projectId: string, agentId: string): Project {
    const now = this.#clock();
    return this.#tx(() => {
      this.#live(projectId);
      this.#run("DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?", projectId, agentId);
      this.#touch(projectId, now);
      return this.#project(projectId)!;
    });
  }

  #touch(id: string, now: number): void { this.#run("UPDATE projects SET updated_at = ? WHERE id = ?", now, id); }

  #live(id: string): Project {
    const p = this.#project(id);
    if (!p) throw new CollabError("not-found", `project ${id} not found`, { reason: "project" });
    if (p.archivedAt !== null) throw new CollabError("archived", `project ${id} is archived`, { reason: "archived" });
    return p;
  }

  #project(id: string): Project | null {
    const r = this.#get("SELECT * FROM projects WHERE id = ?", id);
    if (!r) return null;
    const members = this.#all("SELECT user_id, role FROM project_members WHERE project_id = ? ORDER BY user_id", id)
      .map((m): ProjectMember => ({ userId: m.user_id as string, role: m.role as ProjectRole }));
    const agents = this.#all("SELECT agent_id FROM project_agents WHERE project_id = ? ORDER BY agent_id", id)
      .map((a) => a.agent_id as string);
    return {
      id: r.id as string, name: r.name as string, owner: r.owner as string, members, agents,
      settings: mergeSettings(JSON.parse(r.settings as string)),
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
      archivedAt: (r.archived_at as number | null) ?? null,
    };
  }

  // ---- artifacts -------------------------------------------------------------------------------

  putArtifact(projectId: string, body: string, contentType = "text/plain"): { id: string; pointer: string } {
    const id = this.#newId("art");
    this.#run("INSERT INTO artifacts (id, project_id, body, content_type, created_at) VALUES (?,?,?,?,?)", id, projectId, body, contentType, this.#clock());
    return { id, pointer: `artifact:${id}` };
  }
  getArtifact(id: string): { id: string; projectId: string; body: string; contentType: string; createdAt: number } | null {
    const r = this.#get("SELECT * FROM artifacts WHERE id = ?", id);
    if (!r) return null;
    return { id: r.id as string, projectId: r.project_id as string, body: r.body as string, contentType: r.content_type as string, createdAt: r.created_at as number };
  }

  // ---- repeats ---------------------------------------------------------------------------------

  lastRepeat(key: string): number | null {
    const r = this.#get("SELECT at FROM repeats WHERE key = ?", key);
    return r ? r.at as number : null;
  }
  rememberRepeat(key: string, at: number): void {
    this.#run("INSERT INTO repeats (key, at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at = excluded.at", key, at);
  }

  // ---- traces / spans --------------------------------------------------------------------------

  insertTrace(i: { traceId: string; projectId: string; rootAgent: string; rootSpanId: string; status?: SpanStatus }): void {
    this.#run(
      "INSERT INTO traces (trace_id, project_id, root_agent, root_span_id, created_at, status) VALUES (?,?,?,?,?,?)",
      i.traceId, i.projectId, i.rootAgent, i.rootSpanId, this.#clock(), i.status ?? "running",
    );
  }

  insertSpan(s: {
    spanId: string; traceId: string; parentSpanId: string | null; agentId: string; kind: string;
    status?: SpanStatus; inputPreview?: string;
  }): void {
    this.#run(
      "INSERT INTO spans (span_id, trace_id, parent_span_id, agent_id, kind, started_at, status, input_preview) VALUES (?,?,?,?,?,?,?,?)",
      s.spanId, s.traceId, s.parentSpanId, s.agentId, s.kind, this.#clock(), s.status ?? "running", s.inputPreview ?? "",
    );
  }

  finishSpan(spanId: string, patch: {
    status: SpanStatus; outputPreview?: string; error?: string | null; guardrail?: string | null;
    inputTokens?: number; outputTokens?: number; costEstimate?: number | null;
  }): void {
    this.#run(
      "UPDATE spans SET ended_at=?, status=?, output_preview=?, error=?, guardrail=?, input_tokens=?, output_tokens=?, cost_estimate=? WHERE span_id=?",
      this.#clock(), patch.status, patch.outputPreview ?? "", patch.error ?? null, patch.guardrail ?? null,
      patch.inputTokens ?? 0, patch.outputTokens ?? 0, patch.costEstimate ?? null, spanId,
    );
  }

  finishTrace(traceId: string, status: SpanStatus): void {
    this.#run("UPDATE traces SET ended_at=?, status=? WHERE trace_id=?", this.#clock(), status, traceId);
  }

  getTrace(traceId: string): CollabTrace | null {
    const t = this.#get("SELECT * FROM traces WHERE trace_id = ?", traceId);
    if (!t) return null;
    const spans = this.#all("SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, span_id", traceId).map(toSpan);
    return {
      traceId: t.trace_id as string,
      traceparent: traceparent(t.trace_id as string, t.root_span_id as string),
      projectId: t.project_id as string,
      rootAgent: t.root_agent as string,
      rootSpanId: t.root_span_id as string,
      createdAt: t.created_at as number,
      endedAt: (t.ended_at as number | null) ?? null,
      status: t.status as SpanStatus,
      spans,
    };
  }

  listTraces(projectId: string): CollabTrace[] {
    return this.#all("SELECT trace_id FROM traces WHERE project_id = ? ORDER BY created_at, trace_id", projectId)
      .map((r) => this.getTrace(r.trace_id as string)!)
      .filter(Boolean);
  }

  // ---- tasks -----------------------------------------------------------------------------------

  insertTask(t: {
    id: string; projectId: string; traceId: string; spanId: string; parentTaskId: string | null;
    fromAgent: string; toAgent: string; kind: "consult" | "delegate"; status: TaskStatus;
    task: string; acceptance: string; path: string[];
  }): DelegateTask {
    const now = this.#clock();
    this.#run(
      `INSERT INTO tasks (id, project_id, trace_id, span_id, parent_task_id, from_agent, to_agent, kind, status, task, acceptance, path, created_at, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.id, t.projectId, t.traceId, t.spanId, t.parentTaskId, t.fromAgent, t.toAgent, t.kind, t.status,
      t.task, t.acceptance, JSON.stringify(t.path), now, t.status === "running" ? now : null,
    );
    return this.getTask(t.id)!;
  }

  updateTask(id: string, patch: {
    status: TaskStatus; result?: string | null; truncated?: boolean; artifactId?: string | null;
    error?: string | null; inputTokens?: number; outputTokens?: number;
  }): DelegateTask {
    const now = this.#clock();
    const started = patch.status === "running" ? now : undefined;
    this.#run(
      `UPDATE tasks SET status=?, result_capped=?, truncated=?, result_artifact_id=?, error=?, ended_at=?, input_tokens=?, output_tokens=?
       ${started !== undefined ? ", started_at=?" : ""} WHERE id=?`,
      patch.status, patch.result ?? null, patch.truncated === true ? 1 : 0, patch.artifactId ?? null, patch.error ?? null,
      patch.status === "running" ? null : now, patch.inputTokens ?? null, patch.outputTokens ?? null,
      ...(started !== undefined ? [started, id] : [id]),
    );
    return this.getTask(id)!;
  }

  getTask(id: string): DelegateTask | null {
    const r = this.#get("SELECT * FROM tasks WHERE id = ?", id);
    return r ? toTask(r) : null;
  }

  listTasks(traceId: string): DelegateTask[] {
    return this.#all("SELECT * FROM tasks WHERE trace_id = ? ORDER BY created_at, id", traceId).map(toTask);
  }

  cancelOpenTasks(traceId: string): string[] {
    const open = this.#all("SELECT id FROM tasks WHERE trace_id = ? AND status IN ('queued','running')", traceId);
    const now = this.#clock();
    const ids: string[] = [];
    for (const r of open) {
      const id = r.id as string;
      this.#run("UPDATE tasks SET status='cancelled', error='aborted', ended_at=? WHERE id=?", now, id);
      ids.push(id);
    }
    return ids;
  }
}

function toSpan(r: Row): CollabSpan {
  return {
    spanId: r.span_id as string, traceId: r.trace_id as string, parentSpanId: (r.parent_span_id as string | null) ?? null,
    agentId: r.agent_id as string, kind: r.kind as CollabSpan["kind"], startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null, status: r.status as SpanStatus,
    inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number,
    costEstimate: (r.cost_estimate as number | null) ?? null,
    inputPreview: r.input_preview as string, outputPreview: r.output_preview as string,
    error: (r.error as string | null) ?? null, guardrail: (r.guardrail as CollabSpan["guardrail"]) ?? null,
  };
}

function toTask(r: Row): DelegateTask {
  const artifactId = (r.result_artifact_id as string | null) ?? null;
  return {
    id: r.id as string, projectId: r.project_id as string, traceId: r.trace_id as string, spanId: r.span_id as string,
    parentTaskId: (r.parent_task_id as string | null) ?? null, fromAgent: r.from_agent as string, toAgent: r.to_agent as string,
    status: r.status as TaskStatus, task: r.task as string, acceptanceCriteria: r.acceptance as string,
    result: (r.result_capped as string | null) ?? null, truncated: r.truncated === 1,
    artifactId, artifactPointer: artifactId ? `artifact:${artifactId}` : null,
    error: (r.error as string | null) ?? null, path: JSON.parse(r.path as string) as string[],
    createdAt: r.created_at as number, startedAt: (r.started_at as number | null) ?? null, endedAt: (r.ended_at as number | null) ?? null,
    usage: r.input_tokens == null && r.output_tokens == null ? null : { inputTokens: (r.input_tokens as number) ?? 0, outputTokens: (r.output_tokens as number) ?? 0 },
  };
}
