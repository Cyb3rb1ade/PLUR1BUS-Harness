import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";

const E5_SMALL = "intfloat/multilingual-e5-small";
const BGE_RERANKER = "woxpas-ai/bge-reranker-v2-m3-onnx";

/**
 * The single translation between harness config and the engine's EngineConfig.
 * Harness-owned keys always win; everything else in config.engine passes through.
 * Engine PR E5 (host-neutral engine-config.schema.json) will let this file shrink.
 */
export function buildEngineConfig(cfg: HarnessConfig, l: Layout): Record<string, unknown> {
  const user = { ...cfg.engine } as Record<string, any>;
  const { baseDbPathOverride, baseDbPath: _b, autoRecall: _r, autoCapture: _c, ...passthrough } = user;
  const embedding = { ...(passthrough.embedding ?? {}), provider: "local-transformers", local: { model: E5_SMALL, dimensions: 384, cacheDir: l.models, ...(passthrough.embedding?.local ?? {}) } };
  const reranker = { enabled: true, provider: "local-transformers", ...(passthrough.reranker ?? {}), local: { model: BGE_RERANKER, cacheDir: l.models, ...(passthrough.reranker?.local ?? {}) } };
  const recall = { ...(passthrough.recall ?? {}), softBudgetMs: cfg.core.recall.softBudgetMs, globalInjectMaxChars: cfg.core.recall.capChars, decisionTrace: { ...(passthrough.recall?.decisionTrace ?? {}), enabled: true } };
  return { ...passthrough, baseDbPath: baseDbPathOverride ?? l.lancedb, autoRecall: false, autoCapture: false, embedding, reranker, recall };
}
