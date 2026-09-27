import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { ModelStatus } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "./logger.ts";
import { AGENT_CONTEXT_CLI } from "./principal.ts";

/**
 * Background model warm-up (spec §6.3, E4): the core is `ready` as soon as its socket serves and the journal is
 * replayed (S7, B8); the embedder and the reranker load afterwards through `engine.models.warm()`. Until they have,
 * `EngineStatus.degraded` is `models-warming` and recall falls back as the engine does.
 *
 * H3-R22/H3-R23: the probes load the models but leave the first recall cold (a real query embedding, the agent's
 * LanceDB open and first vector search). Once the embedder is ready, a read-only pass per registered agent pays that
 * cost before the core reports the engine ready, so the first client recall fits the core's hard budget. It never
 * runs `engine.recall`: a user-origin recall presents due reminders and nudges, records activity and writes neo,
 * mood and dream-echo state (engine d0842424, assemble-prompt-context.js), which a warm-up must never do. It uses
 * `memory.list` by topic (query embedding + table open + vector search; read-only, no events) and one
 * `embedding.rerank` with a realistic input when the reranker is enabled. Left cold: the neo prelude's own store
 * reads, which no side-effect-free public API reaches.
 */

/** Per-agent budget of the recall-path warm-up. */
export const RECALL_WARMUP_TIMEOUT_MS = 30_000;
/** The fixed, neutral query of the recall-path warm-up. */
export const WARMUP_QUERY = "plur1bus recall warm-up";
/** The neutral documents of the warm-up rerank. */
export const WARMUP_RERANK_DOCS: readonly string[] = Object.freeze(["plur1bus warm-up document one", "plur1bus warm-up document two"]);

/** The recall-path pass: which agents, and the principal each is warmed as (null: skip the agent). */
export interface RecallPathWarmup {
  agents(): string[];
  principal(agentId: string): E.Principal | null;
}
export interface Warmup {
  /** Settles once warm() has answered, or the wait was aborted. Never rejects. */
  readonly done: Promise<void>;
  /** Ends this caller's wait (warm()'s own `signal` semantics); the engine's probes are not cancelled. */
  abort(): void;
}

export interface WarmupOptions {
  engine: Pick<E.Engine, "models"> & Partial<Pick<E.Engine, "memory" | "embedding">>;
  logger: HarnessLogger;
  /** The core's shutdown signal: aborting it ends the wait. */
  signal: AbortSignal;
  /** Called with warm()'s result when it answered (not after an abort or a rejection). */
  onDone(models: E.ModelsStatus): void;
  /** H3-R23: run after warm() answered with the embedder ready. */
  recallPath?: RecallPathWarmup;
  /** Called once the warm-up is over, recall-path pass included (also after an abort, a rejection or a skipped pass). */
  onRecallDone?(): void;
  /** Per-agent timeout of the recall pass (default RECALL_WARMUP_TIMEOUT_MS). */
  recallTimeoutMs?: number;
}

export function startWarmup(o: WarmupOptions): Warmup {
  const own = new AbortController();
  const signal = AbortSignal.any([o.signal, own.signal]);
  const t0 = performance.now();
  const aborted = new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const done = (async () => {
    try {
      // warm() never rejects for a provider failure; it rejects only once the engine is closed (MemoryOpError storage).
      const models = await Promise.race([o.engine.models.warm({ signal }), aborted]);
      const ms = Math.round(performance.now() - t0);
      if (models === null) { o.logger.debug("models warm-up wait aborted", { ms }); return; }
      o.logger.info("models warm", { embedder: models.embedder.state, reranker: models.reranker.state, ms });
      o.onDone(models);
      if (o.recallPath && models.embedder.state === "ready") await warmRecallPath(o.recallPath, models.reranker.state !== "disabled", signal);
    } catch (err) {
      o.logger.debug("models warm-up ended without a result", { err, ms: Math.round(performance.now() - t0) });
    } finally {
      try { o.onRecallDone?.(); } catch (err) { o.logger.debug("recall warm-up callback failed", { err }); }
    }
  })();

  /** Per agent, in turn: memory.list by topic; then one rerank for the whole pass when the reranker is enabled (a
   *  remote reranker bills per call). A failure or a timeout is logged and the pass goes on; the shutdown ends it. */
  async function warmRecallPath(r: RecallPathWarmup, rerank: boolean, shutdown: AbortSignal): Promise<void> {
    const memory = o.engine.memory; const embedding = o.engine.embedding;
    const deadline = () => AbortSignal.any([shutdown, AbortSignal.timeout(o.recallTimeoutMs ?? RECALL_WARMUP_TIMEOUT_MS)]);
    let ids: string[] = [];
    try { ids = r.agents(); } catch (err) { o.logger.debug("recall warm-up: no agent list", { err }); return; }
    for (const agentId of ids) {
      if (shutdown.aborted) return;
      const t1 = performance.now();
      try {
        const principal = r.principal(agentId);
        if (!principal || !memory) continue;
        const signal = deadline();
        // memory.list takes no signal: the wait, not the read, ends at the deadline.
        const res = await Promise.race([memory.list({ topic: WARMUP_QUERY, limit: 1 }, principal, AGENT_CONTEXT_CLI), abortedOf(signal)]);
        if (shutdown.aborted) { o.logger.debug("recall warm-up wait aborted", { agentId }); return; }
        // An agent without a table yet lists nothing: items 0 (its first capture creates the table).
        o.logger.info("recall path warm", { agentId, ms: Math.round(performance.now() - t1), items: res ? res.items.length : null, truncated: res ? res.truncated : null, timedOut: res === null });
      } catch (err) {
        o.logger.debug("recall warm-up failed", { agentId, err, ms: Math.round(performance.now() - t1) });
      }
    }
    if (!rerank || !embedding || shutdown.aborted) return;
    const t2 = performance.now();
    try {
      const signal = deadline();
      const hits = await Promise.race([embedding.rerank(WARMUP_QUERY, [...WARMUP_RERANK_DOCS], { topN: 1, signal }), abortedOf(signal)]);
      if (shutdown.aborted) { o.logger.debug("reranker warm-up wait aborted"); return; }
      o.logger.info("reranker warm", { ms: Math.round(performance.now() - t2), timedOut: hits === null });
    } catch (err) {
      o.logger.debug("reranker warm-up failed", { err, ms: Math.round(performance.now() - t2) });
    }
  }
  return { done, abort: () => own.abort(new Error("warm-up aborted")) };
}

/** Resolves (with null) once `signal` aborts; never rejects. */
function abortedOf(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

/** `checkedAt` is the engine's clock time; the wire wants an integer, so a fractional clock is rounded and anything
 *  non-finite becomes null (an invalid value would make core.status fail its own schema). */
function wireCheckedAt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function projectOne(m: E.ModelReadiness, id: string | null): ModelStatus {
  return { state: m.state, warming: m.warming, checkedAt: wireCheckedAt(m.checkedAt), ...(typeof m.error === "string" ? { error: m.error } : {}), id };
}

/** The closed `$defs/ModelStatus` wire shape: `id` is the embedder's model name or the reranker's provider. */
export function projectModels(m: E.ModelsStatus): { embedder: ModelStatus; reranker: ModelStatus } {
  return {
    embedder: projectOne(m.embedder, typeof m.embedder.identity?.model === "string" ? m.embedder.identity.model : null),
    reranker: projectOne(m.reranker, typeof m.reranker.provider === "string" ? m.reranker.provider : null),
  };
}
