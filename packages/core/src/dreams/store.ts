// Run-state persistence for the dreaming scheduler (ADR-009 "Run-state persistence"): node:sqlite, versioned migrations.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BreakerState, CandidateRow, CandidateState, DreamRun, Outcome, Phase, RunCounts, ScheduleRow, Trigger } from "./types.ts";

/** Forward-only. Step N takes the database from user_version N-1 to N; a store from a newer build is refused. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE dream_run (
    run_id           TEXT PRIMARY KEY,
    agent_id         TEXT NOT NULL,
    phase            TEXT NOT NULL CHECK (phase IN ('light','rem','deep')),
    job_id           TEXT NOT NULL,
    partition        TEXT,
    idempotency_key  TEXT NOT NULL,
    trigger          TEXT NOT NULL CHECK (trigger IN ('cron','importance','manual','catchup')),
    scheduled_for    INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER,
    outcome          TEXT CHECK (outcome IN ('completed','skipped','failed','aborted')),
    reason           TEXT,
    counts_json      TEXT NOT NULL DEFAULT '{}',
    tokens_in INTEGER, tokens_out INTEGER, cost_micros INTEGER,
    log_path         TEXT, error_json TEXT,
    UNIQUE (idempotency_key)
  );
  CREATE INDEX dream_run_agent_phase_started ON dream_run(agent_id, phase, started_at DESC);

  CREATE TABLE dream_schedule (
    agent_id TEXT NOT NULL, phase TEXT NOT NULL,
    cron TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    stagger_offset_s INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER, last_run_id TEXT,
    breaker_state TEXT NOT NULL DEFAULT 'closed', breaker_until INTEGER, breaker_reason TEXT,
    -- RULING: the importance trigger and the transcript digest need per-agent signal state that must survive a restart;
    -- four columns here instead of a fourth table.
    importance_acc REAL NOT NULL DEFAULT 0, captures_acc INTEGER NOT NULL DEFAULT 0,
    capture_seq INTEGER NOT NULL DEFAULT 0, last_capture_at INTEGER,
    PRIMARY KEY (agent_id, phase)
  );

  CREATE TABLE dream_candidate (
    candidate_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    -- RULING: NOT NULL, because UNIQUE treats NULLs as distinct and a NULL partition would defeat the dedupe.
    partition TEXT NOT NULL DEFAULT 'agent-private',
    content_hash TEXT NOT NULL,
    source_run_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    recalls INTEGER NOT NULL DEFAULT 0, unique_queries INTEGER NOT NULL DEFAULT 0,
    score REAL, state TEXT NOT NULL,
    decision_json TEXT,
    UNIQUE (agent_id, partition, content_hash)
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null);

export interface StoreOptions { securePath?: (p: string, options?: { mode?: number }) => unknown }

export class DreamStore {
  readonly #db: DatabaseSync;
  readonly path: string;

  constructor(path: string, o: StoreOptions = {}) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      o.securePath?.(dirname(path), { mode: 0o700 }); // a directory needs its execute bit; the default mode is the file one
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#migrate();
    if (path !== ":memory:") o.securePath?.(path);
  }

  close(): void { this.#db.close(); }

  #migrate(): void {
    const current = Number((this.#db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (current > SCHEMA_VERSION) throw new Error(`dream store schema ${current} is newer than this build supports (${SCHEMA_VERSION})`);
    for (let v = current; v < SCHEMA_VERSION; v++) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATIONS[v]!);
        this.#db.exec(`PRAGMA user_version = ${v + 1}`);
        this.#db.exec("COMMIT");
      } catch (e) { this.#db.exec("ROLLBACK"); throw e; }
    }
  }

  get schemaVersion(): number { return Number((this.#db.prepare("PRAGMA user_version").get() as Row).user_version); }

  tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.#db.exec("COMMIT"); return r; } catch (e) { this.#db.exec("ROLLBACK"); throw e; }
  }

  #all(sql: string, ...p: SQLInputValue[]): Row[] { return this.#db.prepare(sql).all(...p) as Row[]; }
  #get(sql: string, ...p: SQLInputValue[]): Row | undefined { return this.#db.prepare(sql).get(...p) as Row | undefined; }
  #run(sql: string, ...p: SQLInputValue[]): number { return Number(this.#db.prepare(sql).run(...p).changes); }

  // ---- schedules ----------------------------------------------------------------------------------------------

  static #toSchedule(r: Row): ScheduleRow {
    return {
      agentId: r.agent_id as string, phase: r.phase as Phase, cron: r.cron as string, timezone: r.timezone as string, enabled: r.enabled === 1,
      staggerOffsetS: Number(r.stagger_offset_s), nextRunAt: num(r.next_run_at), lastRunId: str(r.last_run_id),
      breakerState: r.breaker_state as BreakerState, breakerUntil: num(r.breaker_until), breakerReason: str(r.breaker_reason),
      importanceAcc: Number(r.importance_acc), capturesAcc: Number(r.captures_acc), captureSeq: Number(r.capture_seq), lastCaptureAt: num(r.last_capture_at),
    };
  }

  getSchedule(agentId: string, phase: Phase): ScheduleRow | undefined {
    const r = this.#get("SELECT * FROM dream_schedule WHERE agent_id = ? AND phase = ?", agentId, phase);
    return r ? DreamStore.#toSchedule(r) : undefined;
  }

  listSchedules(agentId?: string): ScheduleRow[] {
    const order = "CASE phase WHEN 'light' THEN 0 WHEN 'rem' THEN 1 ELSE 2 END"; // the phases' own order, not alphabetical
    const rows = agentId === undefined ? this.#all(`SELECT * FROM dream_schedule ORDER BY agent_id, ${order}`) : this.#all(`SELECT * FROM dream_schedule WHERE agent_id = ? ORDER BY ${order}`, agentId);
    return rows.map(DreamStore.#toSchedule);
  }

  /** Inserts the row when absent; an existing row (and the owner's edits on it) is never overwritten. */
  insertScheduleIfAbsent(s: Pick<ScheduleRow, "agentId" | "phase" | "cron" | "timezone" | "enabled" | "staggerOffsetS" | "nextRunAt">): boolean {
    return this.#run(
      "INSERT OR IGNORE INTO dream_schedule (agent_id, phase, cron, timezone, enabled, stagger_offset_s, next_run_at) VALUES (?,?,?,?,?,?,?)",
      s.agentId, s.phase, s.cron, s.timezone, s.enabled ? 1 : 0, s.staggerOffsetS, s.nextRunAt,
    ) > 0;
  }

  updateSchedule(agentId: string, phase: Phase, patch: Partial<Pick<ScheduleRow, "cron" | "timezone" | "enabled" | "staggerOffsetS" | "nextRunAt" | "lastRunId" | "breakerState" | "breakerUntil" | "breakerReason" | "importanceAcc" | "capturesAcc">>): void {
    const cols: Record<string, SQLInputValue> = {};
    if (patch.cron !== undefined) cols.cron = patch.cron;
    if (patch.timezone !== undefined) cols.timezone = patch.timezone;
    if (patch.enabled !== undefined) cols.enabled = patch.enabled ? 1 : 0;
    if (patch.staggerOffsetS !== undefined) cols.stagger_offset_s = patch.staggerOffsetS;
    if (patch.nextRunAt !== undefined) cols.next_run_at = patch.nextRunAt;
    if (patch.lastRunId !== undefined) cols.last_run_id = patch.lastRunId;
    if (patch.breakerState !== undefined) cols.breaker_state = patch.breakerState;
    if (patch.breakerUntil !== undefined) cols.breaker_until = patch.breakerUntil;
    if (patch.breakerReason !== undefined) cols.breaker_reason = patch.breakerReason;
    if (patch.importanceAcc !== undefined) cols.importance_acc = patch.importanceAcc;
    if (patch.capturesAcc !== undefined) cols.captures_acc = patch.capturesAcc;
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    this.#run(`UPDATE dream_schedule SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE agent_id = ? AND phase = ?`, ...keys.map((k) => cols[k]!), agentId, phase);
  }

  /** One capture seen for the agent: advances the digest sequence and both accumulators on all three phase rows. */
  recordCapture(agentId: string, importance: number, now: number): void {
    this.#run(
      "UPDATE dream_schedule SET importance_acc = importance_acc + ?, captures_acc = captures_acc + 1, capture_seq = capture_seq + 1, last_capture_at = ? WHERE agent_id = ?",
      importance, now, agentId,
    );
  }

  // ---- runs ---------------------------------------------------------------------------------------------------

  static #toRun(r: Row): DreamRun {
    const key = r.idempotency_key as string;
    const hash = key.indexOf("#");
    return {
      runId: r.run_id as string, agentId: r.agent_id as string, phase: r.phase as Phase, jobId: r.job_id as string, partition: str(r.partition),
      idempotencyKey: hash < 0 ? key : key.slice(0, hash), claimed: hash < 0,
      trigger: r.trigger as Trigger, scheduledFor: num(r.scheduled_for), startedAt: Number(r.started_at), finishedAt: num(r.finished_at),
      outcome: (str(r.outcome) as Outcome | null), reason: str(r.reason), counts: JSON.parse(r.counts_json as string) as RunCounts,
      tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costMicros: num(r.cost_micros),
      logPath: str(r.log_path), error: r.error_json ? (JSON.parse(r.error_json as string) as DreamRun["error"]) : null,
    };
  }

  /** L15: the row exists, open (outcome NULL), before anything else happens. The key is provisional (`key#runId`) so
   *  that skipped rows can carry it without blocking a rerun; `claimKey` turns it into the blocking one. */
  insertRun(r: { runId: string; agentId: string; phase: Phase; jobId: string; partition: string | null; idempotencyKey: string; trigger: Trigger; scheduledFor: number | null; startedAt: number; logPath: string | null }): void {
    this.#run(
      "INSERT INTO dream_run (run_id, agent_id, phase, job_id, partition, idempotency_key, trigger, scheduled_for, started_at, log_path) VALUES (?,?,?,?,?,?,?,?,?,?)",
      r.runId, r.agentId, r.phase, r.jobId, r.partition, `${r.idempotencyKey}#${r.runId}`, r.trigger, r.scheduledFor, r.startedAt, r.logPath,
    );
  }

  /** The run that holds `key`, if any: a completed run, or one in flight. */
  keyHolder(key: string): string | null { return str(this.#get("SELECT run_id FROM dream_run WHERE idempotency_key = ?", key)?.run_id); }

  /** Atomically takes the key through the UNIQUE constraint. false = someone else holds it (an idempotent rerun). */
  claimKey(runId: string, key: string): boolean {
    try { return this.#run("UPDATE dream_run SET idempotency_key = ? WHERE run_id = ? AND outcome IS NULL", key, runId) > 0; }
    catch (e) { if (/UNIQUE/i.test(String((e as Error).message))) return false; throw e; }
  }

  /** Closes the run. A run that did not complete gives its key back ("a failed run leaves the corpus eligible"). */
  finishRun(runId: string, f: { outcome: Outcome; reason: string | null; finishedAt: number; counts: RunCounts; tokensIn?: number | null; tokensOut?: number | null; costMicros?: number | null; error?: DreamRun["error"] }): void {
    this.tx(() => {
      const cur = this.#get("SELECT idempotency_key FROM dream_run WHERE run_id = ?", runId);
      if (!cur) throw new Error(`unknown dream run ${runId}`);
      const key = cur.idempotency_key as string;
      const hash = key.indexOf("#");
      const base = hash < 0 ? key : key.slice(0, hash);
      const stored = f.outcome === "completed" ? base : `${base}#${f.outcome}:${runId}`;
      this.#run(
        "UPDATE dream_run SET outcome = ?, reason = ?, finished_at = ?, counts_json = ?, tokens_in = ?, tokens_out = ?, cost_micros = ?, error_json = ?, idempotency_key = ? WHERE run_id = ?",
        f.outcome, f.reason, f.finishedAt, JSON.stringify(f.counts), f.tokensIn ?? null, f.tokensOut ?? null, f.costMicros ?? null, f.error ? JSON.stringify(f.error) : null, stored, runId,
      );
    });
  }

  getRun(runId: string): DreamRun | undefined { const r = this.#get("SELECT * FROM dream_run WHERE run_id = ?", runId); return r ? DreamStore.#toRun(r) : undefined; }

  listRuns(q: { agentId?: string; phase?: Phase; since?: number; limit?: number } = {}): DreamRun[] {
    const where: string[] = []; const params: SQLInputValue[] = [];
    if (q.agentId !== undefined) { where.push("agent_id = ?"); params.push(q.agentId); }
    if (q.phase !== undefined) { where.push("phase = ?"); params.push(q.phase); }
    if (q.since !== undefined) { where.push("started_at >= ?"); params.push(q.since); }
    params.push(q.limit ?? 50);
    return this.#all(`SELECT * FROM dream_run ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, rowid DESC LIMIT ?`, ...params).map(DreamStore.#toRun);
  }

  lastRun(agentId: string, phase: Phase): DreamRun | undefined {
    const r = this.#get("SELECT * FROM dream_run WHERE agent_id = ? AND phase = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", agentId, phase);
    return r ? DreamStore.#toRun(r) : undefined;
  }

  /** Retention (ADR-009 Q7): closed rows older than `ledgerBefore` are deleted; of the rest, those older than `logsBefore`
   *  give up their log path (returned, so the caller removes the files). An open run is never touched. */
  prune(ledgerBefore: number, logsBefore: number): { deleted: number; logs: string[] } {
    return this.tx(() => {
      const logs = this.#all("SELECT log_path FROM dream_run WHERE outcome IS NOT NULL AND log_path IS NOT NULL AND started_at < ?", logsBefore).map((r) => r.log_path as string);
      this.#run("UPDATE dream_run SET log_path = NULL WHERE outcome IS NOT NULL AND log_path IS NOT NULL AND started_at < ?", logsBefore);
      const deleted = this.#run("DELETE FROM dream_run WHERE outcome IS NOT NULL AND started_at < ?", ledgerBefore);
      return { deleted, logs };
    });
  }

  /** Runs that never closed: a crash (or a kill) between the opening row and the finish. */
  openRuns(): DreamRun[] { return this.#all("SELECT * FROM dream_run WHERE outcome IS NULL").map(DreamStore.#toRun); }

  /** LLM sessions the agent's rem/deep runs used since `since`, closed runs only (the scheduler adds the in-flight ones). */
  llmSessionsSince(agentId: string, phases: readonly Phase[], since: number): number {
    const marks = phases.map(() => "?").join(",");
    const r = this.#get(`SELECT COALESCE(SUM(CAST(json_extract(counts_json, '$.llmSessions') AS INTEGER)), 0) AS n FROM dream_run WHERE agent_id = ? AND phase IN (${marks}) AND started_at >= ? AND outcome IS NOT NULL`, agentId, ...phases, since);
    return Number(r?.n ?? 0);
  }

  // ---- candidates ---------------------------------------------------------------------------------------------

  static #toCandidate(r: Row): CandidateRow {
    return {
      candidateId: r.candidate_id as string, agentId: r.agent_id as string, partition: r.partition as string, contentHash: r.content_hash as string,
      sourceRunId: r.source_run_id as string, firstSeenAt: Number(r.first_seen_at), expiresAt: Number(r.expires_at), recalls: Number(r.recalls),
      uniqueQueries: Number(r.unique_queries), score: num(r.score), state: r.state as CandidateState, decision: r.decision_json ? JSON.parse(r.decision_json as string) : null,
    };
  }

  /** false when the (agent, partition, content_hash) already exists: the dedupe guard. */
  insertCandidate(c: Omit<CandidateRow, "decision" | "state"> & { state?: CandidateState }): boolean {
    return this.#run(
      "INSERT OR IGNORE INTO dream_candidate (candidate_id, agent_id, partition, content_hash, source_run_id, first_seen_at, expires_at, recalls, unique_queries, score, state) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      c.candidateId, c.agentId, c.partition, c.contentHash, c.sourceRunId, c.firstSeenAt, c.expiresAt, c.recalls, c.uniqueQueries, c.score, c.state ?? "shortlisted",
    ) > 0;
  }

  updateCandidateSignals(agentId: string, partition: string, contentHash: string, s: { recalls: number; uniqueQueries: number; score: number | null }): void {
    this.#run("UPDATE dream_candidate SET recalls = ?, unique_queries = ?, score = ? WHERE agent_id = ? AND partition = ? AND content_hash = ? AND state = 'shortlisted'", s.recalls, s.uniqueQueries, s.score, agentId, partition, contentHash);
  }

  setCandidateState(candidateId: string, state: CandidateState, decision: unknown): void {
    this.#run("UPDATE dream_candidate SET state = ?, decision_json = ? WHERE candidate_id = ?", state, JSON.stringify(decision), candidateId);
  }

  listCandidates(agentId: string, state?: CandidateState): CandidateRow[] {
    const rows = state === undefined ? this.#all("SELECT * FROM dream_candidate WHERE agent_id = ? ORDER BY first_seen_at, candidate_id", agentId) : this.#all("SELECT * FROM dream_candidate WHERE agent_id = ? AND state = ? ORDER BY first_seen_at, candidate_id", agentId, state);
    return rows.map(DreamStore.#toCandidate);
  }

  /** Stale-candidate expiry: whatever is still shortlisted past `expires_at` becomes `expired`, whatever its score. */
  expireCandidates(agentId: string, now: number): number {
    return this.#run(
      "UPDATE dream_candidate SET state = 'expired', decision_json = ? WHERE agent_id = ? AND state = 'shortlisted' AND expires_at <= ?",
      JSON.stringify({ gate: "expiry", passed: false, at: now }), agentId, now,
    );
  }
}
