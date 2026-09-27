// Embedding identity, field by field with the source each value came from (docs/import.md §8.4), the harness target
// identity, their comparison, and the reranker classification (§2.3.2).
import { existsSync } from "node:fs";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { readConfigFile } from "../config-load.ts";
import { buildEngineConfig } from "../engine-config.ts";
import { layout } from "../paths.ts";
import { artefactDigest, CATALOG, ENGINE_DEFAULTS, type LicenceClass } from "./catalog.ts";

export type FieldSource =
  | "store-metadata" | "config" | "cache" | "model-cache" | "vector-schema" | "derived" | "not-applicable" | "unknown"
  | "harness-config" | "harness-default" | "engine-catalog" | "engine-default";

export interface Field<T = unknown> { value: T | null; source: FieldSource; note?: string }

export const IDENTITY_FIELDS = [
  "provider", "model", "revision", "artefactHash", "quantization", "dimension", "prefixSchema", "normalization", "tokenCap", "endpoint",
] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];
export type Identity = Record<IdentityField, Field>;

const f = <T>(value: T | null, source: FieldSource, note?: string): Field<T> => (note ? { value, source, note } : { value, source });
const unknown = (note?: string): Field => f(null, "unknown", note);
export const isKnown = (x: Field) => x.source !== "unknown";

/** A full embedding fingerprint as the engine records it in its re-embedding state (lib/reembedding/fingerprint.js). */
export interface Fingerprint {
  provider?: string; model?: string; revision?: string; dimensions?: number; endpoint?: string;
  queryPrefix?: string; passagePrefix?: string; pooling?: string; normalize?: boolean; dtype?: string;
  artifacts?: { path: string; sha256: string }[];
}
export interface CacheGroup { provider: string; model: string; dimensions: number; entries: number }
export interface IdentityEvidence {
  /** The store's own fingerprint record, when the store metadata carries one (generation mode). */
  fingerprint?: Fingerprint | undefined;
  /** The source's embedding config block (PLUR1BUS plugin config `embedding`). */
  config?: Record<string, any> | undefined;
  /** Embedding-cache groups for this store's scope. */
  cache: CacheGroup[];
  /** Local model artefact cache for the configured model: revision directories found and the quantization seen. */
  modelCache?: { revisions: string[]; quantization: "q8" | "fp32" | null } | undefined;
  /** The vector column's fixed list size, read from the Lance schema; null when the table could not be opened. */
  vectorDimension: number | null;
  /** Other dimension claims (manifest, config, cache) for corroboration. */
  dimensionClaims: { source: FieldSource; value: number }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function endpointOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try { const u = new URL(url); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.href; } catch { return null; }
}

