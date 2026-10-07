// The shared rerank pipeline: argument validation, document-count limit (split or too_large), secret, retry, strict
// parsing, ordering. Scores of a split request come from pairwise scorers and stay comparable across the parts; hosted
// listwise APIs are never split because their scores are only valid within one call.
import type { RerankSettings } from "../config.ts";
import { AdapterError, isAdapterError } from "../errors.ts";
import { postJson } from "../http.ts";
import { withRetry } from "../retry.ts";
import { resolveSecret } from "../secret.ts";
import type { RerankAdapter, RerankOptions, RerankResult, ResolvedDeps } from "../types.ts";
import { joinUrl, bearer } from "../embedding/base.ts";
import { buildRerankBody, parseRerankResponse, RERANK_SHAPES } from "./shapes.ts";

export function makeRerankAdapter(settings: RerankSettings, deps: ResolvedDeps): RerankAdapter {
  const provider = settings.provider;
  const shape = RERANK_SHAPES[provider];
  const url = joinUrl(settings.baseURL, settings.path);

  async function run(query: string, docs: readonly string[], opts: RerankOptions): Promise<RerankResult[]> {
    if (typeof query !== "string" || query === "") throw new AdapterError("invalid_request", "query must be a non-empty string", { provider });
    if (!Array.isArray(docs) || docs.some((d) => typeof d !== "string")) throw new AdapterError("invalid_request", "docs must be an array of strings", { provider });
    const topN = opts.topN;
    if (topN !== undefined && (!Number.isInteger(topN) || topN < 1)) throw new AdapterError("invalid_request", "topN must be a positive integer", { provider });
    if (opts.signal?.aborted) throw new AdapterError("aborted", "aborted before the request was sent", { provider });
    if (docs.length === 0) return [];
    if (docs.length > settings.maxDocs && !settings.splitOversized) {
      throw new AdapterError("too_large", `${docs.length} documents exceed the limit of ${settings.maxDocs} for one ${provider} rerank call`, { provider });
    }

    const secret = await resolveSecret(deps.getSecret, settings.secretName, provider);
    const secrets = secret === undefined ? [] : [secret];
    const parts: Array<{ offset: number; docs: readonly string[] }> = [];
    for (let offset = 0; offset < docs.length; offset += settings.maxDocs) parts.push({ offset, docs: docs.slice(offset, offset + settings.maxDocs) });

    const all: RerankResult[] = [];
    for (const part of parts) {
      // A split request needs every score to merge correctly, so topN is only pushed to the server for a single call.
      const partTopN = parts.length === 1 ? topN : undefined;
      const body = buildRerankBody(shape, settings, query, part.docs, partTopN);
      const json = await withRetry(
        () => postJson({ provider, url, headers: bearer(secret), body, timeoutMs: settings.timeoutMs, maxResponseBytes: settings.maxResponseBytes, ...(opts.signal ? { signal: opts.signal } : {}), secrets }, { fetch: deps.fetch, now: deps.now }),
        settings.retry,
        { sleep: deps.sleep, random: deps.random, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      let parsed: RerankResult[];
      try {
        parsed = parseRerankResponse(json, shape, part.docs.length, partTopN);
      } catch (e) {
        if (isAdapterError(e)) throw e;
        throw new AdapterError("bad_response", "response has an unexpected shape", { provider });
      }
      for (const r of parsed) all.push({ index: r.index + part.offset, score: r.score });
    }
    // Best first; equal scores keep document order so the result is deterministic.
    all.sort((a, b) => b.score - a.score || a.index - b.index);
    return topN === undefined ? all : all.slice(0, topN);
  }

  return {
    id: `${provider}:${settings.model ?? "default"}`,
    async rerank(query, docs, opts = {}) {
      try {
        return await run(query, docs, opts);
      } catch (e) {
        if (isAdapterError(e)) throw e;
        throw new AdapterError("bad_response", "unexpected internal failure while reranking", { provider });
      }
    },
  };
}
