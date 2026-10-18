import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertMemoryConfiguration } from "./licences/memory.ts";
import type { LicenceAcceptance } from "./licences/ledger.ts";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";
import { resolveEmbeddingProvider, resolveRerankerProvider } from "./composition/embedding-policy.ts";

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
  // Owner decision 2026-10-18: cloud and OpenAI-compatible providers are allowed for both roles; refused only for
  // missing details, a key in the config, a missing privacy acknowledgment or a provider the engine has no adapter for.
  const embPlan = resolveEmbeddingProvider(emb, plain(plain(plain(cfg).memory).embedding).privacyAck);
  const rerPlan = resolveRerankerProvider(rer);
  const embedding = embPlan.kind === "remote" ? embPlan.block : { ...emb, provider: "local-transformers", local: { model: E5_SMALL, dimensions: 384, cacheDir: l.models, ...plain(emb.local) } };
  const reranker = rerPlan.kind === "remote" ? rerPlan.block : { ...rer, enabled: true, provider: "local-transformers", local: { model: BGE_RERANKER, cacheDir: l.models, ...plain(rer.local) } };
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

/** Execution gate is separate from the pure projection used by read-only migration inspection. */
export function checkEngineConfigLicences(engineConfig: unknown,l: Layout): void {
  // CLI/config-file writes have no HTTP preflight; the runtime still refuses an unconfirmed NC revision.
  const ledgerPath = join(l.state,"model-licences.sqlite");
  let accepted: LicenceAcceptance[] = [];
  if (existsSync(ledgerPath)) {
    const db = new DatabaseSync(ledgerPath,{readOnly:true});
    try { accepted = db.prepare("SELECT * FROM model_licences").all() as unknown as LicenceAcceptance[]; } finally { db.close(); }
  }
  assertMemoryConfiguration(engineConfig,accepted);
}
