// The re-embedding migration driver (M2 acceptance 6): plan → run (batches, throttled, abortable, resumable) → switch,
// over the narrow engine port (port.ts) with the Harness checkpoint (state.ts). The engine owns the data path and its own
// record; the driver owns orchestration: which migration is ours, throttling, abort at batch boundaries, fail-closed
// validation, and the Harness half of the switch. Nothing here touches the active generation before `switch()`.
import { randomBytes } from "node:crypto";
import { checkTarget, fingerprintIdOf, probeCompatibility, type EmbeddingFingerprint, type ProbeResult } from "./probe.ts";
import type { EngineRecord, ReembedEngine, SwitchPort } from "./port.ts";
import { MigrationStateError, TERMINAL, type Checkpoint, type Phase, type StateStore } from "./state.ts";
import type { PrivacyAcknowledgment } from "@plur1bus/config-schema";
import { OPENAI_DEFAULT_ENDPOINT } from "../composition/embedding-policy.ts";
import { redactEndpoint } from "../privacy/local-only.ts";

export type MigrationErrorCode =
  | "migration-active" | "migration-running" | "no-migration" | "not-runnable" | "not-abortable" | "not-ready-to-switch"
  | "plan-refused" | "switch-unavailable" | "switch-failed" | "state-corrupt" | "state-unreadable";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string) { super(message); this.name = "MigrationError"; this.code = code; }
}

/** The checkpoint as callers see it: the confirmation token never leaves the driver, the stored plan answer stays its own. */
export type PublicCheckpoint = Omit<Checkpoint, "token" | "expiresAt" | "plan">;
export const publicView = (c: Checkpoint): PublicCheckpoint => { const { token: _t, expiresAt: _e, plan: _p, ...rest } = c; return rest; };

export interface PlanSummary {
  id: string; sourceGeneration: string; targetGeneration: string;
  rows: number; tables: number; batches: number; batchSize: number; providerCalls: number;
  sourceBytes: number; targetBytes: number; requiredFreeBytes: number; freeBytes: number;
  throttleMs: number;
  /** The pauses alone (batches × throttle); provider time comes on top. */
  minDurationMs: number;
  probeStatus: string;
  /** A cloud or self-hosted target only: what leaves this machine and how many tokens it takes. */
  cloud?: CloudEstimate;
}
/**
 * Every card text goes to the provider. Tokens are estimated from the source size without its vectors (bytes / 4), an
 * upper bound since metadata is counted too. There is no cost estimate: the budget counts tokens (owner 2026-10-19).
 */
export interface CloudEstimate { provider: string; model: string; endpoint: string; cards: number; estimatedTokens: number; sendsText: true }
export interface PlanOutcome { probe: ProbeResult; plan: PlanSummary | null }
export interface StatusView {
  checkpoint: PublicCheckpoint | null;
  /** The engine's own state for this migration; null when it has none or cannot be asked. */
  engineState: string | null;
  running: boolean;
  progress: { rows: number; rowsDone: number; batches: number; batchesDone: number; percent: number };
}

export interface DriverDeps {
  engine: ReembedEngine;
  store: StateStore;
  /** Null: this core cannot write the active selection (no supervisor), so `switch` is refused. */
  switchPort: SwitchPort | null;
  now?: () => number;
  /** Test seam: the pause between batches; must reject or return early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  newId?: () => string;
  logger?: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
  /** The call budget for a remote target, asked before every batch; null/absent: no budget is configured. */
  budget?: () => BatchBudget | null;
  /** Retry of a batch that failed with a rate limit or a transient provider error (429, 5xx, network), with backoff. */
  retry?: RetryOptions;
  /** Re-checks a remote target before a run starts (privacy.localOnly, acknowledgment, egress may have changed since the plan). */
  admitRun?: (c: PublicCheckpoint) => Promise<void> | void;
}

