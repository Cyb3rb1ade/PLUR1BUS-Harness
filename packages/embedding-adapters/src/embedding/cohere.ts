// Cohere v2 /embed. input_type search_query | search_document, embedding_types ["float"].
// Response {embeddings:{float:[[...]]}}, positional. Status: unverified live (docs-derived).
import { AdapterError } from "../errors.ts";
import { bearer, joinUrl, type EmbeddingWire } from "./base.ts";

export const cohereWire: EmbeddingWire = {
  buildRequest({ settings, texts, inputType }, secret) {
    const body: Record<string, unknown> = {
      model: settings.model,
      texts,
      input_type: inputType === "query" ? "search_query" : "search_document",
      embedding_types: ["float"],
    };
    if (settings.sendDimensions) body["output_dimension"] = settings.dimensions;
    return { url: joinUrl(settings.baseURL, settings.path), headers: bearer(secret), body };
  },
  parseResponse(json, _count, provider) {
    const emb = (json as { embeddings?: { float?: unknown } } | null)?.embeddings;
    if (typeof emb !== "object" || emb === null || !Array.isArray(emb.float)) throw new AdapterError("bad_response", "expected embeddings.float", { provider });
    return emb.float;
  },
};
