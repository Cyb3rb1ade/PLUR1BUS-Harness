// The re-embedding migration driver (M2 acceptance 6): plan → run (batches, throttled, abortable, resumable) → switch,
// over the narrow engine port (port.ts) with the Harness checkpoint (state.ts). The engine owns the data path and its own
// record; the driver owns orchestration: which migration is ours, throttling, abort at batch boundaries, fail-closed
// validation, and the Harness half of the switch. Nothing here touches the active generation before `switch()`.
import { randomBytes } from "node:crypto";
import { checkTarget, probeCompatibility, type EmbeddingFingerprint, type ProbeResult } from "./probe.ts";
import type { EngineRecord, ReembedEngine, SwitchPort } from "./port.ts";
import { MigrationStateError, TERMINAL, type Checkpoint, type Phase, type StateStore } from "./state.ts";

export type MigrationErrorCode =
  | "migration-active" | "migration-running" | "no-migration" | "not-runnable" | "not-abortable" | "not-ready-to-switch"
  | "plan-refused" | "switch-unavailable" | "switch-failed" | "state-corrupt" | "state-unreadable";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string) { super(message); this.name = "MigrationError"; this.code = code; }
}

/** The checkpoint as callers see it: the confirmation token never leaves the driver. */
export type PublicCheckpoint = Omit<Checkpoint, "token">;
export const publicView = (c: Checkpoint): PublicCheckpoint => { const { token: _t, ...rest } = c; return rest; };

export interface PlanSummary {
  id: string; sourceGeneration: string; targetGeneration: string;
  rows: number; tables: number; batches: number; batchSize: number; providerCalls: number;
  sourceBytes: number; targetBytes: number; requiredFreeBytes: number; freeBytes: number;
  throttleMs: number;
  /** The pauses alone (batches × throttle); provider time comes on top. */
  minDurationMs: number;
  probeStatus: string;
}
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
}

export interface MigrationDriver {
  plan(req: { target: EmbeddingFingerprint; throttleMs?: number; targetGeneration?: string }): Promise<PlanOutcome>;
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

  const read = (): Checkpoint | null => {
    try { return d.store.read(); } catch (e) {
      if (e instanceof MigrationStateError) throw new MigrationError(e.code === "state-corrupt" ? "state-corrupt" : "state-unreadable", e.message);
      throw e;
    }
  };
  const save = (c: Checkpoint, patch: Partial<Checkpoint>): Checkpoint => { const next = { ...c, ...patch, updatedAt: now() }; d.store.write(next); return next; };

  const batchesOf = (tables: { rowCount: number }[]) => tables.reduce((s, t) => s + Math.ceil(t.rowCount / d.engine.batchSize), 0);