export interface BatchTicket { settle(tokens: number): void; release(): void }
export interface BatchBudget { admit(a: { provider: string; model: string; estimatedTokens: number }): { ok: true; ticket: BatchTicket } | { ok: false; message: string } }
export interface RetryOptions { attempts?: number; baseMs?: number; maxMs?: number }
export const DEFAULT_RETRY: Required<RetryOptions> = { attempts: 4, baseMs: 1000, maxMs: 30_000 };
/** A provider answer worth waiting for: rate limit, overload, a 5xx or a network failure. Never drift or a bad token. */
export const retryable = (message: string): boolean =>
  /\b429\b|rate.?limit|too many requests|\b5(?:0\d|2\d)\b|overloaded|temporarily unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message);

export interface PlanRequest {
  target: EmbeddingFingerprint;
  /** A cloud or self-hosted target: where its key lives (env var name) and the endpoint as configured. */
  remote?: { apiKeyEnv: string; baseUrl?: string; privacyAck?: PrivacyAcknowledgment };
  throttleMs?: number; targetGeneration?: string;
}

export interface MigrationDriver {
  plan(req: PlanRequest): Promise<PlanOutcome>;
  /** Validates, marks the run started and returns; the loop continues in the background and `done` settles when it ends. */
  start(): Promise<{ checkpoint: PublicCheckpoint; done: Promise<PublicCheckpoint> }>;
  run(): Promise<PublicCheckpoint>;
  status(): Promise<StatusView>;
  abort(): Promise<PublicCheckpoint>;
  switch(): Promise<PublicCheckpoint>;
  /** The core is stopping: ends an in-flight run at its next batch boundary (phase aborted, resumable) and waits up to `waitMs`. */
  stop(waitMs: number): Promise<void>;
}

export const DEFAULT_THROTTLE_MS = 250;
export const MAX_THROTTLE_MS = 60_000;
/** The engine's maximum confirmation lifetime (planner.js): plan → run in a normal workflow must not race the TTL. */
const CONFIRMATION_TTL_MS = 60 * 60 * 1000;
/** Engine states after which its record no longer blocks a new plan. */
const ENGINE_TERMINAL: readonly string[] = ["completed", "failed", "rolled_back"];

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted || ms <= 0) return resolve();
  const t = setTimeout(done, ms); const onAbort = () => done();
  function done() { clearTimeout(t); signal.removeEventListener("abort", onAbort); resolve(); }
  signal.addEventListener("abort", onAbort, { once: true });
});

/** Engine error text → a stable code and whether the migration can go on. Drift and a bad confirmation are final for
 *  this migration (a new plan is needed); anything else is treated as transient: the run halts and can be resumed. */
function classify(e: unknown): { code: string; message: string; final: boolean } {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  if (/source (generation|config revision|version) drift|workspace policy changed/.test(message)) return { code: "source-drift", message, final: true };
  if (/invalid or expired reembedding confirmation/.test(message)) return { code: "confirmation-invalid", message, final: true };
  return { code: "engine-error", message, final: false };
}