/** Builds the identity of one store from its evidence. Returns the fields and the reasons a verdict must mention. */
export function assembleIdentity(ev: IdentityEvidence): { fields: Identity; reasons: string[] } {
  const reasons: string[] = [];
  const fp = ev.fingerprint;
  const cfg = ev.config;
  const single = ev.cache.length === 1 ? ev.cache[0] : undefined;
  const cfgLocal = cfg?.local && typeof cfg.local === "object" ? (cfg.local as Record<string, any>) : undefined;

  const provider: Field = fp?.provider ? f(fp.provider, "store-metadata")
    : typeof cfg?.provider === "string" ? f(cfg.provider, "config")
    : single ? f(single.provider, "cache") : unknown(cfg ? "embedding.provider not set" : "no embedding config");
  const isLocal = provider.value === "local-transformers";
  const isRemote = isKnown(provider) && !isLocal;
  const na = () => f(null, "not-applicable");

  const cfgModel = isLocal ? (cfgLocal?.model ?? cfg?.model) : cfg?.model;
  const model: Field = fp?.model ? f(fp.model, "store-metadata")
    : typeof cfgModel === "string" && isKnown(provider) ? f(cfgModel, "config")
    : single ? f(single.model, "cache") : unknown();
  if (single && typeof model.value === "string" && model.source !== "cache" && single.model !== model.value) reasons.push("cache-model-differs");
  const cat = typeof model.value === "string" ? CATALOG[model.value] : undefined;

  let revision: Field;
  if (isRemote) revision = na();
  else if (fp && fp.provider && isLocal && fp.revision) revision = f(fp.revision, "store-metadata");
  else if (typeof cfgLocal?.revision === "string" && cfgLocal.revision) revision = f(cfgLocal.revision, "config");
  else if (ev.modelCache && ev.modelCache.revisions.length === 1) revision = f(ev.modelCache.revisions[0]!, "model-cache");
  else revision = unknown(ev.modelCache && ev.modelCache.revisions.length > 1 ? `several revisions cached: ${ev.modelCache.revisions.join(", ")}` : undefined);

  let quantization: Field;
  if (isRemote) quantization = na();
  else if (fp && isLocal) quantization = f(fp.dtype ?? "fp32", "store-metadata");
  else if (ev.modelCache?.quantization) quantization = f(ev.modelCache.quantization, "model-cache");
  else quantization = unknown();

  let artefactHash: Field;
  if (isRemote) artefactHash = na();
  else if (fp && fp.artifacts && fp.artifacts.length > 0) artefactHash = f(artefactDigest(fp.artifacts), "store-metadata");
  else if (cat && isKnown(revision) && isKnown(quantization) && revision.value === cat.revision && quantization.value === cat.quantization) {
    artefactHash = f(cat.artefactDigest, "derived", "catalog digest for the confirmed model, revision and quantization");
  } else artefactHash = unknown();

  let dimension: Field;
  if (ev.vectorDimension !== null) {
    dimension = f(ev.vectorDimension, "vector-schema");
    const conflicts = ev.dimensionClaims.filter((c) => c.value !== ev.vectorDimension);
    if (conflicts.length) { reasons.push("dimension-conflict"); dimension.note = `other claims: ${conflicts.map((c) => `${c.source}=${c.value}`).join(", ")}`; }
  } else {
    dimension = unknown(ev.dimensionClaims.length ? `vector schema unreadable; claims: ${ev.dimensionClaims.map((c) => `${c.source}=${c.value}`).join(", ")}` : "vector schema unreadable");
  }

  let prefixSchema: Field;
  if (isRemote) prefixSchema = na();
  else if (fp && isLocal) prefixSchema = f({ query: fp.queryPrefix ?? "", passage: fp.passagePrefix ?? "" }, "store-metadata");
  else if (cfgLocal && (cfgLocal.queryPrefix !== undefined || cfgLocal.passagePrefix !== undefined) && isLocal) {
    prefixSchema = f({ query: cfgLocal.queryPrefix ?? cat?.queryPrefix ?? "query: ", passage: cfgLocal.passagePrefix ?? cat?.passagePrefix ?? "passage: " }, "config");
  } else if (isLocal && isKnown(model) && cat) prefixSchema = f({ query: cat.queryPrefix ?? "query: ", passage: cat.passagePrefix ?? "passage: " }, "derived", "the engine's default prefixes for this model");
  else prefixSchema = unknown();

  let normalization: Field;
  if (isRemote) normalization = na();
  else if (fp && isLocal && (fp.pooling !== undefined || fp.normalize !== undefined)) normalization = f({ pooling: fp.pooling ?? null, normalize: fp.normalize ?? null }, "store-metadata");
  else if (isLocal) normalization = f({ pooling: "mean", normalize: true }, "derived", "local-transformers always mean-pools and normalizes");
  else normalization = unknown();

  let tokenCap: Field;
  if (isRemote) tokenCap = na();
  else if (isLocal && typeof cfgLocal?.maxTokens === "number") tokenCap = f(cfgLocal.maxTokens, "config");
  else if (isLocal) tokenCap = f(ENGINE_DEFAULTS.localTokenCap, "derived", "the engine default");
  else tokenCap = unknown();

  let endpoint: Field;
  if (isLocal) endpoint = na();
  else if (fp && fp.provider) endpoint = f(endpointOf(fp.endpoint), "store-metadata");
  else if (isRemote && cfg) endpoint = f(endpointOf(cfg.baseUrl), "config", cfg.baseUrl ? undefined : "provider default endpoint");
  else endpoint = unknown();

  return { fields: { provider, model, revision, artefactHash, quantization, dimension, prefixSchema, normalization, tokenCap, endpoint }, reasons };
}

