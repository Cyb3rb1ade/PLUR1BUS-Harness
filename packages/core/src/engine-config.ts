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
  const user = plain(cfg.engine);
  const { baseDbPathOverride, baseDbPath: _b, autoRecall: _r, autoCapture: _c, ...passthrough } = user;
  const emb = plain(passthrough.embedding), rer = plain(passthrough.reranker), rec = plain(passthrough.recall);
  const embedding = { ...emb, provider: "local-transformers", local: { model: E5_SMALL, dimensions: 384, cacheDir: l.models, ...plain(emb.local) } };
  const reranker = { ...rer, enabled: true, provider: "local-transformers", local: { model: BGE_RERANKER, cacheDir: l.models, ...plain(rer.local) } };
  const recall = { ...rec, softBudgetMs: cfg.core.recall.softBudgetMs, globalInjectMaxChars: cfg.core.recall.capChars, decisionTrace: { ...plain(rec.decisionTrace), enabled: true } };
  const override = typeof baseDbPathOverride === "string" && baseDbPathOverride.trim() !== "" ? baseDbPathOverride : undefined;
  return { ...passthrough, baseDbPath: override ?? l.lancedb, autoRecall: false, autoCapture: false, embedding, reranker, recall };
}

/** A shallow copy of a plain object without `__proto__` keys; anything else (string, array, null, number) is `{}`, so
 *  it is never spread into index keys. */
function plain(v: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) if (k !== "__proto__") out[k] = x;
  return out;
}
