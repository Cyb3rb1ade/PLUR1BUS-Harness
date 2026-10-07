// Config validation and per-provider defaults (G5). Raw, untrusted input in; fully resolved settings out. Every problem
// is reported with its path ("embedding.baseURL: required for provider \"tei\"") and all problems are reported at once.
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.ts";

export const EMBEDDING_PROVIDERS = ["openai", "openai-compatible", "vllm", "llamacpp", "omlx", "google", "cohere", "jina", "voyage", "openrouter", "ollama", "tei", "mtplx"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

export const RERANK_PROVIDERS = ["cohere", "jina", "voyage", "tei", "vllm", "llamacpp", "omlx", "mtplx"] as const;
export type RerankProviderId = (typeof RERANK_PROVIDERS)[number];

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.issues = issues;
  }
}

/** What a user writes. Everything but provider, model and dimensions has a provider-specific default. */
export interface EmbeddingConfig {
  provider: EmbeddingProviderId;
  model: string;
  dimensions: number;
  /** Required for self-hosted providers; an override for hosted ones (proxy, regional endpoint). */
  baseURL?: string;
  /** Name handed to the injected getSecret(); never the secret itself. */
  secretName?: string;
  revision?: string;
  /** L2-normalise returned vectors. Default true. */
  normalize?: boolean;
  maxBatch?: number;
  maxInputTokens?: number;
  maxBatchTokens?: number;
  queryPrefix?: string;
  passagePrefix?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retry?: Partial<RetryPolicy>;
  /** Send the dimensions parameter to the server (matryoshka models). */
  sendDimensions?: boolean;
  /** openrouter only: the upstream whose vector space this identity is. */
  pinnedUpstream?: string;
}

export interface RerankConfig {
  provider: RerankProviderId;
  model?: string;
  baseURL?: string;
  secretName?: string;
  /** Only vllm and llamacpp serve the endpoint under more than one path. */
  path?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxDocs?: number;
  retry?: Partial<RetryPolicy>;
}

export interface EmbeddingSettings {
  provider: EmbeddingProviderId;
  model: string;
  dimensions: number;
  baseURL: string;
  /** Endpoint path below baseURL (for google: the models collection, the model is appended). */
  path: string;
  secretName?: string;
  revision?: string;
  normalize: boolean;
  maxBatch: number;
  maxInputTokens: number;
  maxBatchTokens?: number;
  queryPrefix?: string;
  passagePrefix?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  retry: RetryPolicy;
  sendDimensions: boolean;
  pinnedUpstream?: string;
}

export interface RerankSettings {
  provider: RerankProviderId;
  model?: string;
  baseURL: string;
  path: string;
  secretName?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxDocs: number;
  /** Pairwise scorers (cross-encoder servers) may be split across requests; hosted listwise APIs may not. */
  splitOversized: boolean;
  retry: RetryPolicy;
}

interface EmbeddingSpec {
  baseURL?: string;
  path: string;
  secret: "required" | "optional";
  maxBatch: number;
  maxInputTokens: number;
  maxBatchTokens?: number;
  sendDimensions: boolean;
  needsUpstream?: boolean;
}

const LOCAL_OPENAI_LIKE: EmbeddingSpec = { path: "/embeddings", secret: "optional", maxBatch: 64, maxInputTokens: 512, sendDimensions: false };

// Defaults are conservative operating points, not provider maxima; every one can be overridden in the config.
const EMBEDDING_SPECS: Record<EmbeddingProviderId, EmbeddingSpec> = {
  openai: { baseURL: "https://api.openai.com/v1", path: "/embeddings", secret: "required", maxBatch: 256, maxInputTokens: 8192, maxBatchTokens: 250_000, sendDimensions: true },
  "openai-compatible": LOCAL_OPENAI_LIKE,
  vllm: LOCAL_OPENAI_LIKE,
  llamacpp: LOCAL_OPENAI_LIKE,
  omlx: LOCAL_OPENAI_LIKE,
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta", path: "/models", secret: "required", maxBatch: 100, maxInputTokens: 2048, sendDimensions: true },
  cohere: { baseURL: "https://api.cohere.com", path: "/v2/embed", secret: "required", maxBatch: 96, maxInputTokens: 512, sendDimensions: false },
  jina: { baseURL: "https://api.jina.ai/v1", path: "/embeddings", secret: "required", maxBatch: 128, maxInputTokens: 8192, sendDimensions: true },
  voyage: { baseURL: "https://api.voyageai.com/v1", path: "/embeddings", secret: "required", maxBatch: 128, maxInputTokens: 32_000, maxBatchTokens: 100_000, sendDimensions: true },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", path: "/embeddings", secret: "required", maxBatch: 128, maxInputTokens: 8192, sendDimensions: false, needsUpstream: true },
  ollama: { baseURL: "http://127.0.0.1:11434", path: "/api/embed", secret: "optional", maxBatch: 64, maxInputTokens: 512, sendDimensions: false },
  tei: { path: "/embed", secret: "optional", maxBatch: 32, maxInputTokens: 512, sendDimensions: false },
  // MTPLX serves OpenAI-shaped /v1/embeddings (baseURL is the daemon origin, default http://127.0.0.1:8000) and honours
  // `dimensions` by Matryoshka truncation, answering 400 above the native width, so it is sent.
  mtplx: { path: "/v1/embeddings", secret: "optional", maxBatch: 32, maxInputTokens: 8192, sendDimensions: true },
};