  async function plan(req: { target: EmbeddingFingerprint; throttleMs?: number; targetGeneration?: string }): Promise<PlanOutcome> {
    const throttleMs = req.throttleMs ?? DEFAULT_THROTTLE_MS;
    if (!Number.isSafeInteger(throttleMs) || throttleMs < 0 || throttleMs > MAX_THROTTLE_MS) throw new MigrationError("plan-refused", `throttleMs must be an integer between 0 and ${MAX_THROTTLE_MS}`);
    const existing = read();
    // A planned migration that never started has copied nothing: planning again simply replaces it.
    if (existing && !TERMINAL.includes(existing.phase) && existing.phase !== "planned") throw new MigrationError("migration-active", `migration ${existing.id} is ${existing.phase}; finish it with --run or stop it with --abort first`);
    const refused = checkTarget(req.target);
    if (refused) return { probe: refused, plan: null };

    const id = newId();
    let enginePlan;
    try {
      enginePlan = await d.engine.plan({ id, target: { fingerprint: req.target }, ...(req.targetGeneration ? { targetGeneration: req.targetGeneration } : {}), confirmationTtlMs: CONFIRMATION_TTL_MS });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/does not change the embedding fingerprint/.test(message)) {
        // The engine's own comparison: the store already has this identity. Nothing to migrate.
        return { probe: probeCompatibility({ stored: req.target, target: req.target }), plan: null };
      }
      throw new MigrationError("plan-refused", message.slice(0, 500));
    }
    const p = enginePlan.plan;
    const probe = probeCompatibility({
      stored: p.source.fingerprint, target: req.target,
      targetProbe: { ok: p.target.probeStatus === "passed" || p.target.probeStatus === "probe_deferred_local_artifact" },
    });
    const batches = batchesOf(p.source.tables);
    const cp: Checkpoint = {
      v: 1, id: p.id, token: enginePlan.confirmation.token, planDigest: enginePlan.planDigest, createdAt: now(), updatedAt: now(), phase: "planned",
      sourceGeneration: p.source.generation, targetGeneration: p.target.generation, target: req.target,
      counts: { rows: p.estimates.rows, tables: p.source.tables.length, batches, rowsDone: 0, batchesDone: 0 },
      throttleMs, abortRequested: false, error: null,
    };
    d.store.write(cp);
    d.logger?.info("re-embedding planned", { id: p.id, rows: cp.counts.rows, batches });
    return {
      probe,
      plan: {
        id: p.id, sourceGeneration: p.source.generation, targetGeneration: p.target.generation, rows: p.estimates.rows, tables: p.source.tables.length,
        batches, batchSize: d.engine.batchSize, providerCalls: p.estimates.providerCalls, sourceBytes: p.estimates.sourceBytes, targetBytes: p.estimates.targetBytes,
        requiredFreeBytes: p.estimates.requiredFreeBytes, freeBytes: p.estimates.freeBytes, throttleMs, minDurationMs: batches * throttleMs, probeStatus: p.target.probeStatus,
      },
    };
  }

  /** Applies the engine's record to the checkpoint's counters. */
  const track = (c: Checkpoint, rec: EngineRecord, batchRan: boolean): Checkpoint =>
    save(c, { counts: { ...c.counts, rowsDone: rec.cursor.completedRows, batchesDone: c.counts.batchesDone + (batchRan ? 1 : 0) } });

  async function body(initial: Checkpoint, signal: AbortSignal): Promise<Checkpoint> {
    let c = initial;
    const stop = (phase: Phase, error: Checkpoint["error"] = null) => save(c, { phase, error, abortRequested: false });
    try {
      let rec = await d.engine.status(c.id);
      if (!rec) return stop("failed", { code: "engine-record-missing", message: "the engine has no record of this migration; plan again" });
      while (rec.state === "planned" || rec.state === "confirmed" || rec.state === "running") {
        if (signal.aborted) return stop("aborted");
        rec = rec.state === "running" ? await d.engine.resume({ id: c.id, token: c.token }) : await d.engine.apply({ id: c.id, token: c.token });
        c = track(c, rec, true);
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
    const c = read();
    if (!c) throw new MigrationError("no-migration", "no re-embedding migration is planned (plan one first)");
    if (!["planned", "running", "aborted", "validating"].includes(c.phase)) throw new MigrationError("not-runnable", `migration ${c.id} is ${c.phase}; there is nothing to run`);
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
    return { checkpoint: c ? publicView(c) : null, engineState, running: loop !== null, progress: { rows: k.rows, rowsDone: k.rowsDone, batches: k.batches, batchesDone: k.batchesDone, percent: k.rows === 0 ? 0 : Math.floor((k.rowsDone * 100) / k.rows) } };
  }

  async function abort(): Promise<PublicCheckpoint> {
    const c = read();
    if (!c) throw new MigrationError("no-migration", "no re-embedding migration to abort");
    if (TERMINAL.includes(c.phase)) throw new MigrationError("not-abortable", `migration ${c.id} is already ${c.phase}`);
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
    if (!d.switchPort) {
      const err = new MigrationError("switch-unavailable", "this core cannot write the active embedding selection (no supervisor owns config.json); start the daemon and retry");
      save(c, { error: { code: err.code, message: err.message } }); // the phase stays ready-to-switch: status says why
      throw err;
    }
    const rec = await d.engine.status(c.id);
    if (!rec || rec.state !== "ready_to_switch") throw new MigrationError("not-ready-to-switch", `the engine reports ${rec?.state ?? "no record"} for ${c.id}`);
    try {
      await d.switchPort.apply({ generation: c.targetGeneration, fingerprint: c.target, fingerprintId: rec.target.fingerprintId });
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
