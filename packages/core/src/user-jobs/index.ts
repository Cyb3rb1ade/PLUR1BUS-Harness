// User jobs keep identity references, never authority snapshots. Claim each due slot before admitting a turn.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { nextAfter, parseCron, isValidTimezone } from "../dreams/cron.ts";
import { authorize } from "../rbac/authorize.ts";
import { ROLES, type Principal } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import { RpcError } from "../rpc/errors.ts";
import { createPlatformCapabilities } from "../platform.ts";
export interface UserJobInput {
  name: string;
  agentId: string;
  prompt: string;
  schedule: {
    cron: string;
    timezone: string;
  };
  enabled: boolean;
}
export interface UserJob extends UserJobInput {
  id: string;
  kind: "user";
  needsLlm: true;
  singleton: true;
  runAs: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  disabledReason?: string;
}
export type UserJobOutcome = "running" | "completed" | "failed" | "abandoned" | "skipped_owner_inactive" | "skipped_no_rights" | "skipped_agent_missing" | "skipped_agent_inactive" | "skipped_budget" | "approval_timeout";
export interface UserJobRun {
  runId: string;
  jobId: string;
  agentId: string;
  job: string;
  kind: "user";
  runAs: string;
  runAsDisplayName: string;
  trigger: "recurring";
  requestedBy?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome: UserJobOutcome;
}
export interface UserJobsOptions {
  isStopping?: () => boolean;
  path: string;
  clock: () => number;
  audit: AuditSink;
  agentExists: (id: string) => boolean;
  agents?: () => string[];
  resolve: (personId: string) => Principal | null;
  displayName?: (id: string) => string;
  budgetBlocked: (agentId: string) => boolean;
  notify: (run: UserJobRun) => void;
  onRecorded?: (run: UserJobRun) => void;
  submitTurn: (job: UserJob, person: Principal) => Promise<UserJobOutcome>;
}
const denied = () => new RpcError("E_DENIED", "user job operation denied");
const invalid = () => new RpcError("E_INVALID_PARAMS", "invalid user job definition");
export class UserJobs {
  readonly #db: DatabaseSync;
  readonly #o: UserJobsOptions;
  readonly #running = new Set<string>();
  readonly #pending = new Set<Promise<UserJobRun>>();
  #closed = false;
  constructor(o: UserJobsOptions) {
    this.#o = o;
    mkdirSync(dirname(o.path), { recursive: true });
    closeSync(openSync(o.path, "a", 0o600));
    createPlatformCapabilities().securePath(o.path, { mode: 0o600 });
    this.#db = new DatabaseSync(o.path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS user_jobs(id TEXT PRIMARY KEY, definition TEXT NOT NULL); CREATE TABLE IF NOT EXISTS user_job_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, record TEXT NOT NULL);");
    // A claimed slot is never replayed. Interrupted runs become explicit abandoned records on startup.
    for (const row of this.#db.prepare("SELECT id,record FROM user_job_runs").all() as {
      id: string;
      record: string;
    }[]) {
      const run = JSON.parse(row.record);
      if (run.outcome === "running") {
        run.outcome = "abandoned";
        run.finishedAt = o.clock();
        run.durationMs = run.finishedAt - run.startedAt;
        this.#db.prepare("UPDATE user_job_runs SET record=? WHERE id=?").run(JSON.stringify(run), row.id);
      }
    }
  }
  async drain() {
    await Promise.allSettled([...this.#pending]);
  }
  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
  has(id: string) {
    return !!this.#db.prepare("SELECT id FROM user_jobs WHERE id=?").get(id);
  }
  get(id: string): UserJob {
    if (this.#closed) {
      throw new RpcError("E_NOT_AVAILABLE", "user jobs are closed");
    }
    const row = this.#db.prepare("SELECT definition FROM user_jobs WHERE id=?").get(id) as {
      definition: string;
    } | undefined;
    if (!row) {
      throw new RpcError(id.startsWith("user:") ? "E_NOT_FOUND" : "E_DENIED", id.startsWith("user:") ? "user job not found" : "system and engine jobs are immutable", { reason: id.startsWith("user:") ? "job-not-found" : "immutable-system-job" });
    }
    return JSON.parse(row.definition);
  }
  #person(p: Principal) {
    if (this.#closed || this.#o.isStopping?.()) {
      throw new RpcError("E_NOT_AVAILABLE", "the core is stopping");
    }
    if (p?.kind !== "person" || !p.userId || !ROLES.includes(p.role)) {
      throw denied();
    }
  }
  #read(p: Principal) {
    this.#person(p);
    if (authorize(p, "agent.list", { kind: "system" }, { now: this.#o.clock() }).effect !== "allow") throw denied();
  }
  #manage(p: Principal, id: string) {
    this.#person(p);
    if (authorize(p, "agent.manage", { kind: "agent", agentId: id }, { now: this.#o.clock() }).effect !== "allow") {
      throw denied();
    }
  }
  #use(p: Principal, id: string) {
    this.#person(p);
    if (authorize(p, "agent.use", { kind: "agent", agentId: id }, { now: this.#o.clock() }).effect !== "allow") {
      throw denied();
    }
  }
  #visible(p: Principal, j: UserJob) {
    this.#person(p);
    return p.role === "owner" || p.role === "admin" || p.userId === j.runAs || (Object.hasOwn(p.agentRights ?? {}, j.agentId) && ["use", "manage"].includes(p.agentRights![j.agentId]!));
  }
  #validate(i: UserJobInput) {
    if (typeof i.name !== "string" || !i.name.trim() || i.name.length > 128 || /[\u0000-\u001f\u007f]/.test(i.name) || typeof i.prompt !== "string" || !i.prompt.trim() || i.prompt.length > 4000 || i.prompt.includes("\0") || typeof i.enabled !== "boolean" || typeof i.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(i.agentId) || !this.#o.agentExists(i.agentId)) {
      throw invalid();
    }
    if (!i.schedule || typeof i.schedule.cron !== "string" || typeof i.schedule.timezone !== "string" || Object.keys(i.schedule).some(k => k !== "cron" && k !== "timezone") || i.schedule.cron.length > 128 || i.schedule.timezone.length > 128 || !isValidTimezone(i.schedule.timezone)) {
      throw invalid();
    }
    try {
      // An expression that parses but never matches a real date (30 February) would leave an enabled job that never runs.
      if (nextAfter(parseCron(i.schedule.cron), i.schedule.timezone, this.#o.clock()) === null) {
        throw invalid();
      }
    }
    catch {
      throw invalid();
    }
  }
  #next(i: UserJobInput, at: number) {
    return i.enabled ? nextAfter(parseCron(i.schedule.cron), i.schedule.timezone, at) : null;
  }
  #audit(p: Principal, action: string, id: string, detail: Record<string, unknown>) {
    try {
      this.#o.audit.append({ at: this.#o.clock(), actor: { user: p.userId, host: "core" }, action, target: id, detail });
    }
    catch {
      throw new RpcError("E_STORAGE", "user job change could not be audited");
    }
  }
  #save(j: UserJob) {
    this.#db.prepare("INSERT INTO user_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition").run(j.id, JSON.stringify(j));
  }
  create(input: UserJobInput, p: Principal): UserJob {
    if (Object.keys(input).some(k => !["name", "agentId", "prompt", "schedule", "enabled"].includes(k))) {
      throw invalid();
    }
    // Authorize before looking at the agent, so a caller without rights cannot probe which agents exist.
    this.#person(p);
    if (typeof input.agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.agentId)) {
      throw invalid();
    }
    this.#manage(p, input.agentId);
    this.#use(p, input.agentId);
    this.#validate(input);
    const now = this.#o.clock();
    const job: UserJob = { ...structuredClone(input), name: input.name.trim(), id: `user:${randomUUID()}`, kind: "user", needsLlm: true, singleton: true, runAs: p.userId, createdBy: p.userId, createdAt: now, updatedAt: now, nextRunAt: this.#next(input, now) };
    this.#audit(p, "jobs.created", job.id, { agentId: job.agentId, runAs: job.runAs });
    this.#save(job);
    return job;
  }
  update(patch: {
    id: string;
  } & Partial<UserJobInput>, p: Principal): UserJob {
    if (Object.keys(patch).some(k => !["id", "name", "agentId", "prompt", "schedule", "enabled"].includes(k))) {
      throw invalid();
    }
    const old = this.get(patch.id);
    this.#manage(p, old.agentId);
    const next: UserJob = { ...old, ...structuredClone(patch), runAs: p.userId, updatedAt: this.#o.clock() };
    this.#validate(next);
    next.name = next.name.trim();
    this.#manage(p, next.agentId);
    const live = this.#o.resolve(p.userId);
    if (next.enabled) {
      if (!live || live.userId !== p.userId) {
        throw denied();
      }
      this.#use(live, next.agentId);
    }
    if (next.enabled) {
      delete next.disabledReason;
    }
    next.nextRunAt = this.#next(next, this.#o.clock());
    this.#audit(p, old.runAs === p.userId ? "jobs.updated" : "jobs.runAs.changed", old.id, { agentId: next.agentId, oldRunAs: old.runAs, runAs: p.userId });
    this.#save(next);
    return next;
  }
  delete(id: string, confirm: boolean, p: Principal) {
    if (confirm !== true) {
      throw invalid();
    }
    const j = this.get(id);
    this.#manage(p, j.agentId);
    if (this.#running.has(id)) {
      throw new RpcError("E_CONFLICT", "user job is running");
    }
    this.#audit(p, "jobs.deleted", id, { runAs: j.runAs });
    this.#db.prepare("DELETE FROM user_jobs WHERE id=?").run(id);
    return { id, deleted: true as const };
  }
  targets(p: Principal): string[] {
    this.#read(p);
    return (this.#o.agents?.() ?? []).filter(agentId => this.#o.agentExists(agentId) && authorize(p, "agent.manage", { kind: "agent", agentId }, { now: this.#o.clock() }).effect === "allow");
  }
  list(p: Principal): UserJob[] {
    this.#read(p);
    return (this.#db.prepare("SELECT definition FROM user_jobs ORDER BY id").all() as {
      definition: string;
    }[]).map(row => JSON.parse(row.definition) as UserJob).filter(j => this.#visible(p, j));
  }
  history(id: string | undefined, p: Principal, limit = 50): UserJobRun[] {
    this.#read(p);
    const runs = (this.#db.prepare("SELECT record FROM user_job_runs ORDER BY rowid DESC").all() as {record:string}[])
      .map(row => JSON.parse(row.record) as UserJobRun)
      .filter(r => (p.role === "owner" || p.role === "admin" || p.userId === r.runAs || (Object.hasOwn(p.agentRights ?? {}, r.agentId) && ["use", "manage"].includes(p.agentRights![r.agentId]!))) && (!id || r.jobId === id));
    return runs.slice(0, Math.min(200, Math.max(1, limit)));
  }
  async tick() {
    if (this.#closed || this.#o.isStopping?.()) {
      return;
    }
    const due = (this.#db.prepare("SELECT definition FROM user_jobs").all() as {
      definition: string;
    }[]).map(row => JSON.parse(row.definition) as UserJob).filter(j => j.enabled && j.nextRunAt !== null && j.nextRunAt <= this.#o.clock());
    for (const snapshot of due) {
      if (this.#closed || this.#o.isStopping?.()) return;
      if (this.#running.has(snapshot.id) || !this.has(snapshot.id)) continue;
      // Another overlapping scan or an edit may have advanced this slot while a previous job was awaiting approval.
      const current = this.get(snapshot.id);
      if (current.enabled && current.nextRunAt !== null && current.nextRunAt === snapshot.nextRunAt && current.nextRunAt <= this.#o.clock()) {
        await this.#run(current);
      }
    }
  }
  async run(id: string, p: Principal) {
    const j = this.get(id);
    this.#use(p, j.agentId);
    if (!j.enabled) {
      throw new RpcError("E_CONFLICT", "user job is disabled");
    }
    return this.#run(j, p.userId);
  }
  #run(j: UserJob, requestedBy?: string): Promise<UserJobRun> {
    const run = this.#executeRun(j, requestedBy);
    this.#pending.add(run);
    void run.then(() => this.#pending.delete(run), () => this.#pending.delete(run));
    return run;
  }
  async #executeRun(j: UserJob, requestedBy?: string): Promise<UserJobRun> {
    if (this.#running.has(j.id)) {
      throw new RpcError("E_CONFLICT", "user job already running");
    }
    this.#running.add(j.id);
    let startedAt: number;
    let record: UserJobRun;
    let inTransaction = false;
    try {
      startedAt = this.#o.clock();
      let runAsDisplayName = j.runAs;
      try {
        runAsDisplayName = this.#o.displayName?.(j.runAs) ?? j.runAs;
      }
      catch {
      }
      record = { runId: randomUUID(), jobId: j.id, agentId: j.agentId, job: j.name, kind: "user", runAs: j.runAs, runAsDisplayName, trigger: "recurring", ...(requestedBy ? { requestedBy } : {}), startedAt, finishedAt: startedAt, durationMs: 0, outcome: "abandoned" };
      // The claim and future slot advance are one SQLite transaction, before any turn can start.
      this.#db.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      const latest = this.get(j.id);
      latest.nextRunAt = this.#next(latest, startedAt);
      this.#save(latest);
      this.#db.prepare("INSERT INTO user_job_runs VALUES (?,?,?)").run(record.runId, j.id, JSON.stringify({ ...record, outcome: "running" }));
      this.#db.exec("COMMIT");
      inTransaction = false;
    }
    catch (e) {
      try {
        if (inTransaction) {
          this.#db.exec("ROLLBACK");
        }
      }
      finally {
        this.#running.delete(j.id);
      }
      throw e;
    }
    try {
      const person = this.#o.resolve(j.runAs);
      if (!this.#o.agentExists(j.agentId)) {
        record.outcome = "skipped_agent_missing";
      }
      else {
        if (!person || person.kind !== "person" || person.userId !== j.runAs) {
          record.outcome = "skipped_owner_inactive";
        }
        else {
          if (authorize(person, "agent.use", { kind: "agent", agentId: j.agentId }, { now: startedAt }).effect !== "allow") {
            record.outcome = "skipped_no_rights";
          }
          else {
            if (this.#o.budgetBlocked(j.agentId)) {
              record.outcome = "skipped_budget";
            }
            else {
              record.outcome = await this.#o.submitTurn(j, person);
            }
          }
        }
      }
    }
    catch {
      record.outcome = "failed";
    }
    finally {
      try {
        record.finishedAt = this.#o.clock();
        record.durationMs = Math.max(0, record.finishedAt - startedAt);
        this.#db.prepare("UPDATE user_job_runs SET record=? WHERE id=?").run(JSON.stringify(record), record.runId);
        if (["skipped_owner_inactive", "skipped_no_rights", "skipped_agent_missing"].includes(record.outcome)) {
          const latest = this.get(j.id);
          latest.enabled = false;
          latest.nextRunAt = null;
          latest.disabledReason = record.outcome;
          this.#save(latest);
          try {
            this.#o.notify(record);
          }
          catch {
          }
        }
      }
      finally {
        this.#running.delete(j.id);
      }
      try {
        this.#o.onRecorded?.(record);
      }
      catch {
      }
    }
    return record;
  }
}