interface RerankSpec {
  baseURL?: string;
  path: string;
  paths?: readonly string[];
  secret: "required" | "optional";
  modelRequired: boolean;
  maxDocs: number;
  splitOversized: boolean;
}

const RERANK_SPECS: Record<RerankProviderId, RerankSpec> = {
  cohere: { baseURL: "https://api.cohere.com", path: "/v2/rerank", secret: "required", modelRequired: true, maxDocs: 1000, splitOversized: false },
  jina: { baseURL: "https://api.jina.ai", path: "/v1/rerank", secret: "required", modelRequired: true, maxDocs: 1000, splitOversized: false },
  voyage: { baseURL: "https://api.voyageai.com", path: "/v1/rerank", secret: "required", modelRequired: true, maxDocs: 1000, splitOversized: false },
  tei: { path: "/rerank", secret: "optional", modelRequired: false, maxDocs: 32, splitOversized: true },
  vllm: { path: "/v1/rerank", paths: ["/rerank", "/v1/rerank", "/v2/rerank"], secret: "optional", modelRequired: true, maxDocs: 256, splitOversized: true },
  llamacpp: { path: "/v1/rerank", paths: ["/rerank", "/v1/rerank"], secret: "optional", modelRequired: false, maxDocs: 128, splitOversized: true },
  omlx: { path: "/v1/rerank", secret: "optional", modelRequired: true, maxDocs: 128, splitOversized: true },
  // Not split: a jina-style reranker served by MTPLX scores a whole candidate list in one pass, so parts would not be comparable.
  mtplx: { path: "/v1/rerank", secret: "optional", modelRequired: false, maxDocs: 256, splitOversized: false },
};

/** A rerank request is on the recall hot path (ADR-006: 5 s with a fallback), so it retries once at most. */
const RERANK_RETRY: RetryPolicy = Object.freeze({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500, maxRetryAfterMs: 1000 });

const SELF_HOSTED_BASE: ReadonlySet<string> = new Set(["openai-compatible", "vllm", "llamacpp", "omlx", "tei", "mtplx"]);

const MAX_RESPONSE_BYTES_DEFAULT = 32 * 1024 * 1024;
const RERANK_MAX_RESPONSE_BYTES_DEFAULT = 8 * 1024 * 1024;

class Collector {
  readonly issues: ConfigIssue[] = [];
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  add(key: string, message: string): void {
    this.issues.push({ path: key === "" ? this.root : `${this.root}.${key}`, message });
  }
  done(): void {
    if (this.issues.length > 0) throw new ConfigError(this.issues);
  }
}

type Rec = Record<string, unknown>;

function asRecord(raw: unknown, c: Collector): Rec | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    c.add("", "must be an object");
    return undefined;
  }
  return raw as Rec;
}

function checkKnownKeys(rec: Rec, allowed: readonly string[], c: Collector, prefix = ""): void {
  for (const key of Object.keys(rec)) if (!allowed.includes(key)) c.add(`${prefix}${key}`, "unknown option");
}

function readString(rec: Rec, key: string, c: Collector, opts: { max?: number; control?: boolean } = {}): string | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  const max = opts.max ?? 256;
  if (typeof v !== "string" || v === "" || v.length > max || (opts.control !== true && /[\u0000-\u001f\u007f]/.test(v))) {
    c.add(key, opts.control === true ? `must be a non-empty string (max ${max} characters)` : `must be a non-empty string without control characters (max ${max} characters)`);
    return undefined;
  }
  return v;
}

function readBool(rec: Rec, key: string, c: Collector): boolean | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    c.add(key, "must be a boolean");
    return undefined;
  }
  return v;
}

