import { RpcError } from "../rpc/errors.ts";

/** Production policy until the pinned engine exposes provider factories on its public host contract.
 * Never silently substitute local-transformers for an explicitly selected vector space.
 * Do not pass arbitrary provider ids into the engine's OpenAI-compatible fallback branch.
 */
export function assertEngineProviderPolicy(value: Record<string, unknown>, role: "embedding" | "reranker"): void {
  const provider = value.provider;
  if (provider === undefined || provider === "local-transformers") return;
  const selfHosted = typeof provider === "string" && ["ollama", "tei", "vllm", "llamacpp", "omlx", "mtplx"].includes(provider);
  throw new RpcError("E_NOT_AVAILABLE", selfHosted
    ? `${role}: the pinned engine has no public adapter factory; keep the current local model until production adapter integration is available`
    : `${role}: cloud and unknown providers are not enabled by the owner`,
  { reason: selfHosted ? "engine-adapter-factory-unavailable" : "embedding-provider-not-approved" });
}