export type FieldVerdict = "match" | "mismatch" | "unknown";
export interface Comparison { verdict: "match" | "mismatch" | "undetermined"; fields: Record<IdentityField, FieldVerdict> }

export function compareIdentity(source: Identity, target: Identity, extraReasons: readonly string[] = []): Comparison {
  const fields = {} as Record<IdentityField, FieldVerdict>;
  for (const k of IDENTITY_FIELDS) {
    const s = source[k]; const t = target[k];
    fields[k] = !isKnown(s) || !isKnown(t) ? "unknown" : same(s.value, t.value) ? "match" : "mismatch";
  }
  const values = Object.values(fields);
  const blocking = extraReasons.some((r) => r === "multiple-identities" || r === "dimension-conflict");
  const verdict = values.includes("mismatch") || blocking ? "mismatch" : values.includes("unknown") ? "undetermined" : "match";
  return { verdict, fields };
}

export interface RerankerInfo {
  scope: string;
  enabled: boolean;
  provider: string;
  model: string | null;
  modelSource: FieldSource;
  revision: string | null;
  locality: "local" | "remote" | "disabled" | "unknown";
  licence: string | null;
  licenceClass: LicenceClass | null;
  fallback: { provider: string; model: string | null } | null;
  source: FieldSource;
}

/** Classifies a PLUR1BUS `reranker` config block the way the engine normalises it (config-normalize.js). */
export function classifyReranker(raw: Record<string, any> | undefined, scope = "default", source: FieldSource = "config"): RerankerInfo {
  const r = raw ?? {};
  const disabled = r.provider === "disabled" || r.enabled === false;
  const provider: string = disabled ? "disabled" : r.provider || ((r.apiKey || r.apiKeyEnv) ? "cohere" : "disabled");
  const fallbackProvider = typeof r.fallbackProvider === "string" ? r.fallbackProvider : "disabled";
  const fallback = provider !== "disabled" && fallbackProvider !== "disabled"
    ? { provider: fallbackProvider, model: fallbackProvider === "local-transformers" ? (r.fallbackModel || ENGINE_DEFAULTS.localReranker) : null } : null;
  const base = { scope, fallback, source: raw ? source : ("engine-default" as FieldSource) };
  if (provider === "local-transformers") {
    const explicit = r.local?.model || r.model;
    const model: string = explicit || ENGINE_DEFAULTS.localReranker;
    const cat = CATALOG[model];
    return { ...base, enabled: r.enabled !== false, provider, model, modelSource: explicit ? source : "engine-default", revision: r.local?.revision || cat?.revision || null, locality: "local", licence: cat?.licence ?? null, licenceClass: cat ? cat.licenceClass : "unknown" };
  }
  if (provider === "cohere") {
    return { ...base, enabled: !disabled && !!(r.apiKey || r.apiKeyEnv), provider, model: r.model || ENGINE_DEFAULTS.cohereReranker, modelSource: r.model ? source : "engine-default", revision: null, locality: "remote", licence: null, licenceClass: "remote-service-terms" };
  }
  if (provider === "disabled") return { ...base, enabled: false, provider, model: null, modelSource: "not-applicable", revision: null, locality: "disabled", licence: null, licenceClass: null };
  return { ...base, enabled: r.enabled !== false, provider, model: r.model ?? null, modelSource: r.model ? source : "unknown", revision: null, locality: "unknown", licence: null, licenceClass: "unknown" };
}

export interface RerankerComparison { verdict: "match" | "mismatch" | "unknown"; recommendation: string }

