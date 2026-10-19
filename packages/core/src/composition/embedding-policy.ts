import { privacyAcknowledgmentError, type PrivacyAcknowledgment } from "@plur1bus/config-schema";
import { RpcError } from "../rpc/errors.ts";
import { assertLocalEndpoint, isLoopbackEndpoint } from "../privacy/local-only.ts";

/**
 * Which embedding/reranker provider the engine is built with (owner decision 2026-10-18: cloud embeddings and cloud
 * reranking must work, no provider is privileged). The checks follow only from the provider:
 * - required details (model, dimensions, key reference, endpoint) are present, otherwise a clear refusal;
 * - a key never stands in the configuration: only the name of the environment variable that holds it (`apiKeyEnv`);
 * - a remote text embedding needs the function-specific privacy acknowledgment (`memory.embedding.privacyAck`),
 *   bound to provider and endpoint; a loopback endpoint is local and needs none;
 * - never a silent substitution: no `fallback` model, no unknown key spelling the engine would ignore and so route to
 *   another endpoint. A different vector space is reached only through reembed.
 * Licence confirmation for pinned non-commercial models stays with `checkEngineConfigLicences`.
 *
 * - with privacy.localOnly on (owner decision 2026-10-18, "Nur lokal"), only a loopback endpoint or one listed in
 *   privacy.localEndpoints is accepted; anything else fails with E_DENIED reason local-only, never another model;
 * - a remote reranker needs its own acknowledgment (`memory.reranker.privacyAck`), bound to provider and endpoint.
 *
 * Production path in the pinned engine: embeddings other than local-transformers go through its OpenAI-compatible
 * client (`baseUrl`, `model`, `dimensions`, `apiKeyEnv`), which covers OpenAI, OpenRouter, Cohere's compatibility API,
 * Jina, Gemini's OpenAI endpoint and self-hosted servers. Remote reranking exists only for the Cohere API.
 */
export type ProviderPlan = { kind: "local" } | { kind: "remote"; block: Record<string, unknown> };
export interface ProviderPolicy { localOnly?: boolean; localEndpoints?: readonly string[] }

/** The endpoint the pinned engine's OpenAI-compatible client calls when `baseUrl` is left out (openai only). */
export const OPENAI_DEFAULT_ENDPOINT = "https://api.openai.com/v1";
/** The fixed endpoint of the pinned engine's Cohere reranker (`engine/providers/runtime-reranker.js`). */
export const COHERE_RERANK_ENDPOINT = "https://api.cohere.com/v2/rerank";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const isLocal = (p: unknown) => p === undefined || p === "local-transformers";

function incomplete(role: string, message: string, reason = "engine-provider-config-incomplete"): RpcError {
  return new RpcError("E_INVALID_PARAMS", `${role}: ${message}`, { reason });
}

function common(v: Record<string, unknown>, role: "embedding" | "reranker"): string {
  const provider = v.provider;
  if (typeof provider !== "string" || !PROVIDER_ID.test(provider)) throw incomplete(role, "provider must be a provider id (letters, digits, '.', '_', '-')", "engine-provider-invalid");
  if (v.apiKey !== undefined) throw incomplete(role, "apiKey is refused: a key never stands in the configuration; set apiKeyEnv to the name of the environment variable that holds it", "secret-in-config");
  if (typeof v.apiKeyEnv !== "string" || !ENV_NAME.test(v.apiKeyEnv)) throw incomplete(role, `provider ${provider} needs apiKeyEnv, the name of the environment variable that holds its key`);
  if (v.baseURL !== undefined) throw incomplete(role, "use baseUrl; the engine ignores baseURL and would call its default endpoint instead");
  return provider;
}

function endpoint(raw: unknown, role: string): URL {
  let url: URL | undefined;
  try { url = typeof raw === "string" ? new URL(raw) : undefined; } catch { url = undefined; }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw incomplete(role, "baseUrl must be an http(s) URL");
  if (url.username || url.password) throw incomplete(role, "baseUrl must not carry credentials; set apiKeyEnv instead", "secret-in-config");
  return url;
}

const loopback = (url: URL): boolean => isLoopbackEndpoint(url);

export function resolveEmbeddingProvider(v: Record<string, unknown>, privacyAck?: PrivacyAcknowledgment, policy: ProviderPolicy = {}): ProviderPlan {
  if (isLocal(v.provider)) return { kind: "local" };
  const role = "embedding";
  const provider = common(v, role);
  if (v.fallback !== undefined && v.fallback !== null) throw incomplete(role, "fallback is refused: another model would silently write a different vector space; change models through reembed", "embedding-fallback-refused");
  if (typeof v.model !== "string" || !v.model.trim()) throw incomplete(role, `provider ${provider} needs model`);
  if (!Number.isInteger(v.dimensions) || (v.dimensions as number) <= 0) throw incomplete(role, `provider ${provider} needs dimensions (a positive integer, the vector size of ${v.model})`);
  // Without baseUrl the engine's client calls api.openai.com: only the openai provider may leave it out.
  if (v.baseUrl === undefined && provider !== "openai") throw incomplete(role, `provider ${provider} needs baseUrl, its OpenAI-compatible endpoint`);
  const url = v.baseUrl === undefined ? undefined : endpoint(v.baseUrl, role);
  assertLocalEndpoint({ active: policy.localOnly === true, what: `${role} provider ${provider}`, endpoint: url ? url.href : OPENAI_DEFAULT_ENDPOINT, listed: policy.localEndpoints ?? [] });
  const failure = privacyAcknowledgmentError({ function: "text", provider, local: url ? loopback(url) : false, ...(url ? { endpoint: v.baseUrl as string } : {}), ack: privacyAck });
  if (failure) throw new RpcError(failure.code, `${role}: provider ${provider} sends memory text off this machine; ${failure.reason === "privacy-acknowledgment-required" ? "record memory.embedding.privacyAck for it" : `memory.embedding.privacyAck does not admit it (${failure.reason})`}`, { reason: failure.reason });
  const { local: _local, ...block } = v;
  return { kind: "remote", block: { ...block, provider } };
}

