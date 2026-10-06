// The harness-owned dreaming scheduler (ADR-009). It schedules and guards the engine's jobs and makes every run, skip
// included, visible; it holds no dreaming logic of its own and never registers a host cron (A6).
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { TimerHandle } from "../discovery/ports.ts";
import { contentHash, DEFAULT_GATES, evaluate, type Decision, type GateConfig } from "./candidates.ts";
import { isValidTimezone, nextAfter, parseCron } from "./cron.ts";
import type { DreamStore } from "./store.ts";
import {
  BREAKER_PHASES, BREAKER_SESSIONS, CANDIDATE_TTL_MS, DAY_MS, LEDGER_RETENTION_MS, LOG_RETENTION_MS, MAX_CONCURRENT_RUNS, PHASE_DEFAULTS, PHASES, REASON, STAGGER_WINDOW_S,
  type CandidateSource, type Clock, type DreamEngine, type DreamEvent, type DreamJobRun, type DreamLogger, type DreamRun, type Outcome, type Phase,
  type PhaseDefaults, type RunCounts, type ScheduleRow, type Trigger,
} from "./types.ts";

export interface SchedulerOptions {
  store: DreamStore; engine: DreamEngine; clock: Clock; logger: DreamLogger;
  /** Directory of the per-run logs: `<logsDir>/<agentId>/<phase>/<runId>.log`. */
  logsDir: string;
  agents: () => readonly string[];
  /** RULING (ADR-009 Q4): the timezone a schedule is created with, stored explicitly. Default: the host's IANA zone, else UTC. */
  defaultTimezone?: string;
  breakerSessions?: number; maxConcurrent?: number; staggerWindowS?: number; candidateTtlMs?: number; gates?: GateConfig;
  phases?: { [P in Phase]?: Partial<PhaseDefaults> };
  candidates?: CandidateSource;
  /** Optional pre-check; the engine's own `no_llm_*` skip is mapped to the same reason when absent. */
  llmRoute?: (agentId: string) => boolean | Promise<boolean>;
  /** Phases whose completed run must have written a diary entry (the engine reports it in `JobRun.diary`). */
  requireDiary?: { [P in Phase]?: boolean };
  diaryPath?: (agentId: string) => string | null;
  onEvent?: (e: DreamEvent) => void;
  idFactory?: () => string;
}

export interface PhaseStatus {
  phase: Phase; enabled: boolean; cron: string; timezone: string; staggerOffsetS: number; nextRunAt: number | null; running: boolean;
  lastRun: (DreamRun & { durationMs: number | null }) | null;
  breaker: { state: "closed" | "open"; until: number | null; reason: string | null; sessionsUsed: number; limit: number };
  importance: { accumulated: number; threshold: number; capturesSinceRun: number; minCorpus: number };
}
export interface AgentStatus { agentId: string; phases: PhaseStatus[]; diary: { path: string; exists: boolean; bytes: number } | null }
export interface Counters { runs: Record<string, number>; skips: Record<string, number>; triggers: Record<string, number>; breakerTrips: number; reconciled: number }