export function compareReranker(src: RerankerInfo, target: RerankerInfo): RerankerComparison {
  if (src.locality === "unknown") return { verdict: "unknown", recommendation: `Unrecognised reranker provider "${src.provider}"; the harness uses ${target.model} (local). Nothing is re-embedded; review after import.` };
  const match = src.provider === target.provider && src.model === target.model;
  if (match) return { verdict: "match", recommendation: "Same reranker as the harness; nothing to do." };
  const base = `Not fatal: rerankers touch no stored vector. The harness uses ${target.model} (local, ${target.licence ?? "licence unknown"}).`;
  if (src.locality === "disabled") return { verdict: "mismatch", recommendation: `${base} The source ran without a reranker; keep the harness default.` };
  if (src.locality === "remote") return { verdict: "mismatch", recommendation: `${base} The source used a remote reranker (${src.provider} ${src.model}); the harness forces a local reranker today (engine-config.ts) and remote rerankers need M2 provider profiles — keep the harness default.` };
  if (src.licenceClass === "non-commercial") return { verdict: "mismatch", recommendation: `${base} The source's reranker ${src.model} is ${src.licence} (non-commercial): the harness may use it only after the owner's audit-logged NC confirmation (setup licence gate); otherwise keep the harness default.` };
  return { verdict: "mismatch", recommendation: `${base} To keep the source's reranker, set engine.reranker.local.model to ${src.model} after import.` };
}

export interface TargetIdentity { home: string; configSource: "config.json" | "defaults" | "invalid-config"; embedding: Identity; reranker: RerankerInfo; warnings: string[] }

/** What the harness at `home` would give the engine (engine-config.ts), as identity fields. Reads config.json only. */
export function targetIdentity(home: string): TargetIdentity {
  const warnings: string[] = [];
  const l = layout(home);
  let configSource: TargetIdentity["configSource"] = "config.json";
  let cfg: HarnessConfig;
  if (!existsSync(l.configPath)) { cfg = defaults(); configSource = "defaults"; }
  else {
    try { cfg = readConfigFile(l.configPath); } catch (e) {
      warnings.push(`harness config.json is invalid (${(e as Error).message}); compared against the defaults`);
      cfg = defaults(); configSource = "invalid-config";
    }
  }
  const engine = buildEngineConfig(cfg, l) as Record<string, any>;
  const userEmb = (cfg.engine as Record<string, any> | undefined)?.embedding?.local ?? {};
  const emb = engine.embedding.local as Record<string, any>;
  const src = (k: string): FieldSource => (userEmb[k] !== undefined ? "harness-config" : "harness-default");
  const model: string = emb.model;
  const cat = CATALOG[model];
  const catField = <T>(v: T | undefined): Field => (v === undefined ? unknown(`model ${model} is not in the pinned catalog`) : f(v, "engine-catalog"));
  const embedding: Identity = {
    provider: f("local-transformers", "harness-default", "engine-config.ts forces local-transformers"),
    model: f(model, src("model")),
    revision: emb.revision ? f(emb.revision, "harness-config") : catField(cat?.revision),
    artefactHash: catField(cat?.artefactDigest),
    quantization: catField(cat?.quantization),
    dimension: f(emb.dimensions, src("dimensions")),
    prefixSchema: emb.queryPrefix !== undefined || emb.passagePrefix !== undefined
      ? f({ query: emb.queryPrefix ?? cat?.queryPrefix ?? "query: ", passage: emb.passagePrefix ?? cat?.passagePrefix ?? "passage: " }, "harness-config")
      : cat ? f({ query: cat.queryPrefix ?? "query: ", passage: cat.passagePrefix ?? "passage: " }, "engine-catalog") : unknown(),
    normalization: f({ pooling: "mean", normalize: true }, "engine-catalog"),
    tokenCap: typeof emb.maxTokens === "number" ? f(emb.maxTokens, "harness-config") : f(ENGINE_DEFAULTS.localTokenCap, "engine-catalog"),
    endpoint: f(null, "not-applicable"),
  };
  const reranker = classifyReranker(engine.reranker as Record<string, any>, "default", (cfg.engine as Record<string, any> | undefined)?.reranker ? "harness-config" : "harness-default");
  return { home, configSource, embedding, reranker, warnings };
}
