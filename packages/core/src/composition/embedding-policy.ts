import { privacyAcknowledgmentError, type PrivacyAcknowledgment } from "@plur1bus/config-schema";
import { RpcError } from "../rpc/errors.ts";

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
 * Production path in the pinned engine: embeddings other than local-transformers go through its OpenAI-compatible
 * client (`baseUrl`, `model`, `dimensions`, `apiKeyEnv`), which covers OpenAI, OpenRouter, Cohere's compatibility API,
 * Jina, Gemini's OpenAI endpoint and self-hosted servers. Remote reranking exists only for the Cohere API.
 */
export type ProviderPlan = { kind: "local" } | { kind: "remote"; block: Record<string, unknown> };

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

function loopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

export function resolveEmbeddingProvider(v: Record<string, unknown>, privacyAck?: PrivacyAcknowledgment): ProviderPlan {
  if (isLocal(v.provider)) return { kind: "local" };
  const role = "embedding";
  const provider = common(v, role);
  if (v.fallback !== undefined && v.fallback !== null) throw incomplete(role, "fallback is refused: another model would silently write a different vector space; change models through reembed", "embedding-fallback-refused");
  if (typeof v.model !== "string" || !v.model.trim()) throw incomplete(role, `provider ${provider} needs model`);
  if (!Number.isInteger(v.dimensions) || (v.dimensions as number) <= 0) throw incomplete(role, `provider ${provider} needs dimensions (a positive integer, the vector size of ${v.model})`);
  // Without baseUrl the engine's client calls api.openai.com: only the openai provider may leave it out.
  if (v.baseUrl === undefined && provider !== "openai") throw incomplete(role, `provider ${provider} needs baseUrl, its OpenAI-compatible endpoint`);
  const url = v.baseUrl === undefined ? undefined : endpoint(v.baseUrl, role);
  const failure = privacyAcknowledgmentError({ function: "text", provider, local: url ? loopback(url) : false, ...(url ? { endpoint: v.baseUrl as string } : {}), ack: privacyAck });
  if (failure) throw new RpcError(failure.code, `${role}: provider ${provider} sends memory text off this machine; ${failure.reason === "privacy-acknowledgment-required" ? "record memory.embedding.privacyAck for it" : `memory.embedding.privacyAck does not admit it (${failure.reason})`}`, { reason: failure.reason });
  const { local: _local, ...block } = v;
  return { kind: "remote", block: { ...block, provider } };
}

export function resolveRerankerProvider(v: Record<string, unknown>): ProviderPlan {
  if (isLocal(v.provider)) return { kind: "local" };
  const role = "reranker";
  if (typeof v.provider === "string" && PROVIDER_ID.test(v.provider) && v.provider !== "cohere") {
    throw new RpcError("E_NOT_AVAILABLE", `${role}: the pinned engine reranks remotely only through the Cohere API; provider ${v.provider} has no engine adapter yet, and it is not replaced by another model`, { reason: "engine-adapter-factory-unavailable" });
  }
  const provider = common(v, role);
  if (v.baseUrl !== undefined) throw incomplete(role, "the pinned engine calls the Cohere endpoint itself; a configured baseUrl would be ignored");
  if (v.fallbackProvider !== undefined && v.fallbackProvider !== "disabled") throw incomplete(role, "fallbackProvider is refused: no silent switch to another reranker model", "reranker-fallback-refused");
  if (v.model !== undefined && (typeof v.model !== "string" || !v.model.trim())) throw incomplete(role, "model must be a non-empty string");
  const { local: _local, ...block } = v;
  return { kind: "remote", block: { ...block, provider, enabled: true, fallbackProvider: "disabled" } };
}