export function resolveRerankerProvider(v: Record<string, unknown>, privacyAck?: PrivacyAcknowledgment, policy: ProviderPolicy = {}): ProviderPlan {
  if (isLocal(v.provider)) return { kind: "local" };
  const role = "reranker";
  if (typeof v.provider === "string" && PROVIDER_ID.test(v.provider) && v.provider !== "cohere") {
    throw new RpcError("E_NOT_AVAILABLE", `${role}: the pinned engine reranks remotely only through the Cohere API; provider ${v.provider} has no engine adapter yet, and it is not replaced by another model`, { reason: "engine-adapter-factory-unavailable" });
  }
  const provider = common(v, role);
  if (v.baseUrl !== undefined) throw incomplete(role, "the pinned engine calls the Cohere endpoint itself; a configured baseUrl would be ignored");
  if (v.fallbackProvider !== undefined && v.fallbackProvider !== "disabled") throw incomplete(role, "fallbackProvider is refused: no silent switch to another reranker model", "reranker-fallback-refused");
  if (v.model !== undefined && (typeof v.model !== "string" || !v.model.trim())) throw incomplete(role, "model must be a non-empty string");
  assertLocalEndpoint({ active: policy.localOnly === true, what: `${role} provider ${provider}`, endpoint: COHERE_RERANK_ENDPOINT, listed: policy.localEndpoints ?? [] });
  // The endpoint is fixed by the engine, so the acknowledgment binds the provider alone (no endpoint field).
  const failure = privacyAcknowledgmentError({ function: "text", provider, local: false, ack: privacyAck });
  if (failure) throw new RpcError(failure.code, `${role}: provider ${provider} sends recalled memory text off this machine; ${failure.reason === "privacy-acknowledgment-required" ? "record memory.reranker.privacyAck for it" : `memory.reranker.privacyAck does not admit it (${failure.reason})`}`, { reason: failure.reason });
  const { local: _local, ...block } = v;
  return { kind: "remote", block: { ...block, provider, enabled: true, fallbackProvider: "disabled" } };
}

export interface EngineEndpoint { role: string; endpoint: string | undefined }

const MAX_DEPTH = 6;
/**
 * Every model endpoint the engine would call with this configuration: the remote embedding and reranker, and each engine
 * LLM feature with a transport of its own (`<feature>.baseUrl`, e.g. merging, skillMiner, emotion.t3). A feature that
 * names a key (`apiKey`/`apiKeyEnv`) but no `baseUrl` calls its provider's default endpoint, which is not on this
 * machine: it is listed with `endpoint: undefined`. Features without a transport use the host's routing, which the
 * harness does not offer (`host.ts`: routing absent), so they make no call of their own.
 */
export function engineModelEndpoints(engineConfig: Record<string, unknown>): EngineEndpoint[] {
  const out: EngineEndpoint[] = [];
  const emb = engineConfig.embedding as Record<string, unknown> | undefined, rer = engineConfig.reranker as Record<string, unknown> | undefined;
  if (emb && !isLocal(emb.provider)) out.push({ role: "embedding", endpoint: typeof emb.baseUrl === "string" ? emb.baseUrl : OPENAI_DEFAULT_ENDPOINT });
  if (rer && !isLocal(rer.provider)) out.push({ role: "reranker", endpoint: COHERE_RERANK_ENDPOINT });
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object" || Array.isArray(node)) return;
    const o = node as Record<string, unknown>;
    if (typeof o.baseUrl === "string") out.push({ role: path, endpoint: o.baseUrl });
    else if ((o.apiKey !== undefined && o.apiKey !== null && o.apiKey !== "") || typeof o.apiKeyEnv === "string") out.push({ role: path, endpoint: undefined });
    for (const [k, v] of Object.entries(o)) if (k !== "__proto__" && k !== "headers") walk(v, `${path}.${k}`, depth + 1);
  };
  for (const [k, v] of Object.entries(engineConfig)) if (k !== "embedding" && k !== "reranker" && k !== "__proto__") walk(v, k, 1);
  return out;
}

/** privacy.localOnly for the engine's own LLM features: the same rule as for embedding and reranker. */
export function assertEngineFeaturesLocal(engineConfig: Record<string, unknown>, policy: ProviderPolicy): void {
  if (policy.localOnly !== true) return;
  for (const e of engineModelEndpoints(engineConfig)) {
    if (e.role === "embedding" || e.role === "reranker") continue;
    assertLocalEndpoint({ active: true, what: `engine LLM feature ${e.role}`, endpoint: e.endpoint, listed: policy.localEndpoints ?? [] });
  }
}