function readInt(rec: Rec, key: string, c: Collector, min: number, max: number, keyPath = key): number | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    c.add(keyPath, min === 1 && max > 1_000_000 ? "must be a positive integer" : `must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return v;
}

function readBaseURL(rec: Rec, c: Collector): string | undefined {
  const v = rec["baseURL"];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") {
    c.add("baseURL", "must be a non-empty string");
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    c.add("baseURL", "is not a valid URL");
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") c.add("baseURL", "must use http or https");
  else if (u.username !== "" || u.password !== "") c.add("baseURL", "must not contain credentials; use secretName");
  else if (u.search !== "") c.add("baseURL", "must not contain a query string");
  else if (u.hash !== "") c.add("baseURL", "must not contain a fragment");
  else return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return undefined;
}

const RETRY_KEYS = ["maxAttempts", "baseDelayMs", "maxDelayMs", "maxRetryAfterMs"] as const;

function readRetry(rec: Rec, c: Collector, defaults: RetryPolicy): RetryPolicy {
  const raw = rec["retry"];
  if (raw === undefined) return { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    c.add("retry", "must be an object");
    return { ...defaults };
  }
  const r = raw as Rec;
  checkKnownKeys(r, RETRY_KEYS, c, "retry.");
  const merged: RetryPolicy = {
    maxAttempts: readInt(r, "maxAttempts", c, 1, 10, "retry.maxAttempts") ?? defaults.maxAttempts,
    baseDelayMs: readInt(r, "baseDelayMs", c, 0, 600_000, "retry.baseDelayMs") ?? defaults.baseDelayMs,
    maxDelayMs: readInt(r, "maxDelayMs", c, 0, 600_000, "retry.maxDelayMs") ?? defaults.maxDelayMs,
    maxRetryAfterMs: readInt(r, "maxRetryAfterMs", c, 0, 3_600_000, "retry.maxRetryAfterMs") ?? defaults.maxRetryAfterMs,
  };
  if (merged.baseDelayMs > merged.maxDelayMs) c.add("retry.baseDelayMs", "must not exceed maxDelayMs");
  return merged;
}

const EMBEDDING_KEYS = ["provider", "model", "dimensions", "baseURL", "secretName", "revision", "normalize", "maxBatch", "maxInputTokens", "maxBatchTokens", "queryPrefix", "passagePrefix", "timeoutMs", "maxResponseBytes", "retry", "sendDimensions", "pinnedUpstream"] as const;
const RERANK_KEYS = ["provider", "model", "baseURL", "secretName", "path", "timeoutMs", "maxResponseBytes", "maxDocs", "retry"] as const;

function isEmbeddingProvider(v: unknown): v is EmbeddingProviderId {
  return typeof v === "string" && (EMBEDDING_PROVIDERS as readonly string[]).includes(v);
}
function isRerankProvider(v: unknown): v is RerankProviderId {
  return typeof v === "string" && (RERANK_PROVIDERS as readonly string[]).includes(v);
}

export function resolveEmbeddingSettings(raw: unknown, path = "embedding"): EmbeddingSettings {
  const c = new Collector(path);
  const rec = asRecord(raw, c);
  if (!rec) return c.done() as never;

  const providerRaw = rec["provider"];
  const provider = isEmbeddingProvider(providerRaw) ? providerRaw : undefined;
  if (!provider) c.add("provider", `unknown provider ${JSON.stringify(typeof providerRaw === "string" ? providerRaw.slice(0, 40) : String(providerRaw))} (expected one of: ${EMBEDDING_PROVIDERS.join(", ")})`);

  const model = readString(rec, "model", c, { max: 200 });
  if (rec["model"] === undefined) c.add("model", "is required");
  const dimensions = readInt(rec, "dimensions", c, 1, 65_536 * 16);
  if (rec["dimensions"] === undefined) c.add("dimensions", "is required");
  const configuredBase = readBaseURL(rec, c);
  const secretName = readString(rec, "secretName", c);
  const revision = readString(rec, "revision", c, { max: 200 });
  const normalize = readBool(rec, "normalize", c);
  const maxBatch = readInt(rec, "maxBatch", c, 1, 10_000);
  const maxInputTokens = readInt(rec, "maxInputTokens", c, 1, 2_000_000);
  const maxBatchTokens = readInt(rec, "maxBatchTokens", c, 1, 100_000_000);
  const queryPrefix = readString(rec, "queryPrefix", c, { max: 500, control: true });
  const passagePrefix = readString(rec, "passagePrefix", c, { max: 500, control: true });
  const timeoutMs = readInt(rec, "timeoutMs", c, 100, 600_000);
  const maxResponseBytes = readInt(rec, "maxResponseBytes", c, 1024, 512 * 1024 * 1024);
  const sendDimensions = readBool(rec, "sendDimensions", c);
  const pinnedUpstream = readString(rec, "pinnedUpstream", c, { max: 200 });
  const retry = readRetry(rec, c, DEFAULT_RETRY_POLICY);
  checkKnownKeys(rec, EMBEDDING_KEYS, c);

  if (!provider) return c.done() as never;
  const spec = EMBEDDING_SPECS[provider];
  const baseURL = configuredBase ?? spec.baseURL;
  if (rec["baseURL"] === undefined && baseURL === undefined && SELF_HOSTED_BASE.has(provider)) c.add("baseURL", `required for provider "${provider}"`);
  if (spec.secret === "required" && rec["secretName"] === undefined) c.add("secretName", `required for provider "${provider}"`);
  if (spec.needsUpstream && rec["pinnedUpstream"] === undefined) c.add("pinnedUpstream", `required for provider "${provider}" (the vector space is defined by the upstream model)`);
  if (pinnedUpstream !== undefined && !spec.needsUpstream) c.add("pinnedUpstream", `only applies to provider "openrouter"`);
  c.done();

  const maxBatchTokensResolved = maxBatchTokens ?? spec.maxBatchTokens;
  return {
    provider,
    model: model as string,
    dimensions: dimensions as number,
    baseURL: baseURL as string,
    path: spec.path,
    ...(secretName !== undefined ? { secretName } : {}),
    ...(revision !== undefined ? { revision } : {}),
    normalize: normalize ?? true,
    maxBatch: maxBatch ?? spec.maxBatch,
    maxInputTokens: maxInputTokens ?? spec.maxInputTokens,
    ...(maxBatchTokensResolved !== undefined ? { maxBatchTokens: maxBatchTokensResolved } : {}),
    ...(queryPrefix !== undefined ? { queryPrefix } : {}),
    ...(passagePrefix !== undefined ? { passagePrefix } : {}),
    timeoutMs: timeoutMs ?? 15_000,
    maxResponseBytes: maxResponseBytes ?? MAX_RESPONSE_BYTES_DEFAULT,
    retry,
    sendDimensions: sendDimensions ?? spec.sendDimensions,
    ...(pinnedUpstream !== undefined ? { pinnedUpstream } : {}),
  };
}

export function resolveRerankSettings(raw: unknown, path = "rerank"): RerankSettings {
  const c = new Collector(path);
  const rec = asRecord(raw, c);
  if (!rec) return c.done() as never;

  const providerRaw = rec["provider"];
  const provider = isRerankProvider(providerRaw) ? providerRaw : undefined;
  if (!provider) c.add("provider", `unknown provider ${JSON.stringify(typeof providerRaw === "string" ? providerRaw.slice(0, 40) : String(providerRaw))} (expected one of: ${RERANK_PROVIDERS.join(", ")})`);

  const model = readString(rec, "model", c, { max: 200 });
  const configuredBase = readBaseURL(rec, c);
  const secretName = readString(rec, "secretName", c);
  const configuredPath = readString(rec, "path", c, { max: 100 });
  const timeoutMs = readInt(rec, "timeoutMs", c, 100, 600_000);
  const maxResponseBytes = readInt(rec, "maxResponseBytes", c, 1024, 512 * 1024 * 1024);
  const maxDocs = readInt(rec, "maxDocs", c, 1, 100_000);
  const retry = readRetry(rec, c, RERANK_RETRY);
  checkKnownKeys(rec, RERANK_KEYS, c);

  if (!provider) return c.done() as never;
  const spec = RERANK_SPECS[provider];
  const baseURL = configuredBase ?? spec.baseURL;
  if (rec["baseURL"] === undefined && baseURL === undefined) c.add("baseURL", `required for provider "${provider}"`);
  if (spec.modelRequired && rec["model"] === undefined) c.add("model", `required for provider "${provider}"`);
  if (spec.secret === "required" && rec["secretName"] === undefined) c.add("secretName", `required for provider "${provider}"`);
  let resolvedPath = spec.path;
  if (configuredPath !== undefined) {
    if (!spec.paths) c.add("path", `not configurable for provider "${provider}"`);
    else if (!spec.paths.includes(configuredPath)) c.add("path", `must be one of ${spec.paths.join(", ")}`);
    else resolvedPath = configuredPath;
  }
  c.done();

  return {
    provider,
    ...(model !== undefined ? { model } : {}),
    baseURL: baseURL as string,
    path: resolvedPath,
    ...(secretName !== undefined ? { secretName } : {}),
    timeoutMs: timeoutMs ?? 5000,
    maxResponseBytes: maxResponseBytes ?? RERANK_MAX_RESPONSE_BYTES_DEFAULT,
    maxDocs: maxDocs ?? spec.maxDocs,
    splitOversized: spec.splitOversized,
    retry,
  };
}
