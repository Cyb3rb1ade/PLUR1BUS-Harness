// OpenAI /embeddings and everything that speaks it: vLLM, llama.cpp server, oMLX, other OpenAI-compatible servers, and
// OpenRouter (which adds upstream pinning). Verified wire format: request {model, input[], dimensions?, encoding_format},
// response {data:[{index, embedding}]}. Items are re-ordered by `index`; a missing or duplicate index is bad_response.
import { AdapterError } from "../errors.ts";
import { orderedEmbeddings } from "../validate.ts";
import { bearer, joinUrl, type EmbeddingWire } from "./base.ts";

export const openAiWire: EmbeddingWire = {
  buildRequest({ settings, texts }, secret) {
    const body: Record<string, unknown> = { model: settings.model, input: texts, encoding_format: "float" };
    if (settings.sendDimensions) body["dimensions"] = settings.dimensions;
    if (settings.provider === "openrouter" && settings.pinnedUpstream !== undefined) {
      // Pin the upstream so the vector space cannot change under us; no fallback to another provider.
      body["provider"] = { order: [settings.pinnedUpstream], allow_fallbacks: false };
    }
    return { url: joinUrl(settings.baseURL, settings.path), headers: bearer(secret), body };
  },
  parseResponse(json, count, provider) {
    if (typeof json !== "object" || json === null) throw new AdapterError("bad_response", "response is not an object", { provider });
    return orderedEmbeddings((json as { data?: unknown }).data, count, provider);
  },
};
