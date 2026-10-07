// The shared embedding pipeline (G2/G3). A provider is only a "wire": how to build one request and how to read one
// response. Everything else (validation of inputs, prefixes, batching, secret lookup, retry, response validation,
// normalisation, ordering, identity) lives here once, so every provider gets identical safety properties.
import type { EmbeddingSettings } from "../config.ts";
import { AdapterError, isAdapterError } from "../errors.ts";
import { planBatches } from "../batching.ts";
import { resolveSecret } from "../secret.ts";
import { postJson } from "../http.ts";
import { withRetry } from "../retry.ts";
import { toFloat32Vectors } from "../validate.ts";
import { l2Normalize } from "../vector.ts";
import type { EmbeddingAdapter, EmbeddingIdentity, EmbedOptions, InputType, ResolvedDeps } from "../types.ts";

export interface WireRequestContext {
  settings: EmbeddingSettings;
  /** Already prefixed, already within the batch limits. */
  texts: string[];
  inputType: InputType;
}

export interface WireRequest {
  url: string;
  /** Without credentials; the pipeline adds nothing, the wire adds auth from `secret`. */
  headers: Record<string, string>;
  body: unknown;
}

export interface EmbeddingWire {
  /** `secret` is undefined when the provider is configured without one (local servers). */
  buildRequest(ctx: WireRequestContext, secret: string | undefined): WireRequest;
  /** Returns the raw vectors in input order, as parsed JSON. Throws AdapterError("bad_response") on an unexpected shape. */
  parseResponse(json: unknown, count: number, provider: string): unknown;
}

export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function bearer(secret: string | undefined): Record<string, string> {
  return secret === undefined ? {} : { authorization: `Bearer ${secret}` };
}

function identityOf(s: EmbeddingSettings): EmbeddingIdentity {
  const revision = s.revision ?? (s.pinnedUpstream !== undefined ? `upstream:${s.pinnedUpstream}` : undefined);
  return Object.freeze({
    provider: s.provider,
    model: s.model,
    ...(revision !== undefined ? { revision } : {}),
    dimensions: s.dimensions,
    normalize: s.normalize,
    maxBatch: s.maxBatch,
    maxInputTokens: s.maxInputTokens,
    ...(s.queryPrefix !== undefined ? { queryPrefix: s.queryPrefix } : {}),
    ...(s.passagePrefix !== undefined ? { passagePrefix: s.passagePrefix } : {}),
  });
}

export function makeEmbeddingAdapter(settings: EmbeddingSettings, wire: EmbeddingWire, deps: ResolvedDeps): EmbeddingAdapter {
  const identity = identityOf(settings);
  const provider = settings.provider;

  return {
    id: `${provider}:${settings.model}`,
    identity: () => identity,
    async embed(texts: readonly string[], opts: EmbedOptions): Promise<Float32Array[]> {
      try {
        return await run(texts, opts);
      } catch (e) {
        if (isAdapterError(e)) throw e;
        throw new AdapterError("bad_response", "unexpected internal failure while embedding", { provider });
      }
    },
  };

  async function run(texts: readonly string[], opts: EmbedOptions): Promise<Float32Array[]> {
    if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) throw new AdapterError("invalid_request", "texts must be an array of strings", { provider });
    const inputType = opts?.inputType;
    if (inputType !== "query" && inputType !== "document") throw new AdapterError("invalid_request", 'inputType must be "query" or "document"', { provider });
    if (opts.signal?.aborted) throw new AdapterError("aborted", "aborted before the request was sent", { provider });
    if (texts.length === 0) return [];

    const prefix = inputType === "query" ? settings.queryPrefix : settings.passagePrefix;
    const prepared = prefix === undefined ? [...texts] : texts.map((t) => prefix + t);
    const plan = planBatches(prepared, {
      maxBatch: settings.maxBatch,
      maxInputTokens: settings.maxInputTokens,
      ...(settings.maxBatchTokens !== undefined ? { maxBatchTokens: settings.maxBatchTokens } : {}),
      provider,
    });

    const secret = await resolveSecret(deps.getSecret, settings.secretName, provider);
    const secrets = secret === undefined ? [] : [secret];
    const out: Float32Array[] = new Array(prepared.length);
    // Sequential on purpose: predictable rate-limit behaviour and a hard bound on concurrent load against local servers.
    for (const group of plan) {
      const batch = group.map((i) => prepared[i] as string);
      const req = wire.buildRequest({ settings, texts: batch, inputType }, secret);
      const json = await withRetry(
        () => postJson({ provider, url: req.url, headers: req.headers, body: req.body, timeoutMs: settings.timeoutMs, maxResponseBytes: settings.maxResponseBytes, ...(opts.signal ? { signal: opts.signal } : {}), secrets }, { fetch: deps.fetch, now: deps.now }),
        settings.retry,
        { sleep: deps.sleep, random: deps.random, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      let raw: unknown;
      try {
        raw = wire.parseResponse(json, batch.length, provider);
      } catch (e) {
        if (isAdapterError(e)) throw e;
        throw new AdapterError("bad_response", "response has an unexpected shape", { provider });
      }
      const vectors = toFloat32Vectors(raw, { provider, expectedCount: batch.length, dimensions: settings.dimensions });
      group.forEach((originalIndex, k) => {
        const v = vectors[k] as Float32Array;
        out[originalIndex] = settings.normalize ? l2Normalize(v, provider) : v;
      });
    }
    return out;
  }
}
