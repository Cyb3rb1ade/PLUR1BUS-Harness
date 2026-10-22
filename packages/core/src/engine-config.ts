import installedEngineSchema from '@cyb3rb1ade/plur1bus-memory/engine/config/engine-config.schema.json' with { type: 'json' };
import { buildMediaEngineConfig } from "./media-search/engine-host.ts";
import { assertSharedEnginePrivacy } from "./privacy/shared-engine.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertMemoryConfiguration } from "./licences/memory.ts";
import type { LicenceAcceptance } from "./licences/ledger.ts";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { Layout } from "./paths.ts";
import { assertEngineFeaturesLocal, engineModelEndpoints, resolveEmbeddingProvider, resolveRerankerProvider } from "./composition/embedding-policy.ts";
import { localEndpoints, localOnlyShared, redactEndpoint } from "./privacy/local-only.ts";
import { RpcError } from "./rpc/errors.ts";
import type { Egress } from "./egress/service.ts";

const E5_SMALL = "intfloat/multilingual-e5-small";
const BGE_RERANKER = "woxpas-ai/bge-reranker-v2-m3-onnx";

/**
 * The single translation between harness config and the engine's EngineConfig.
 * Harness-owned keys always win; everything else in config.engine passes through.
 * Engine PR E5 (host-neutral engine-config.schema.json) will let this file shrink.
 */
export function buildEngineConfig(cfg: HarnessConfig, l: Layout, engineSchema: unknown = installedEngineSchema): Record<string, unknown> {
  assertSharedEnginePrivacy(cfg);
  const user = plain(cfg.engine);
  const { baseDbPathOverride, baseDbPath: _b, autoRecall: _r, autoCapture: _c, media: _media, ...passthrough } = user;
  const emb = plain(passthrough.embedding), rer = plain(passthrough.reranker), rec = plain(passthrough.recall);
  // Owner decision 2026-10-18: cloud and OpenAI-compatible providers are allowed for both roles; refused only for
  // missing details, a key in the config, a missing privacy acknowledgment or a provider the engine has no adapter for.
  // privacy.localOnly (owner decision 2026-10-18): the engine is shared by every agent, so it stays local while the
  // installation or any agent is local-only.
  const policy = { localOnly: localOnlyShared(cfg), localEndpoints: localEndpoints(cfg) };
  const memory = plain(plain(cfg).memory);
  const embPlan = resolveEmbeddingProvider(emb, plain(memory.embedding).privacyAck, policy);
  const rerPlan = resolveRerankerProvider(rer, plain(memory.reranker).privacyAck, policy);
  assertEngineFeaturesLocal(passthrough, policy);
  const embedding = embPlan.kind === "remote" ? embPlan.block : { ...emb, provider: "local-transformers", local: { model: E5_SMALL, dimensions: 384, cacheDir: l.models, ...plain(emb.local) } };
  const reranker = rerPlan.kind === "remote" ? rerPlan.block : { ...rer, enabled: true, provider: "local-transformers", local: { model: BGE_RERANKER, cacheDir: l.models, ...plain(rer.local) } };
  const recall = { ...rec, softBudgetMs: cfg.core.recall.softBudgetMs, globalInjectMaxChars: cfg.core.recall.capChars, decisionTrace: { ...plain(rec.decisionTrace), enabled: true } };
  const override = typeof baseDbPathOverride === "string" && baseDbPathOverride.trim() !== "" ? baseDbPathOverride : undefined;
  const mediaSchema = plain(plain(engineSchema).properties).media;
  const supportsMedia = mediaSchema !== null && typeof mediaSchema === 'object' && !Array.isArray(mediaSchema);
  return { ...passthrough, baseDbPath: override ?? l.lancedb, autoRecall: false, autoCapture: false, embedding, reranker, recall,
    // Engine 1.16 rejects even a disabled unknown media key. The installed public schema,
    // not a presumed version or a raw engine.* override, decides whether projection is legal.
    ...(supportsMedia ? { media: buildMediaEngineConfig(cfg.memory.mediaEmbedding, l.models) } : {}) };
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

/**
 * Egress check at construction: every model endpoint the engine will call (remote embedding, remote reranker, engine LLM
 * features with their own transport) must pass the harness egress policy (`egress.decide`), the same decision every
 * harness-owned provider call takes. This preflight gives early feedback; the injected HostServices.fetch additionally
 * runs every request through `egress.request`, including redirects and later live policy changes.
 * A refusal fails the engine start with E_DENIED reason egress-denied. A name that does not resolve right now (offline
 * start, `not-found`) is not a policy refusal and is only reported; an endpoint without a known host (a feature key
 * without baseUrl) cannot be judged here and is reported too.
 */
export async function checkEngineEgress(engineConfig: Record<string, unknown>, egress: Pick<Egress, "decide">, warn: (message: string, fields: Record<string, unknown>) => void = () => {}): Promise<void> {
  for (const e of engineModelEndpoints(engineConfig)) {
    if (e.endpoint === undefined) { warn("engine model endpoint not checked by egress: no baseUrl, provider default", { role: e.role }); continue; }
    const d = await egress.decide(e.endpoint);
    if (d.allowed) continue;
    if (d.reason === "not-found") { warn("engine model endpoint did not resolve; egress could not judge it", { role: e.role, endpoint: redactEndpoint(e.endpoint) }); continue; }
    throw new RpcError("E_DENIED", `engine ${e.role} endpoint ${redactEndpoint(e.endpoint)} is refused by the egress policy (${d.reason}); list the host in egress.allowHosts (loopback also needs egress.allowLoopback)`, { reason: "egress-denied" });
  }
}
