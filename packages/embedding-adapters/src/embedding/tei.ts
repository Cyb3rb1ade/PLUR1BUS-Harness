// Text Embeddings Inference /embed: {inputs[], truncate:false} -> root array of vectors, positional.
// TEI has no input type; asymmetric models need queryPrefix/passagePrefix in the config.
import { AdapterError } from "../errors.ts";
import { bearer, joinUrl, type EmbeddingWire } from "./base.ts";

export const teiWire: EmbeddingWire = {
  buildRequest({ settings, texts }, secret) {
    return { url: joinUrl(settings.baseURL, settings.path), headers: bearer(secret), body: { inputs: texts, truncate: false, normalize: false } };
  },
  parseResponse(json, _count, provider) {
    if (!Array.isArray(json)) throw new AdapterError("bad_response", "expected a root array of vectors", { provider });
    return json;
  },
};
