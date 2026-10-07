// Google Generative Language API: models/{model}:batchEmbedContents (and :embedContent for a single text).
// Response carries no index, so order is positional and the count is validated by the pipeline.
// taskType: RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT. Status: shape from public docs, not yet live-verified (see docs).
import { AdapterError } from "../errors.ts";
import { joinUrl, type EmbeddingWire } from "./base.ts";

const modelName = (m: string): string => m.replace(/^models\//, "");

export const googleWire: EmbeddingWire = {
  buildRequest({ settings, texts, inputType }, secret) {
    const model = modelName(settings.model);
    const taskType = inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const entry = (text: string): Record<string, unknown> => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
      ...(settings.sendDimensions ? { outputDimensionality: settings.dimensions } : {}),
    });
    const headers: Record<string, string> = secret === undefined ? {} : { "x-goog-api-key": secret };
    const single = texts.length === 1;
    const method = single ? "embedContent" : "batchEmbedContents";
    return {
      url: `${joinUrl(settings.baseURL, settings.path)}/${encodeURIComponent(model)}:${method}`,
      headers,
      body: single ? entry(texts[0] as string) : { requests: texts.map(entry) },
    };
  },
  parseResponse(json, count, provider) {
    const rec = json as Record<string, unknown> | null;
    if (typeof rec !== "object" || rec === null) throw new AdapterError("bad_response", "response is not an object", { provider });
    if (count === 1 && rec["embedding"] !== undefined) {
      const values = (rec["embedding"] as { values?: unknown } | null)?.values;
      return [values];
    }
    const list = rec["embeddings"];
    if (!Array.isArray(list)) throw new AdapterError("bad_response", "expected an embeddings array", { provider });
    return list.map((e: unknown) => (e as { values?: unknown } | null)?.values);
  },
};
