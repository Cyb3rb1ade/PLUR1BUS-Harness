// Ollama /api/embed: {model, input[], truncate:false} -> {embeddings:[[...]]}, positional. No auth by default.
import { AdapterError } from "../errors.ts";
import { bearer, joinUrl, type EmbeddingWire } from "./base.ts";

export const ollamaWire: EmbeddingWire = {
  buildRequest({ settings, texts }, secret) {
    const body: Record<string, unknown> = { model: settings.model, input: texts, truncate: false };
    if (settings.sendDimensions) body["dimensions"] = settings.dimensions;
    return { url: joinUrl(settings.baseURL, settings.path), headers: bearer(secret), body };
  },
  parseResponse(json, _count, provider) {
    const list = (json as { embeddings?: unknown } | null)?.embeddings;
    if (!Array.isArray(list)) throw new AdapterError("bad_response", "expected an embeddings array", { provider });
    return list;
  },
};