class Semaphore {
  #free: number; #waiters: (() => void)[] = [];
  active = 0; peak = 0;
  constructor(n: number) { this.#free = n; }
  async acquire(): Promise<void> {
    if (this.#free > 0) this.#free--; else await new Promise<void>((r) => this.#waiters.push(r));
    this.active++; this.peak = Math.max(this.peak, this.active);
  }
  release(): void { this.active--; const w = this.#waiters.shift(); if (w) w(); else this.#free++; }
}

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // rpc.schema.json $defs/AgentId
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const utcDayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** The scheduling window of a run: the local date for rem/deep, a 4-hour bucket of it for light (ADR-009 Idempotency). */
function windowId(phase: Phase, ms: number, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return phase === "light" ? `${date}T${Math.floor(Number(p.hour) / 4)}` : date;
}

export class DreamScheduler {
  readonly #o: SchedulerOptions;
  readonly #sem: Semaphore;
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #running = new Set<string>(); // `${agent}\0${phase}`
  readonly #openSessions = new Map<string, { agentId: string; n: number }>(); // runId -> sessions used by that open run
  readonly #stop = new AbortController();
  readonly #counters: Counters = { runs: {}, skips: {}, triggers: {}, breakerTrips: 0, reconciled: 0 };
  #timer: TimerHandle | null = null;
  #lastPrune = 0;
  #started = false;
  #stopped = false;

  constructor(o: SchedulerOptions) {
    this.#o = o;
    this.#sem = new Semaphore(o.maxConcurrent ?? MAX_CONCURRENT_RUNS);
  }

  // ---- configuration helpers ----------------------------------------------------------------------------------

  #phase(p: Phase): PhaseDefaults { return { ...PHASE_DEFAULTS[p], ...(this.#o.phases?.[p] ?? {}) }; }
  get #breakerLimit(): number { return this.#o.breakerSessions ?? BREAKER_SESSIONS; }
  get peakConcurrency(): number { return this.#sem.peak; }
  get counters(): Counters { return structuredClone(this.#counters); }
  #emit(e: DreamEvent): void {
    // TODO(D111): emit these as catalogued log-schema events once packages/log-schema is on main; until then the logger line is the record.
    this.#o.logger.info(`dreams ${e.name}`, e);
    try { this.#o.onEvent?.(e); } catch (err) { this.#o.logger.warn("dreams onEvent handler threw", { err: String(err) }); }
  }
  #bump(group: "runs" | "skips" | "triggers", k: string): void { this.#counters[group][k] = (this.#counters[group][k] ?? 0) + 1; }

  /** `hash(agentId, phase) % window` seconds (ADR-009 "stagger"): declarative, stable across restarts. */
  staggerOffsetS(agentId: string, phase: Phase): number {
    const window = this.#o.staggerWindowS ?? STAGGER_WINDOW_S;
    return window <= 0 ? 0 : sha(`${agentId}\0${phase}`).slice(0, 8).split("").reduce((a, c) => (a * 16 + parseInt(c, 16)) % window, 0);
  }

  #computeNext(s: Pick<ScheduleRow, "cron" | "timezone" | "staggerOffsetS">, from: number): number | null {
    const off = s.staggerOffsetS * 1000;
    const base = nextAfter(parseCron(s.cron), s.timezone, from - off);
    return base === null ? null : base + off;
  }

  /** Creates the three schedule rows of every registered agent that has none; never touches an existing row. */
  syncAgents(): void {
    const now = this.#o.clock.now();
    const tz = this.#o.defaultTimezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    for (const agentId of this.#o.agents()) for (const phase of PHASES) {
      if (this.#o.store.getSchedule(agentId, phase)) continue;
      const row = { agentId, phase, cron: this.#phase(phase).cron, timezone: isValidTimezone(tz) ? tz : "UTC", enabled: true, staggerOffsetS: this.staggerOffsetS(agentId, phase), nextRunAt: null as number | null };
      row.nextRunAt = this.#computeNext(row, now);
      this.#o.store.insertScheduleIfAbsent(row);
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------

  /** Reconciles crashed runs (L15's other half), creates schedules, runs one catch-up per phase that missed its window, arms the timer. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.reconcile();
    this.prune();
    this.syncAgents();
    const now = this.#o.clock.now();
    const catchups: Promise<unknown>[] = [];
    for (const s of this.#dueSchedules(now)) {
      this.#o.store.updateSchedule(s.agentId, s.phase, { nextRunAt: this.#computeNext(s, now) });
      catchups.push(this.#launch(s.agentId, s.phase, "catchup", s.nextRunAt));
    }
    this.#arm();
    await Promise.allSettled(catchups);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stop.abort();
    this.#timer?.cancel(); this.#timer = null;
    await this.idle();
  }

  /** Resolves when no run is in flight (tests; also `stop`). */
  async idle(): Promise<void> { while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]); }

  /** Rows that never closed are crashes: closed as `aborted/crashed`, their idempotency keys released. */
  reconcile(): number {
    const now = this.#o.clock.now();
    let n = 0;
    for (const r of this.#o.store.openRuns()) {
      this.#o.store.finishRun(r.runId, { outcome: "aborted", reason: REASON.crashed, finishedAt: now, counts: r.counts, error: { message: "the process stopped before the run finished" } });
      this.#o.store.updateSchedule(r.agentId, r.phase, { lastRunId: r.runId });
      this.#bump("runs", "aborted"); this.#counters.reconciled++; n++;
      this.#emit({ name: "reconciled", agentId: r.agentId, phase: r.phase, runId: r.runId, outcome: "aborted", reason: REASON.crashed });
    }
    return n;
  }

  /** Retention: logs older than 30 days are removed (their rows stay), rows older than 365 days are deleted. */
  prune(): void {
    const now = this.#o.clock.now();
    this.#lastPrune = now;
    try {
      const r = this.#o.store.prune(now - LEDGER_RETENTION_MS, now - LOG_RETENTION_MS);
      for (const f of r.logs) { try { rmSync(f, { force: true }); } catch (e) { this.#o.logger.warn("dreams log removal failed", { file: f, err: String(e) }); } }
      if (r.deleted > 0 || r.logs.length > 0) this.#o.logger.info("dreams retention", { rowsDeleted: r.deleted, logsRemoved: r.logs.length });
    } catch (e) { this.#o.logger.warn("dreams retention failed", { err: String(e) }); }
  }

  // ---- triggers -----------------------------------------------------------------------------------------------

  #dueSchedules(now: number): ScheduleRow[] {
    const known = new Set(this.#o.agents());
    return this.#o.store.listSchedules().filter((s) => s.enabled && known.has(s.agentId) && s.nextRunAt !== null && s.nextRunAt <= now);
  }

  #arm(): void {
    this.#timer?.cancel(); this.#timer = null;
    if (this.#stopped) return;
    const known = new Set(this.#o.agents());
    const times = this.#o.store.listSchedules().filter((s) => s.enabled && known.has(s.agentId) && s.nextRunAt !== null).map((s) => s.nextRunAt!);
    // Re-check at least hourly so agents created later get their schedules without a restart.
    const next = Math.min(...times, this.#o.clock.now() + 3_600_000);
    this.#timer = this.#o.clock.setTimer(() => this.#tick(), Math.max(0, next - this.#o.clock.now()));
  }

  /** The cron floor: every enabled phase whose time has come runs once; time is re-armed before the runs are awaited. */
  async #tick(): Promise<void> {
    if (this.#stopped) return;
    this.syncAgents();
    const now = this.#o.clock.now();
    if (now - this.#lastPrune >= DAY_MS) this.prune();
    for (const agentId of this.#o.agents()) this.#refreshBreaker(agentId, now);
    const runs: Promise<unknown>[] = [];
    for (const s of this.#dueSchedules(now)) {
      this.#o.store.updateSchedule(s.agentId, s.phase, { nextRunAt: this.#computeNext(s, now) });
      runs.push(this.#launch(s.agentId, s.phase, "cron", s.nextRunAt));
    }
    this.#arm();
    await Promise.allSettled(runs);
  }

  /** One capture seen for `agentId`: the importance signal. Fires a phase when its accumulator crosses its threshold. */
  recordCapture(agentId: string, importance = 5): void {
    if (this.#stopped) return;
    const now = this.#o.clock.now();
    this.syncAgents();
    if (!this.#o.agents().includes(agentId)) return;
    this.#o.store.recordCapture(agentId, importance, now);
    for (const phase of PHASES) {
      const s = this.#o.store.getSchedule(agentId, phase);
      if (!s || !s.enabled || this.#running.has(`${agentId}\0${phase}`)) continue;
      const cfg = this.#phase(phase);
      if (s.importanceAcc < cfg.importanceThreshold) continue;
      const last = this.#o.store.lastRun(agentId, phase);
      if (last && now - last.startedAt < cfg.minGapMs) continue;
      this.#emit({ name: "trigger.importance", agentId, phase });
      void this.#launch(agentId, phase, "importance", null);
    }
  }

  #launch(agentId: string, phase: Phase, trigger: Trigger, scheduledFor: number | null): Promise<unknown> {
    const p = this.runPhase(agentId, phase, { trigger, scheduledFor }).catch((e) => { this.#o.logger.error("dreams run crashed outside its guard", { agentId, phase, err: String(e) }); });
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
    return p;
  }

  // ---- the run ------------------------------------------------------------------------------------------------

  #jobsFor(phase: Phase): { name: string; needsLlm: boolean }[] {
    const have = new Map(this.#o.engine.jobs.list().map((j) => [j.name, j]));
    return this.#phase(phase).jobs.flatMap((n) => { const j = have.get(n); return j ? [{ name: n, needsLlm: j.needsLlm }] : []; });
  }

  #key(agentId: string, phase: Phase, sched: ScheduleRow, now: number, partition: string): string {
    // RULING: the transcript digest is the agent's capture sequence until the engine exposes a corpus digest (ADR-009
    // action 6). Same captures + same window = same key; a failed run releases it, so its corpus stays eligible.
    const digest = sha(`${agentId}\0${sched.captureSeq}`);
    return sha([phase, agentId, partition, windowId(phase, now, sched.timezone), digest].join("\0"));
  }

  #sessionsUsed(agentId: string, now: number): number {
    let open = 0;
    for (const o of this.#openSessions.values()) if (o.agentId === agentId) open += o.n;
    return this.#o.store.llmSessionsSince(agentId, [...BREAKER_PHASES], utcDayStart(now)) + open;
  }

  #breakerIsOpen(agentId: string, now: number): boolean {
    this.#refreshBreaker(agentId, now);
    return [...BREAKER_PHASES].some((p) => this.#o.store.getSchedule(agentId, p)?.breakerState === "open");
  }

  #refreshBreaker(agentId: string, now: number): void {
    for (const p of BREAKER_PHASES) {
      const s = this.#o.store.getSchedule(agentId, p);
      if (s?.breakerState === "open" && s.breakerUntil !== null && s.breakerUntil <= now) {
        this.#o.store.updateSchedule(agentId, p, { breakerState: "closed", breakerUntil: null, breakerReason: null });
        this.#emit({ name: "breaker.closed", agentId, phase: p });
      }
    }
  }

  #tripBreaker(agentId: string, now: number, reason: string): void {
    // RULING: open "until the next scheduled window" is read as the sweep boundary (next UTC midnight), the same sweep the
    // engine's own breaker and `dreams status` count in; the session count starts over there.
    const until = utcDayStart(now) + DAY_MS;
    for (const p of BREAKER_PHASES) this.#o.store.updateSchedule(agentId, p, { breakerState: "open", breakerUntil: until, breakerReason: reason });
    this.#counters.breakerTrips++;
    this.#emit({ name: "breaker.opened", agentId, reason });
    this.#o.logger.error("dreams circuit breaker opened", { agentId, reason, until });
  }

  #log(file: string | null, msg: string): void {
    if (!file) return;
    try { appendFileSync(file, `${new Date(this.#o.clock.now()).toISOString()} ${msg}\n`, { mode: 0o600 }); }
    catch (e) { this.#o.logger.warn("dreams run log write failed", { file, err: String(e) }); }
  }

  /** Read-only: what a run would do right now (`dreams run --dry-run`). No ledger row, no engine call. */
  plan(agentId: string, phase: Phase): { wouldRun: boolean; reason: string | null; jobs: string[]; idempotencyKey: string; counts: RunCounts } {
    this.syncAgents();
    const now = this.#o.clock.now();
    const s = this.#o.store.getSchedule(agentId, phase);
    if (!s) throw new Error(`no dream schedule for agent ${agentId}`);
    const jobs = this.#jobsFor(phase);
    const key = this.#key(agentId, phase, s, now, "agent-private");
    const skip = this.#guards(agentId, phase, s, jobs, key, now);
    return { wouldRun: skip === null, reason: skip?.reason ?? null, jobs: jobs.map((j) => j.name), idempotencyKey: key, counts: skip?.counts ?? {} };
  }

  /** The guard chain in its fixed order; the first guard that objects names the skip. Side-effect free. */
  #guards(agentId: string, phase: Phase, s: ScheduleRow, jobs: { name: string }[], key: string, now: number): { reason: string; counts: RunCounts } | null {
    if (this.#o.store.keyHolder(key) !== null) return { reason: REASON.idempotent, counts: {} };
    if (BREAKER_PHASES.has(phase) && this.#breakerIsOpen(agentId, now)) return { reason: REASON.breakerOpen, counts: {} };
    if (jobs.length === 0) return { reason: REASON.noJobs, counts: {} };
    const min = this.#phase(phase).minCorpus;
    if (s.capturesAcc < min) return { reason: REASON.minCorpus, counts: { corpus: s.capturesAcc, minCorpus: min } };
    return null;
  }

  async runPhase(agentId: string, phase: Phase, o: { trigger: Trigger; scheduledFor?: number | null; signal?: AbortSignal }): Promise<DreamRun> {
    // The agent id becomes a path segment of the run log; the registry's ids already match, this keeps the invariant local.
    if (!AGENT_ID.test(agentId)) throw new Error(`invalid agent id: ${agentId}`);
    const store = this.#o.store;
    this.syncAgents();
    const sched = store.getSchedule(agentId, phase);
    if (!sched) throw new Error(`no dream schedule for agent ${agentId}`);
    const now = this.#o.clock.now();
    const runId = (this.#o.idFactory ?? randomUUID)();
    const jobs = this.#jobsFor(phase);
    // RULING (ADR-009 Q5, default "stay private"): M1 dreams the agent-private partition only; workspace/user partitions get no
    // schedule and no diary until the owner asks for a shared one.
    const partition = "agent-private";
    const key = this.#key(agentId, phase, sched, now, partition);
    const logPath = path.join(this.#o.logsDir, agentId, phase, `${runId}.log`);
    let logFile: string | null = logPath;
    try { mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 }); } catch (e) { logFile = null; this.#o.logger.warn("dreams run log dir failed", { err: String(e) }); }

    // L15: the row is written before anything else happens, so a skip is as visible as a completion and a crash is
    // distinguishable from both (outcome stays NULL until `finish`).
    store.insertRun({ runId, agentId, phase, jobId: jobs.find((j) => j.name === this.#phase(phase).primary)?.name ?? this.#phase(phase).primary, partition, idempotencyKey: key, trigger: o.trigger, scheduledFor: o.scheduledFor ?? null, startedAt: now, logPath: logFile });
    this.#bump("triggers", o.trigger);
    this.#emit({ name: "run.started", agentId, phase, runId, trigger: o.trigger });
    this.#log(logFile, `start ${phase} trigger=${o.trigger} key=${key}`);
    const runKey = `${agentId}\0${phase}`;
    let owned = false; // only the run that put the marker up takes it down

    const finish = (outcome: Outcome, reason: string | null, counts: RunCounts, extra: { tokensIn?: number | null; tokensOut?: number | null; costMicros?: number | null; error?: DreamRun["error"]; consumed?: boolean } = {}): DreamRun => {
      const finishedAt = this.#o.clock.now();
      store.finishRun(runId, { outcome, reason, finishedAt, counts, tokensIn: extra.tokensIn ?? null, tokensOut: extra.tokensOut ?? null, costMicros: extra.costMicros ?? null, ...(extra.error ? { error: extra.error } : {}) });
      this.#openSessions.delete(runId);
      if (owned) this.#running.delete(runKey);
      const patch: Parameters<DreamStore["updateSchedule"]>[2] = { lastRunId: runId };
      // Only a completed run consumes the corpus; a skipped, failed or aborted one leaves it eligible for the next window.
      if (outcome === "completed") { patch.importanceAcc = 0; patch.capturesAcc = 0; }
      store.updateSchedule(agentId, phase, patch);
      this.#bump("runs", outcome);
      if (outcome === "skipped" || outcome === "aborted") this.#bump("skips", reason ?? "unknown");
      this.#log(logFile, `finish outcome=${outcome} reason=${reason ?? "-"} counts=${JSON.stringify(counts)}`);
      if (outcome !== "completed") this.#o.logger.warn(`dreams ${phase} run ${outcome}`, { agentId, runId, reason });
      this.#emit({ name: "run.finished", agentId, phase, runId, outcome, reason });
      return store.getRun(runId)!;
    };

    if (this.#running.has(runKey)) return finish("skipped", REASON.alreadyRunning, {});
    this.#running.add(runKey); owned = true;
    try {
      const skip = this.#guards(agentId, phase, sched, jobs, key, now);
      if (skip) return finish("skipped", skip.reason, skip.counts);

      // Candidate guards (inert until a producer is wired, see CandidateSource).
      const cand: RunCounts = {};
      let promotable: { candidateId: string; decision: Decision }[] = [];
      if (this.#o.candidates && (phase === "light" || phase === "deep")) {
        try {
          const r = await this.#ingestCandidates(agentId, runId, now);
          Object.assign(cand, r.counts);
          if (phase === "deep") {
            promotable = r.promotable;
            if (promotable.length === 0) return finish("skipped", REASON.noCandidates, cand);
          }
        } catch (e) { return finish("failed", REASON.engineError, cand, { error: { message: String((e as Error).message ?? e), name: (e as Error).name } }); }
      }

      if (this.#o.llmRoute && jobs.some((j) => j.needsLlm) && !(await this.#o.llmRoute(agentId))) return finish("skipped", REASON.noLlmRoute, cand);
      if (!store.claimKey(runId, key)) return finish("skipped", REASON.idempotent, cand);

      await this.#sem.acquire();
      try {
        return await this.#execute(agentId, phase, runId, jobs, logFile, o.signal, cand, promotable, finish);
      } finally { this.#sem.release(); }
    } catch (e) {
      return finish("failed", REASON.engineError, {}, { error: { message: String((e as Error).message ?? e), name: (e as Error).name } });
    } finally { this.#running.delete(runKey); }
  }

  async #execute(
    agentId: string, phase: Phase, runId: string, jobs: { name: string; needsLlm: boolean }[], logFile: string | null, callerSignal: AbortSignal | undefined,
    counts: RunCounts, promotable: { candidateId: string; decision: Decision }[],
    finish: (o: Outcome, r: string | null, c: RunCounts, x?: { tokensIn?: number | null; tokensOut?: number | null; costMicros?: number | null; error?: DreamRun["error"] }) => DreamRun,
  ): Promise<DreamRun> {
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.#stop.signal]) : this.#stop.signal;
    const primary = this.#phase(phase).primary;
    const results: { job: string; run: DreamJobRun }[] = [];
    let sessions = 0, tokensIn = 0, tokensOut = 0, costMicros: number | null = null, sawTokens = false;
    this.#openSessions.set(runId, { agentId, n: 0 });
    const tally = (): RunCounts => ({ ...counts, jobs: results.length, llmSessions: sessions });
    const usage = () => ({ tokensIn: sawTokens ? tokensIn : null, tokensOut: sawTokens ? tokensOut : null, costMicros });

    for (const j of jobs) {
      if (signal.aborted) return finish("aborted", this.#stop.signal.aborted ? REASON.shutdown : REASON.cancelled, tally(), usage());
      const countsAsSession = j.needsLlm && BREAKER_PHASES.has(phase);
      if (countsAsSession && this.#sessionsUsed(agentId, this.#o.clock.now()) >= this.#breakerLimit) {
        this.#tripBreaker(agentId, this.#o.clock.now(), REASON.breakerSessions);
        this.#log(logFile, `breaker: ${this.#breakerLimit} LLM sessions used in this sweep; ${j.name} not run`);
        return finish("aborted", REASON.breakerSessions, tally(), usage());
      }
      this.#log(logFile, `job ${j.name} start`);
      let r: DreamJobRun;
      try { r = await this.#o.engine.jobs.run(j.name, agentId, { signal, trigger: "harness" }); }
      catch (e) {
        this.#log(logFile, `job ${j.name} threw: ${String(e)}`);
        return finish("failed", REASON.engineError, tally(), { ...usage(), error: { message: String((e as Error).message ?? e), name: (e as Error).name } });
      }
      results.push({ job: j.name, run: r });
      if (countsAsSession && r.outcome !== "skipped") { sessions++; this.#openSessions.set(runId, { agentId, n: sessions }); }
      if (r.cost?.inputTokens !== undefined || r.cost?.outputTokens !== undefined) { sawTokens = true; tokensIn += r.cost?.inputTokens ?? 0; tokensOut += r.cost?.outputTokens ?? 0; }
      if (typeof r.cost?.costMicros === "number") costMicros = (costMicros ?? 0) + r.cost.costMicros; // RULING: cost is measured in tokens; micros stay NULL until a price table exists.
      this.#log(logFile, `job ${j.name} ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`);
      if (r.outcome === "failed" || r.outcome === "incomplete" || r.outcome === "abandoned") {
        return finish("failed", r.outcome === "failed" ? (r.reason ?? REASON.engineError) : `${REASON.incomplete}:${r.reason ?? r.outcome}`, tally(), usage());
      }
    }

    // The primary job decides the outcome: a phase whose main job skipped is skipped, never "completed" (causes 5, 7).
    const main = results.find((x) => x.job === primary)?.run ?? results[0]?.run;
    if (main?.outcome === "skipped") {
      const reason = main.reason ?? "skipped";
      return finish("skipped", /^no_llm/.test(reason) ? REASON.noLlmRoute : reason, tally(), usage());
    }
    // RULING: only a diary the engine reports as not written fails the run; `requireDiary` (off by default) also demands one,
    // because the pinned engine's consolidate-daily reports none (TODO(engine): one guaranteed diary entry per deep sweep, C1).
    // A diary the engine says it could not write is a failure, not a footnote (causes 7, 11; A2 variant).
    const badDiary = results.find((x) => x.run.diary && x.run.diary.written === false);
    if (badDiary || (this.#o.requireDiary?.[phase] && !results.some((x) => x.run.diary?.written === true))) {
      const why = badDiary?.run.diary?.reason ?? "no diary entry reported";
      return finish("failed", REASON.diaryNotWritten, tally(), { ...usage(), error: { message: `diary not written: ${why}` } });
    }
    // Deep promotions are recorded only now, after the engine's run completed.
    if (promotable.length > 0) {
      for (const p of promotable) this.#o.store.setCandidateState(p.candidateId, "promoted", p.decision);
      counts.promoted = promotable.length;
    }
    return finish("completed", null, tally(), usage());
  }

  /** Pull, dedupe, expire and gate: the candidate guards. Returns the ones the utility gate lets a deep run consider. */
  async #ingestCandidates(agentId: string, runId: string, now: number): Promise<{ counts: RunCounts; promotable: { candidateId: string; decision: Decision }[] }> {
    const store = this.#o.store;
    const gates = this.#o.gates ?? DEFAULT_GATES;
    const counts: RunCounts = { candidates: 0, deduped: 0 };
    for (const c of await this.#o.candidates!.pull(agentId)) {
      const partition = c.partition ?? "agent-private";
      const hash = contentHash(c.content);
      const inserted = store.insertCandidate({
        candidateId: randomUUID(), agentId, partition, contentHash: hash, sourceRunId: runId, firstSeenAt: now, expiresAt: now + (this.#o.candidateTtlMs ?? CANDIDATE_TTL_MS),
        recalls: c.recalls ?? 0, uniqueQueries: c.uniqueQueries ?? 0, score: c.score ?? null,
      });
      if (inserted) counts.candidates!++;
      else { counts.deduped!++; store.updateCandidateSignals(agentId, partition, hash, { recalls: c.recalls ?? 0, uniqueQueries: c.uniqueQueries ?? 0, score: c.score ?? null }); }
    }
    counts.expired = store.expireCandidates(agentId, now);
    const promotable: { candidateId: string; decision: Decision }[] = [];
    let rejected = 0;
    for (const c of store.listCandidates(agentId, "shortlisted")) {
      const d = evaluate(c, now, gates);
      if (d.promote) promotable.push({ candidateId: c.candidateId, decision: d });
      // RULING: a candidate that fails a gate is not "rejected" (that state is for an owner/engine decision); it stays shortlisted
      // with the gate-by-gate record and may still gain recalls until it expires.
      else { rejected++; store.setCandidateState(c.candidateId, "shortlisted", d); } // stays eligible to gain recalls until it expires; the decision records the gate
    }
    counts.rejected = rejected;
    return { counts, promotable };
  }

  // ---- surface ------------------------------------------------------------------------------------------------

  status(agentId?: string): { agents: AgentStatus[]; counters: Counters; schemaVersion: number } {
    this.syncAgents();
    const now = this.#o.clock.now();
    const ids = agentId !== undefined ? [agentId] : [...this.#o.agents()];
    const agents = ids.map((id) => {
      this.#refreshBreaker(id, now);
      const phases: PhaseStatus[] = PHASES.flatMap((phase) => {
        const s = this.#o.store.getSchedule(id, phase);
        if (!s) return [];
        const last = this.#o.store.lastRun(id, phase);
        const cfg = this.#phase(phase);
        return [{
          phase, enabled: s.enabled, cron: s.cron, timezone: s.timezone, staggerOffsetS: s.staggerOffsetS, nextRunAt: s.enabled ? s.nextRunAt : null, running: this.#running.has(`${id}\0${phase}`),
          lastRun: last ? { ...last, durationMs: last.finishedAt === null ? null : Math.max(0, last.finishedAt - last.startedAt) } : null,
          breaker: { state: s.breakerState, until: s.breakerUntil, reason: s.breakerReason, sessionsUsed: this.#sessionsUsed(id, now), limit: this.#breakerLimit },
          importance: { accumulated: s.importanceAcc, threshold: cfg.importanceThreshold, capturesSinceRun: s.capturesAcc, minCorpus: cfg.minCorpus },
        }];
      });
      const dp = this.#o.diaryPath?.(id) ?? null;
      let diary: AgentStatus["diary"] = null;
      if (dp) { let bytes = 0; try { bytes = existsSync(dp) ? statSync(dp).size : 0; } catch { /* unreadable = absent */ } diary = { path: dp, exists: bytes > 0, bytes }; }
      return { agentId: id, phases, diary };
    });
    return { agents, counters: this.counters, schemaVersion: this.#o.store.schemaVersion };
  }

  log(q: { agentId?: string; phase?: Phase; runId?: string; limit?: number }): { runs: DreamRun[]; log?: string } {
    if (q.runId !== undefined) {
      const r = this.#o.store.getRun(q.runId);
      if (!r) return { runs: [] };
      let text: string | undefined;
      if (r.logPath) { try { text = readFileSync(r.logPath, "utf8").slice(-262_144); } catch { text = undefined; } }
      return { runs: [r], ...(text !== undefined ? { log: text } : {}) };
    }
    return { runs: this.#o.store.listRuns({ ...(q.agentId !== undefined ? { agentId: q.agentId } : {}), ...(q.phase !== undefined ? { phase: q.phase } : {}), limit: q.limit ?? 20 }) };
  }

  getSchedules(agentId: string): ScheduleRow[] { this.syncAgents(); return this.#o.store.listSchedules(agentId); }

  /** Edits one phase's schedule. Invalid cron or timezone throws before anything is written. */
  setSchedule(agentId: string, phase: Phase, patch: { cron?: string; timezone?: string; enabled?: boolean }): ScheduleRow {
    this.syncAgents();
    const cur = this.#o.store.getSchedule(agentId, phase);
    if (!cur) throw new Error(`no dream schedule for agent ${agentId}`);
    if (patch.cron !== undefined) parseCron(patch.cron);
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) throw new Error(`invalid timezone: ${patch.timezone}`);
    const next = { ...cur, ...(patch.cron !== undefined ? { cron: patch.cron } : {}), ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}) };
    const changed = patch.cron !== undefined || patch.timezone !== undefined || (patch.enabled === true && !cur.enabled);
    this.#o.store.updateSchedule(agentId, phase, {
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}), ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      // Re-enabling or re-timing recomputes from now: no burst of "missed" runs from the time it was off.
      ...(changed ? { nextRunAt: this.#computeNext(next, this.#o.clock.now()) } : {}),
    });
    if (this.#started && !this.#stopped) this.#arm();
    return this.#o.store.getSchedule(agentId, phase)!;
  }
}
