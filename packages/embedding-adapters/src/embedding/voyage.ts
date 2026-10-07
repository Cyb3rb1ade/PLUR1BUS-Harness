// Voyage /v1/embeddings: input_type query | document, output_dimension. OpenAI-shaped response. Status: unverified live.
import { AdapterError } from "../errors.ts";
import { orderedEmbeddings } from "../validate.ts";
import { bearer, joinUrl, type EmbeddingWire } from "./base.ts";

export const voyageWire: EmbeddingWire = {
  buildRequest({ settings, texts, inputType }, secret) {
    const body: Record<string, unknown> = { model: settings.model, input: texts, input_type: inputType, truncation: false };
    if (settings.sendDimensions) body["output_dimension"] = settings.dimensions;
    return { url: joinUrl(settings.baseURL, settings.path), headers: bearer(secret), body };
  },
  parseResponse(json, count, provider) {
    if (typeof json !== "object" || json === null) throw new AdapterError("bad_response", "response is not an object", { provider });
    return orderedEmbeddings((json as { data?: unknown }).data, count, provider);
  },
};
