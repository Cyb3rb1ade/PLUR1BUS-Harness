import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { ModelStatus } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "./logger.ts";

/**
 * Background model warm-up (spec §6.3, E4): the core is `ready` as soon as its socket serves and the journal is
 * replayed (S7, B8); the embedder and the reranker load afterwards through `engine.models.warm()`. Until they have,
 * `EngineStatus.degraded` is `models-warming` and recall falls back as the engine does.
 */
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
    } catch (err) {
      o.logger.debug("models warm-up ended without a result", { err, ms: Math.round(performance.now() - t0) });
    }
  })();
  return { done, abort: () => own.abort(new Error("warm-up aborted")) };
}

function projectOne(m: E.ModelReadiness, id: string | null): ModelStatus {
  return { state: m.state, warming: m.warming, checkedAt: m.checkedAt, ...(typeof m.error === "string" ? { error: m.error } : {}), id };
}

/** The closed `$defs/ModelStatus` wire shape: `id` is the embedder's model name or the reranker's provider. */
export function projectModels(m: E.ModelsStatus): { embedder: ModelStatus; reranker: ModelStatus } {
  return {
    embedder: projectOne(m.embedder, typeof m.embedder.identity?.model === "string" ? m.embedder.identity.model : null),
    reranker: projectOne(m.reranker, typeof m.reranker.provider === "string" ? m.reranker.provider : null),
  };
}