export function createMigrationDriver(d: DriverDeps): MigrationDriver {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? defaultSleep;
  const newId = d.newId ?? (() => `reembed-${now()}-${randomBytes(4).toString("hex")}`);
  let loop: { done: Promise<Checkpoint>; ac: AbortController } | null = null;
  /** A plan or a switch in flight: both await outside the loop and must not interleave with each other, a start or an abort. */
  let busy: "plan" | "switch" | null = null;

  const read = (): Checkpoint | null => {
    try { return d.store.read(); } catch (e) {
      if (e instanceof MigrationStateError) throw new MigrationError(e.code === "state-corrupt" ? "state-corrupt" : "state-unreadable", e.message);
      throw e;
    }
  };
  /** A checkpoint write that fails is a storage error with a stable code, never a raw exception (and never a path). */
  const put = (c: Checkpoint): void => {
    try { d.store.write(c); } catch (e) {
      if (e instanceof MigrationStateError && e.code === "state-corrupt") throw new MigrationError("state-corrupt", e.message);
      throw new MigrationError("state-unreadable", "migration checkpoint cannot be written");
    }
  };
  const save = (c: Checkpoint, patch: Partial<Checkpoint>): Checkpoint => { const next = { ...c, ...patch, updatedAt: now() }; put(next); return next; };
  /** Same vector space as far as the checkpoint is concerned: provider, model and dimensions. */
  const sameSpace = (a: EmbeddingFingerprint, b: EmbeddingFingerprint) => a.provider === b.provider && a.model === b.model && a.dimensions === b.dimensions;

  const batchesOf = (tables: { rowCount: number }[]) => tables.reduce((s, t) => s + Math.ceil(t.rowCount / d.engine.batchSize), 0);

  async function plan(req: PlanRequest): Promise<PlanOutcome> {
    const throttleMs = req.throttleMs ?? DEFAULT_THROTTLE_MS;
    if (!Number.isSafeInteger(throttleMs) || throttleMs < 0 || throttleMs > MAX_THROTTLE_MS) throw new MigrationError("plan-refused", `throttleMs must be an integer between 0 and ${MAX_THROTTLE_MS}`);
    if (loop) throw new MigrationError("migration-running", "a re-embedding run is in progress; stop it with --abort first");
    if (busy) throw new MigrationError("migration-active", `a ${busy} is already in progress`);
    busy = "plan";
    try { return await planLocked(req, throttleMs); } finally { busy = null; }
  }

  /**
   * The engine keeps an unconfirmed plan (and refuses every other one) until its confirmation expires; it has no call to
   * retire it earlier. So a plan that never started is not replaced while it lives: the same target again (a dry run,
   * then the apply) is answered from it, another target is refused with its expiry. Once it expired the next plan
   * replaces it (the engine retires the expired record itself).
   */
  async function planLocked(req: PlanRequest, throttleMs: number): Promise<PlanOutcome> {
    const existing = read();
    const held = existing && !TERMINAL.includes(existing.phase) ? await heldPlan(existing) : null;
    const refused = checkTarget(req.target);
    if (refused) return { probe: refused, plan: null };
    if (held) {
      const expiresAt = held.expiresAt ?? held.createdAt + CONFIRMATION_TTL_MS;
      if (now() < expiresAt) {
        if (samePlan(held, req) && held.plan) return reuse(held, req, throttleMs);
        throw new MigrationError("migration-active", `migration ${held.id} is planned for ${held.target.provider} ${held.target.model} and holds the store until ${new Date(expiresAt).toISOString()}; `
          + "run it with plur1bus memory reembed --run, or plan another model after that time (memory reembed --abort does not release an unstarted plan earlier)");
      }
    }

    const id = newId();
    const asked = now();
    let enginePlan;
    try {
      const secretRef = req.remote ? { secretRef: { source: "env" as const, provider: "default" as const, id: req.remote.apiKeyEnv } } : {};
      enginePlan = await d.engine.plan({ id, target: { fingerprint: req.target, ...secretRef }, ...(req.targetGeneration ? { targetGeneration: req.targetGeneration } : {}), confirmationTtlMs: CONFIRMATION_TTL_MS });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/does not change the embedding fingerprint/.test(message)) {
        // The engine's own comparison: the store already has this identity. Nothing to migrate.
        return { probe: probeCompatibility({ stored: req.target, target: req.target }), plan: null };
      }
      if ((e as { code?: unknown }).code === "reembedding_active_conflict" || /another reembedding migration is active/.test(message)) {
        // An engine record no live checkpoint holds: a run that failed here (source drift) leaves its record running in the
        // engine, which retires it only once its confirmation expired; a lost checkpoint leaves an unknown one.
        const until = existing?.phase === "failed" ? existing.expiresAt ?? existing.createdAt + CONFIRMATION_TTL_MS : null;
        const when = until !== null && until > now() ? `until ${new Date(until).toISOString()}` : "until its confirmation expires, at most an hour after it was planned";
        throw new MigrationError("migration-active", `the engine still holds an unfinished re-embedding migration (an unconfirmed plan or a run that stopped) ${when}; plan again after that time (plur1bus memory reembed --status shows the last one)`);
      }
      throw new MigrationError("plan-refused", message.slice(0, 500));
    }
    const p = enginePlan.plan;
    // The engine must have planned the target that was asked for: a different model or dimension count here would copy the
    // store into a vector space the checkpoint (and the later switch) does not describe.
    if (!sameSpace(p.target.fingerprint, req.target)) throw new MigrationError("plan-refused", "the engine planned a different target embedding (provider, model or dimensions) than the one requested; nothing was started");
    const batches = batchesOf(p.source.tables);
    let remote: Checkpoint["remote"];
    if (req.remote) {
      const rows = p.estimates.rows;
      remote = { apiKeyEnv: req.remote.apiKeyEnv, ...(req.remote.baseUrl !== undefined ? { baseUrl: req.remote.baseUrl } : {}), ...(req.remote.privacyAck ? { privacyAck: req.remote.privacyAck } : {}), tokensPerRow: rows === 0 ? 0 : Math.max(1, Math.ceil(tokensOf(p.estimates.sourceBytes, rows, p.source.fingerprint) / rows)) };
    }
    const { rows: _rows, ...estimates } = p.estimates;
    const cp: Checkpoint = {
      v: 1, id: p.id, token: enginePlan.confirmation.token, planDigest: enginePlan.planDigest, createdAt: now(), updatedAt: now(), phase: "planned",
      sourceGeneration: p.source.generation, targetGeneration: p.target.generation, target: req.target,
      counts: { rows: p.estimates.rows, tables: p.source.tables.length, batches, rowsDone: 0, batchesDone: 0 },
      throttleMs, abortRequested: false, error: null, ...(remote ? { remote } : {}),
      // The engine's own expiry; else the earliest it can be (the engine took its time after `asked`).
      expiresAt: enginePlan.confirmation.expiresAt ?? asked + CONFIRMATION_TTL_MS,
      plan: { sourceFingerprint: p.source.fingerprint, probeStatus: p.target.probeStatus, estimates },
    };
    put(cp);
    d.logger?.info("re-embedding planned", { id: p.id, rows: cp.counts.rows, batches });
    return outcomeOf(cp);
  }

  /**
   * The unstarted plan `c` holds in the engine, or null when its engine record no longer blocks a new plan. Throws
   * migration-active for a migration that has started (anything may have been copied): finish or stop it first.
   */
  async function heldPlan(c: Checkpoint): Promise<Checkpoint | null> {
    const started = () => new MigrationError("migration-active", `migration ${c.id} is ${c.phase}; finish it with --run or stop it with --abort first`);
    // An abort before the first batch leaves the plan unstarted, like one that was never run.
    if (c.phase !== "planned" && !(c.phase === "aborted" && c.counts.batchesDone === 0 && c.counts.rowsDone === 0)) throw started();
    const state = (await d.engine.status(c.id))?.state ?? null;
    if (state === null || ENGINE_TERMINAL.includes(state)) return null;
    if (state !== "planned") throw started();
    return c;
  }

  /** The same request as the one `c` planned: one vector space (the engine's fingerprint id), one key, one endpoint, one generation. */
  const samePlan = (c: Checkpoint, req: PlanRequest): boolean => {
    const id = fingerprintIdOf(req.target);
    return id !== null && id === fingerprintIdOf(c.target)
      && (c.remote?.apiKeyEnv ?? null) === (req.remote?.apiKeyEnv ?? null) && (c.remote?.baseUrl ?? null) === (req.remote?.baseUrl ?? null)
      && (!req.targetGeneration || req.targetGeneration === c.targetGeneration); // an empty one is absent, as for the engine
  };

  /** Answers the held plan again. Only Harness-side settings change: the pause between batches and a fresh privacy acknowledgment. */
  function reuse(c: Checkpoint, req: PlanRequest, throttleMs: number): PlanOutcome {
    const ack = req.remote?.privacyAck;
    const next = save(c, { phase: "planned", throttleMs, abortRequested: false, error: null, ...(ack && c.remote ? { remote: { ...c.remote, privacyAck: ack } } : {}) });
    d.logger?.info("re-embedding plan reused", { id: c.id });
    return outcomeOf(next);
  }

  /** Estimated provider tokens: the source size without its vectors, bytes / 4 (an upper bound, metadata counts too). */
  const tokensOf = (sourceBytes: number, rows: number, source: EmbeddingFingerprint): number => Math.ceil(Math.max(0, sourceBytes - rows * (source.dimensions ?? 0) * 4) / 4);

  /** The plan answer, entirely from the checkpoint: planning the same target again answers exactly what the first plan did. */
  function outcomeOf(c: Checkpoint): PlanOutcome {
    const p = c.plan!;
    const probe = probeCompatibility({
      stored: p.sourceFingerprint, target: c.target,
      targetProbe: { ok: p.probeStatus === "passed" || p.probeStatus === "probe_deferred_local_artifact" },
    });
    const rows = c.counts.rows; const e = p.estimates;
    const cloud: CloudEstimate | undefined = c.remote
      ? { provider: c.target.provider, model: c.target.model, endpoint: redactEndpoint(c.remote.baseUrl ?? c.target.endpoint ?? OPENAI_DEFAULT_ENDPOINT), cards: rows, estimatedTokens: tokensOf(e.sourceBytes, rows, p.sourceFingerprint), sendsText: true }
      : undefined;
    return {
      probe,
      plan: {
        id: c.id, sourceGeneration: c.sourceGeneration, targetGeneration: c.targetGeneration, rows, tables: c.counts.tables,
        batches: c.counts.batches, batchSize: d.engine.batchSize, providerCalls: e.providerCalls, sourceBytes: e.sourceBytes, targetBytes: e.targetBytes,
        requiredFreeBytes: e.requiredFreeBytes, freeBytes: e.freeBytes, throttleMs: c.throttleMs, minDurationMs: c.counts.batches * c.throttleMs, probeStatus: p.probeStatus,
        ...(cloud ? { cloud } : {}),
      },
    };
  }

  /** Applies the engine's record to the checkpoint's counters. */
  const track = (c: Checkpoint, rec: EngineRecord, batchRan: boolean): Checkpoint =>
    save(c, { counts: { ...c.counts, rowsDone: rec.cursor.completedRows, batchesDone: Math.max(c.counts.batchesDone + (batchRan ? 1 : 0), Math.min(batchesBefore(rec), c.counts.batches)) } });
  /** Batches the engine's cursor says are behind it: a count that survives a restart which lost the last checkpoint write. */
  const batchesBefore = (rec: EngineRecord): number => {
    const bs = d.engine.batchSize; const ts = rec.source.tables;
    let n = 0;
    for (let i = 0; i < Math.min(rec.cursor.tableIndex, ts.length); i++) n += Math.ceil(ts[i]!.rowCount / bs);
    if (rec.cursor.tableIndex < ts.length) n += Math.ceil(rec.cursor.offset / bs);
    return n;
  };

  const retry = { ...DEFAULT_RETRY, ...d.retry };
  /**
   * One engine batch for this checkpoint. A remote target first reserves its estimated tokens in the call budget (a hard
   * limit pauses the run: phase aborted with error budget-exceeded, resumable with --run once the limit allows it), and a
   * rate limit or transient provider error is retried with exponential backoff before the run halts (resumable too).
   */
  async function oneBatch(c: Checkpoint, rec: EngineRecord, signal: AbortSignal): Promise<{ kind: "ok"; rec: EngineRecord } | { kind: "stopped"; error: Checkpoint["error"] }> {
    const remote = c.remote;
    const rowsLeft = Math.max(0, c.counts.rows - c.counts.rowsDone);
    const estimate = remote ? Math.max(1, Math.min(d.engine.batchSize, rowsLeft || d.engine.batchSize) * Math.max(1, remote.tokensPerRow)) : 0;
    let state = rec.state;
    for (let attempt = 0; ; attempt++) {
      const budget = remote ? d.budget?.() ?? null : null;
      const admitted = budget ? budget.admit({ provider: c.target.provider, model: c.target.model, estimatedTokens: estimate }) : null;
      if (admitted && !admitted.ok) return { kind: "stopped", error: { code: "budget-exceeded", message: `the call budget refuses the next batch (${admitted.message}); the run is paused and continues with --run once the budget allows it` } };
      const ticket = admitted?.ok ? admitted.ticket : null;
      try {
        const next = state === "running" ? await d.engine.resume({ id: c.id, token: c.token }) : await d.engine.apply({ id: c.id, token: c.token });
        ticket?.settle(estimate);
        return { kind: "ok", rec: next };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const again = !classify(e).final && retryable(message) && attempt < retry.attempts;
        // A refused or rate-limited request is not billed; any other failure may have been, so it is settled.
        if (ticket) { if (retryable(message)) ticket.release(); else ticket.settle(estimate); }
        if (!again) throw e;
        const wait = Math.min(retry.maxMs, retry.baseMs * 2 ** attempt);
        d.logger?.warn("re-embedding batch retried", { id: c.id, attempt: attempt + 1, waitMs: wait });
        await sleep(wait, signal);
        if (signal.aborted) return { kind: "stopped", error: null };
        // apply moves a planned migration to running before its batch; a retry continues it
        state = (await d.engine.status(c.id))?.state ?? state;
      }
    }
  }

  async function body(initial: Checkpoint, signal: AbortSignal): Promise<Checkpoint> {
    let c = initial;
    const stop = (phase: Phase, error: Checkpoint["error"] = null) => save(c, { phase, error, abortRequested: false });
    try {
      let rec = await d.engine.status(c.id);
      if (!rec) return stop("failed", { code: "engine-record-missing", message: "the engine has no record of this migration; plan again" });
      while (rec.state === "planned" || rec.state === "confirmed" || rec.state === "running") {
        if (signal.aborted) return stop("aborted");
        const before = rec.cursor;
        const batch = await oneBatch(c, rec, signal);
        if (batch.kind === "stopped") return stop("aborted", batch.error);
        rec = batch.rec;
        c = track(c, rec, true);
        // Every batch moves the cursor; one that does not would repeat for ever (each pass costs provider calls).
        if (rec.state === "running" && rec.cursor.tableIndex === before.tableIndex && rec.cursor.offset === before.offset && rec.cursor.completedRows === before.completedRows) {
          throw new Error("the engine made no progress in a batch; halting so the run can be resumed");
        }
        if (rec.state === "running") {
          if (signal.aborted) return stop("aborted");
          await sleep(c.throttleMs, signal);
        }
      }
      if (rec.state === "failed") return stop("failed", { code: rec.error?.code ?? "engine-failed", message: "the engine marked the migration failed" });
      if (rec.state === "switching" || rec.state === "completed") return stop("switched");
      if (rec.state === "validating") {
        if (!d.engine.validate) {
          return stop("validating", { code: "engine-validate-unavailable", message: "the engine does not expose generation validation, so the copied generation cannot be switched yet" });
        }
        rec = await d.engine.validate({ id: c.id });
        c = track(c, rec, false);
      }
      if (rec.state === "ready_to_switch") return stop("ready-to-switch");
      return stop("failed", { code: "engine-state-unexpected", message: `unexpected engine state ${rec.state}` });
    } catch (e) {
      const k = classify(e);
      d.logger?.warn("re-embedding run halted", { id: c.id, code: k.code });
      return save(c, { phase: k.final ? "failed" : "aborted", error: { code: k.code, message: k.message }, abortRequested: false });
    }
  }

  async function start() {
    if (loop) throw new MigrationError("migration-running", "a re-embedding run is already in progress");
    if (busy) throw new MigrationError("migration-active", `a ${busy} is in progress; wait for it to finish`);
    const c = read();
    if (!c) throw new MigrationError("no-migration", "no re-embedding migration is planned (plan one first)");
    if (!["planned", "running", "aborted", "validating"].includes(c.phase)) throw new MigrationError("not-runnable", `migration ${c.id} is ${c.phase}; there is nothing to run`);
    if (c.remote) await d.admitRun?.(publicView(c)); // throws the provider rule's refusal; nothing is changed
    const started = save(c, { phase: "running", abortRequested: false, error: null });
    const ac = new AbortController();
    const done = body(started, ac.signal).finally(() => { loop = null; });
    loop = { done, ac };
    return { checkpoint: publicView(started), done: done.then(publicView) };
  }

  async function status(): Promise<StatusView> {
    const c = read();
    let engineState: string | null = null;
    if (c) { try { engineState = (await d.engine.status(c.id))?.state ?? null; } catch { engineState = null; } }
    const k = c?.counts ?? { rows: 0, rowsDone: 0, batches: 0, batchesDone: 0 };
    return { checkpoint: c ? publicView(c) : null, engineState, running: loop !== null, progress: { rows: k.rows, rowsDone: k.rowsDone, batches: k.batches, batchesDone: k.batchesDone, percent: k.rows === 0 ? 0 : Math.min(100, Math.floor((k.rowsDone * 100) / k.rows)) } };
  }

  async function abort(): Promise<PublicCheckpoint> {
    const c = read();
    if (!c) throw new MigrationError("no-migration", "no re-embedding migration to abort");
    if (TERMINAL.includes(c.phase)) throw new MigrationError("not-abortable", `migration ${c.id} is already ${c.phase}`);
    if (busy) throw new MigrationError("not-abortable", `a ${busy} is in progress for migration ${c.id}; it cannot be aborted half-way`);
    if (loop) {
      const l = loop;
      save(c, { abortRequested: true });
      l.ac.abort();
      return publicView(await l.done); // stops at the next batch boundary, never mid-batch
    }
    return publicView(save(c, { phase: "aborted", abortRequested: false }));
  }

  async function doSwitch(): Promise<PublicCheckpoint> {
    const c = read();
    if (!c) throw new MigrationError("no-migration", "no re-embedding migration to switch");
    if (c.phase !== "ready-to-switch" || loop) throw new MigrationError("not-ready-to-switch", `migration ${c.id} is ${c.phase}; a switch needs a copied and validated generation`);
    if (busy) throw new MigrationError("migration-running", `a ${busy} is already in progress`);
    busy = "switch"; // set before the first await: a second switch (or an abort, a plan) now meets it
    try { return await switchLocked(c); } finally { busy = null; }
  }

  async function switchLocked(c: Checkpoint): Promise<PublicCheckpoint> {
    if (!d.switchPort) {
      const err = new MigrationError("switch-unavailable", "this core cannot write the active embedding selection (no supervisor owns config.json); start the daemon and retry");
      save(c, { error: { code: err.code, message: err.message } }); // the phase stays ready-to-switch: status says why
      throw err;
    }
    const rec = await d.engine.status(c.id);
    if (!rec || rec.state !== "ready_to_switch") throw new MigrationError("not-ready-to-switch", `the engine reports ${rec?.state ?? "no record"} for ${c.id}`);
    if (rec.id !== c.id || rec.source.generation !== c.sourceGeneration || rec.target.generation === rec.source.generation) {
      throw new MigrationError("not-ready-to-switch", "the engine migration record or source generation differs from the checkpoint; not switching");
    }
    // The generation the engine finished must be the one this checkpoint planned: never write another vector space into the config.
    if (rec.target.generation !== c.targetGeneration || !sameSpace(rec.target.fingerprint, c.target)) {
      throw new MigrationError("not-ready-to-switch", `the engine's target for ${c.id} (generation, provider, model or dimensions) differs from the planned one; plan again`);
    }
    try {
      await d.switchPort.apply({ generation: c.targetGeneration, fingerprint: c.target, fingerprintId: rec.target.fingerprintId, ...(c.remote ? { remote: { apiKeyEnv: c.remote.apiKeyEnv, ...(c.remote.baseUrl !== undefined ? { baseUrl: c.remote.baseUrl } : {}), ...(c.remote.privacyAck ? { privacyAck: c.remote.privacyAck } : {}) } } : {}) });
    } catch (e) {
      const err = e instanceof MigrationError ? e : new MigrationError("switch-failed", (e instanceof Error ? e.message : String(e)).slice(0, 500));
      save(c, { error: { code: err.code, message: err.message } }); // the phase stays ready-to-switch: status says why
      throw err;
    }
    d.logger?.info("re-embedding switched", { id: c.id, generation: c.targetGeneration });
    return publicView(save(c, { phase: "switched", error: null }));
  }

  async function stop(waitMs: number): Promise<void> {
    if (!loop) return;
    const l = loop;
    l.ac.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([l.done.then(() => undefined), new Promise<void>((res) => { timer = setTimeout(res, waitMs); timer.unref(); })]);
    clearTimeout(timer);
  }

  return { plan, start, run: async () => (await start()).done, status, abort, switch: doSwitch, stop };
}
