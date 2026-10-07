// Jina /v1/embeddings: OpenAI-shaped response; `task` selects the asymmetric adapter. Status: unverified live.
import { AdapterError } from "../errors.ts";
import { orderedEmbeddings } from "../validate.ts";
import { bearer, joinUrl, type EmbeddingWire } from "./base.ts";

export const jinaWire: EmbeddingWire = {
  buildRequest({ settings, texts, inputType }, secret) {
    const body: Record<string, unknown> = {
      model: settings.model,
      input: texts,
      task: inputType === "query" ? "retrieval.query" : "retrieval.passage",
      embedding_type: "float",
      truncate: false,
    };
    if (settings.sendDimensions) body["dimensions"] = settings.dimensions;
    return { url: joinUrl(settings.baseURL, settings.path), headers: bearer(secret), body };
  },
  parseResponse(json, count, provider) {
    if (typeof json !== "object" || json === null) throw new AdapterError("bad_response", "response is not an object", { provider });
    return orderedEmbeddings((json as { data?: unknown }).data, count, provider);
  },
};
