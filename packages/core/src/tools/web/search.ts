// web.search (D95): one normalised tool over pluggable providers. This module owns the contract — the provider
// interface, argument validation, fallback order, normalisation and provenance — and ships NO provider that talks to
// the network; SearXNG, Brave, Tavily, Exa and a model's native search each implement `SearchProvider` elsewhere.
//
// Everything a provider returns is untrusted text: markup and control characters are stripped, lengths capped,
// unknown fields dropped, non-http(s) URLs discarded, and the answer carries a provenance envelope.
import { WebFailure } from "./failure.ts";
import { decodeEntities } from "./html.ts";

export interface SearchQuery {
  query: string;
  count: number;
  freshness?: "day" | "week" | "month" | "year";
  site?: string;
  lang?: string;
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

export interface SearchProvider {
  /** Stable id shown in results and traces, e.g. "searxng", "brave". */
  id: string;
  /** Must honour `signal`; a provider that ignores it is still bounded by the per-provider timeout. */
  search(query: SearchQuery, signal?: AbortSignal): Promise<RawSearchResult[]>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  /** The result's host. The provider that found it is `WebSearchResult.provider`. */
  source: string;
}

export interface SkippedProvider {
  provider: string;
  reason: "timeout" | "error" | "invalid-response";
}

export interface WebSearchResult {
  results: SearchResult[];
  provider: string;
  /** Providers tried before `provider` that failed — ids and reasons only, never error text (it may carry keys). */
  skipped: SkippedProvider[];
  provenance: { source: "web.search"; provider: string; retrievedAt: string; trust: "untrusted" };
}

export interface SearchTrace {
  tool: "web.search";
  provider?: string;
  results?: number;
  queryChars: number;
  skipped: SkippedProvider[];
  ms: number;
  error?: string;
}

export interface WebSearchConfig {
  /** Fallback order. Copied at creation: the provider is an agent setting, never switched mid-session (ADR-010 R4). */
  providers: readonly SearchProvider[];
  /** Per-provider limit. Default 10 s. */
  timeoutMs?: number;
  now?: () => number;
  trace?: (e: SearchTrace) => void;
}

export interface WebSearchArgs {
  query: string;
  count?: number;
  freshness?: "day" | "week" | "month" | "year";
  site?: string;
  lang?: string;
}

export interface WebSearch {
  search(args: WebSearchArgs, ctx?: { signal?: AbortSignal }): Promise<WebSearchResult>;
}

const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

function validate(a: WebSearchArgs): SearchQuery {
  const bad = (m: string): never => {
    throw new WebFailure("invalid-arguments", m);
  };
  if (a === null || typeof a !== "object") bad("arguments must be an object");
  for (const k of Object.keys(a)) if (!["query", "count", "freshness", "site", "lang"].includes(k)) bad(`unknown argument ${JSON.stringify(k)}`);
  if (typeof a.query !== "string" || a.query.trim() === "" || a.query.length > 500) bad("query must be a non-empty string of at most 500 characters");
  if (a.count !== undefined && (!Number.isInteger(a.count) || a.count < 1 || a.count > MAX_COUNT)) bad(`count must be an integer from 1 to ${MAX_COUNT}`);
  if (a.freshness !== undefined && !["day", "week", "month", "year"].includes(a.freshness)) bad('freshness must be "day", "week", "month" or "year"');
  if (a.site !== undefined && (typeof a.site !== "string" || a.site.length > 253 || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(a.site))) bad("site must be a host name such as docs.example.com");
  if (a.lang !== undefined && (typeof a.lang !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(a.lang))) bad("lang must be a language tag such as en or de-CH");
  return {
    query: a.query.trim(),
    count: a.count ?? DEFAULT_COUNT,
    ...(a.freshness ? { freshness: a.freshness } : {}),
    ...(a.site ? { site: a.site.toLowerCase() } : {}),
    ...(a.lang ? { lang: a.lang } : {}),
  };
}

function clean(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  let t = s.replace(/<[^>]*>/g, " ");
  t = decodeEntities(t).replace(/<[^>]*>/g, " "); // an entity-encoded tag must not come back as markup
  t = t.replace(STRIP, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function normalise(raw: unknown[], q: SearchQuery): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.url !== "string") continue;
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "") continue;
    const host = u.hostname.toLowerCase();
    if (q.site && host !== q.site && !host.endsWith(`.${q.site}`)) continue;
    const title = clean(e.title, 200);
    if (title === "") continue;
    const key = u.href.split("#")[0]!;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = typeof e.publishedAt === "string" ? Date.parse(e.publishedAt) : Number.NaN;
    out.push({ title, url: u.href, snippet: clean(e.snippet, 500), ...(Number.isNaN(at) ? {} : { publishedAt: new Date(at).toISOString() }), source: host });
    if (out.length >= q.count) break;
  }
  return out;
}

export function createWebSearch(cfg: WebSearchConfig): WebSearch {
  const providers = Object.freeze([...cfg.providers]);
  const now = cfg.now ?? Date.now;
  const timeoutMs = cfg.timeoutMs ?? 10_000;

  async function ask(p: SearchProvider, q: SearchQuery, outer?: AbortSignal): Promise<RawSearchResult[]> {
    const ac = new AbortController();
    const onOuter = (): void => ac.abort();
    outer?.addEventListener("abort", onOuter, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p.search(q, ac.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new WebFailure("timeout", `provider ${p.id} timed out`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  }

  return {
    async search(args, ctx = {}) {
      const t0 = now();
      const skipped: SkippedProvider[] = [];
      let provider: string | undefined;
      let count: number | undefined;
      let error: string | undefined;
      try {
        const q = validate(args);
        if (providers.length === 0) throw new WebFailure("no-provider", "no search provider is configured");
        for (const p of providers) {
          if (ctx.signal?.aborted) throw new WebFailure("timeout", "the search was cancelled");
          let raw: RawSearchResult[];
          try {
            raw = await ask(p, q, ctx.signal);
          } catch (err) {
            if (ctx.signal?.aborted) throw new WebFailure("timeout", "the search was cancelled");
            skipped.push({ provider: p.id, reason: err instanceof WebFailure && err.code === "timeout" ? "timeout" : "error" });
            continue;
          }
          if (!Array.isArray(raw)) {
            skipped.push({ provider: p.id, reason: "invalid-response" });
            continue;
          }
          const results = normalise(raw, q);
          provider = p.id;
          count = results.length;
          return {
            results,
            provider: p.id,
            skipped,
            provenance: { source: "web.search", provider: p.id, retrievedAt: new Date(now()).toISOString(), trust: "untrusted" },
          };
        }
        throw new WebFailure("provider-failed", `all ${providers.length} search providers failed`);
      } catch (err) {
        error = err instanceof WebFailure ? err.code : "unexpected";
        throw err;
      } finally {
        // Provider, counts and timing only: neither the query text nor the results reach a trace.
        cfg.trace?.({ tool: "web.search", ...(provider ? { provider } : {}), ...(count !== undefined ? { results: count } : {}), queryChars: typeof args?.query === "string" ? args.query.trim().length : 0, skipped, ms: now() - t0, ...(error ? { error } : {}) });
      }
    },
  };
}
