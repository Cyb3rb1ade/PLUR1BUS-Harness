import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { ModelStatus } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "./logger.ts";

/**
 * Background model warm-up (spec §6.3, E4): the core is `ready` as soon as its socket serves and the journal is
 * replayed (S7, B8); the embedder and the reranker load afterwards through `engine.models.warm()`. Until they have,
 * `EngineStatus.degraded` is `models-warming` and recall falls back as the engine does.
 *
 * H3-R22: the probes load the models but leave the first recall cold (its own query embeddings, the first table
 * search, the neo prelude). Once the embedder is ready, one internal recall per registered agent pays that cost
 * before the core reports the engine ready, so the first client recall fits the core's hard budget.
 */

/** Per-agent budget of the internal warm-up recall. */
export const RECALL_WARMUP_TIMEOUT_MS = 30_000;

/** The internal recall pass: which agents, and how to run one synthetic recall for an agent. */
export interface RecallWarmup {
  agents(): string[];
  /** Resolves with the engine's RecallResult (only `degraded` is read); may reject. */
  recall(agentId: string, signal: AbortSignal): Promise<{ degraded?: { reason: string } | null } | null | undefined>;
}
export interface Warmup {
  /** Settles once warm() has answered, or the wait was aborted. Never rejects. */
  readonly done: Promise<void>;
  /** Ends this caller's wait (warm()'s own `signal` semantics); the engine's probes are not cancelled. */
  abort(): void;
}

export interface WarmupOptions {
  engine: Pick<E.Engine, "models">;
  logger: HarnessLogger;
  /** The core's shutdown signal: aborting it ends the wait. */
  signal: AbortSignal;
  /** Called with warm()'s result when it answered (not after an abort or a rejection). */
  onDone(models: E.ModelsStatus): void;
  /** H3-R22: run after warm() answered with the embedder ready. */
  recall?: RecallWarmup;
  /** Called once the warm-up is over, recall pass included (also after an abort, a rejection or a skipped pass). */
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
      if (o.recall && models.embedder.state === "ready") await warmRecall(o.recall, signal, aborted);
    } catch (err) {
      o.logger.debug("models warm-up ended without a result", { err, ms: Math.round(performance.now() - t0) });
    } finally {
      try { o.onRecallDone?.(); } catch (err) { o.logger.debug("recall warm-up callback failed", { err }); }
    }
  })();

  /** One synthetic recall per agent, in turn; a failure or a timeout is logged and the pass goes on. */
  async function warmRecall(r: RecallWarmup, shutdown: AbortSignal, ended: Promise<null>): Promise<void> {
    let ids: string[] = [];
    try { ids = r.agents(); } catch (err) { o.logger.debug("recall warm-up: no agent list", { err }); return; }
    for (const agentId of ids) {
      if (shutdown.aborted) return;
      const t1 = performance.now();
      try {
        const signal = AbortSignal.any([shutdown, AbortSignal.timeout(o.recallTimeoutMs ?? RECALL_WARMUP_TIMEOUT_MS)]);
        const res = await Promise.race([r.recall(agentId, signal), ended]);
        if (shutdown.aborted) { o.logger.debug("recall warm-up wait aborted", { agentId }); return; }
        o.logger.info("recall warm", { agentId, ms: Math.round(performance.now() - t1), degraded: res?.degraded?.reason ?? null });
      } catch (err) {
        o.logger.debug("recall warm-up failed", { agentId, err, ms: Math.round(performance.now() - t1) });
      }
    }
  }
  return { done, abort: () => own.abort(new Error("warm-up aborted")) };
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
