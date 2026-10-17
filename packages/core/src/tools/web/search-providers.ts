// The keyed web.search providers (D95): Brave Search, Tavily and Exa. Each one maps the normalised `SearchQuery` onto its
// vendor API and the vendor's JSON onto `RawSearchResult[]`; `createWebSearch` (search.ts) then strips markup, caps
// lengths and stamps provenance, exactly as for SearXNG.
//
// This module opens no socket: the HTTP call is the injected `request` (the guarded, egress-checked client in
// search-http.ts in production, a fake in tests). It also holds no key: `apiKey()` hands one over per call, and the key
// travels only in a request header. It never appears in a URL, a failure message, a hint or a trace.
//
// Failures are typed and carry fixed text plus the status code, never the vendor's body (it may echo the key or the
// query). A 429 sets a cooldown from `Retry-After`, so later calls fail fast without touching the API.
import { WebFailure } from "./failure.ts";
import type { RawSearchResult, SearchProvider, SearchQuery } from "./search.ts";

export const KEYED_PROVIDER_IDS = ["brave", "tavily", "exa"] as const;
export type KeyedProviderId = (typeof KEYED_PROVIDER_IDS)[number];

export interface ApiRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** One vendor call. Must honour `signal`, cap the body and refuse redirects. */
export type ApiClient = (req: ApiRequest, o: { signal?: AbortSignal | undefined }) => Promise<ApiReply>;

export const DEFAULT_ENDPOINTS: Readonly<Record<KeyedProviderId, string>> = Object.freeze({
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
  exa: "https://api.exa.ai/search",
});

/** The hosts the egress policy must list (`egress.allowHosts`) before a keyed provider can be reached. */
export const PROVIDER_HOSTS: Readonly<Record<KeyedProviderId, string>> = Object.freeze({ brave: "api.search.brave.com", tavily: "api.tavily.com", exa: "api.exa.ai" });

// ---- rate limiting ---------------------------------------------------------------------------------------------

export interface RateLimiter {
  /** Milliseconds left of a cooldown set by a 429; 0 when none. */
  coolingMs(): number;
  startCooldown(ms: number): void;
  /** Milliseconds to wait before the next request may go out, or `undefined` when that exceeds `maxWaitMs` (nothing is reserved then). */
  reserve(maxWaitMs: number): number | undefined;
}

export interface RateLimiterOptions {
  now?: (() => number) | undefined;
  /** Spacing between two requests to the same provider. 0 = none. */
  minIntervalMs?: number | undefined;
}

export function createRateLimiter(o: RateLimiterOptions = {}): RateLimiter {
  const now = o.now ?? Date.now;
  const spacing = Math.max(0, o.minIntervalMs ?? 0);
  let nextAt = 0;
  let coolUntil = 0;
  return {
    coolingMs: () => Math.max(0, coolUntil - now()),
    startCooldown(ms) {
      coolUntil = Math.max(coolUntil, now() + Math.max(0, ms));
    },
    reserve(maxWaitMs) {
      const t = now();
      const slot = Math.max(t, nextAt);
      if (slot - t > maxWaitMs) return undefined;
      nextAt = slot + spacing;
      return slot - t;
    },
  };
}

/** Seconds from `Retry-After` (delta-seconds or HTTP-date), else a bare `x-ratelimit-reset`; clamped to 0..3600; undefined when absent or unreadable. */
export function retryAfterSeconds(headers: ApiReply["headers"], nowMs: number): number | undefined {
  const one = (name: string): string | undefined => {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim();
  };
  const clamp = (n: number): number => Math.min(3600, Math.max(0, Math.ceil(n)));
  const ra = one("retry-after");
  if (ra !== undefined && ra !== "") {
    if (/^\d{1,9}$/.test(ra)) return clamp(Number(ra));
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return clamp((at - nowMs) / 1000);
  }
  // Brave sends `X-RateLimit-Reset: 1, 3600` (seconds until each window resets); the first number is the shortest window.
  const reset = one("x-ratelimit-reset")?.split(",")[0]?.trim();
  if (reset !== undefined && /^\d{1,9}$/.test(reset)) return clamp(Number(reset));
  return undefined;
}

// ---- vendor mappings -------------------------------------------------------------------------------------------

interface Spec {
  label: string;
  build(q: SearchQuery, key: string, endpoint: string, nowMs: number): ApiRequest;
  parse(doc: unknown): RawSearchResult[] | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
// Vendors print zone-less timestamps ("2026-09-01T00:00:00"); `Date.parse` would read them as host-local time.
const utc = (s: string): string => (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? `${s}Z` : s);
const FRESH_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;

const brave: Spec = {
  label: "Brave Search",
  build(q, key, endpoint) {
    const u = new URL(endpoint);
    u.searchParams.set("q", q.site ? `${q.query} site:${q.site}` : q.query);
    u.searchParams.set("count", String(Math.min(q.count, 20)));
    u.searchParams.set("result_filter", "web");
    if (q.freshness) u.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[q.freshness]);
    if (q.lang) u.searchParams.set("search_lang", q.lang.split("-")[0]!.toLowerCase());
    return { method: "GET", url: u.href, headers: { accept: "application/json", "x-subscription-token": key } };
  },
  parse(doc) {
    const web = rec(rec(doc)?.web);
    const results = web?.results;
    // A query without web hits omits the `web` object altogether; that is an empty answer, not a broken one.
    if (web === undefined) return rec(doc) && "type" in (doc as object) ? [] : undefined;
    if (!Array.isArray(results)) return undefined;
    const out: RawSearchResult[] = [];
    for (const item of results) {
      const e = rec(item);
      if (!e) continue;
      const published = str(e.page_age);
      out.push({ title: str(e.title) ?? "", url: str(e.url) ?? "", ...(str(e.description) !== undefined ? { snippet: str(e.description)! } : {}), ...(published ? { publishedAt: utc(published) } : {}) });
    }
    return out;
  },
};

const tavily: Spec = {
  label: "Tavily",
  build(q, key, endpoint) {
    const body: Record<string, unknown> = { query: q.query, max_results: Math.min(q.count, 20), search_depth: "basic", topic: "general", include_answer: false, include_raw_content: false, include_images: false };
    if (q.freshness) body.time_range = q.freshness;
    if (q.site) body.include_domains = [q.site];
    return { method: "POST", url: endpoint, headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) };
  },
  parse(doc) {
    const results = rec(doc)?.results;
    if (!Array.isArray(results)) return undefined;
    const out: RawSearchResult[] = [];
    for (const item of results) {
      const e = rec(item);
      if (!e) continue;
      const published = str(e.published_date);
      out.push({ title: str(e.title) ?? "", url: str(e.url) ?? "", ...(str(e.content) !== undefined ? { snippet: str(e.content)! } : {}), ...(published ? { publishedAt: utc(published) } : {}) });
    }
    return out;
  },
};

const exa: Spec = {
  label: "Exa",
  build(q, key, endpoint, nowMs) {
    const body: Record<string, unknown> = { query: q.query, numResults: Math.min(q.count, 20), type: "auto", contents: { text: { maxCharacters: 600 } } };
    if (q.site) body.includeDomains = [q.site];
    if (q.freshness) body.startPublishedDate = new Date(nowMs - FRESH_DAYS[q.freshness] * 86_400_000).toISOString();
    return { method: "POST", url: endpoint, headers: { accept: "application/json", "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) };
  },
  parse(doc) {
    const results = rec(doc)?.results;
    if (!Array.isArray(results)) return undefined;
    const out: RawSearchResult[] = [];
    for (const item of results) {
      const e = rec(item);
      if (!e) continue;
      const highlights = Array.isArray(e.highlights) ? e.highlights.filter((h): h is string => typeof h === "string").join(" … ") : "";
      const snippet = highlights || str(e.text) || str(e.summary);
      const published = str(e.publishedDate);
      out.push({ title: str(e.title) ?? "", url: str(e.url) ?? "", ...(snippet ? { snippet } : {}), ...(published ? { publishedAt: utc(published) } : {}) });
    }
    return out;
  },
};

const SPECS: Readonly<Record<KeyedProviderId, Spec>> = { brave, tavily, exa };

// ---- the provider ----------------------------------------------------------------------------------------------

export interface KeyedProviderOptions {
  request: ApiClient;
  /** The API key from the secret store, or null when none is configured. Called per search, never cached here. */
  apiKey(): Promise<string | null>;
  /** Overrides the vendor URL (tests point it at a local stub). */
  endpoint?: string | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  limiter?: RateLimiter | undefined;
  /** A 429 whose Retry-After is at most this long is waited out once inside the call. Default 2000 ms. */
  maxInlineWaitMs?: number | undefined;
  /** Cooldown after a 429 without a usable Retry-After. Default 30 s. */
  defaultCooldownSeconds?: number | undefined;
  /** Reported once per call with the failure that ended it, or `undefined` on success. */
  onOutcome?: ((failure: WebFailure | undefined) => void) | undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WebFailure("timeout", "the search was cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new WebFailure("timeout", "the search was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function createKeyedProvider(id: KeyedProviderId, o: KeyedProviderOptions): SearchProvider {
  const spec = SPECS[id];
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const limiter = o.limiter ?? createRateLimiter({ now });
  const endpoint = o.endpoint ?? DEFAULT_ENDPOINTS[id];
  const maxInline = o.maxInlineWaitMs ?? 2000;
  const defaultCooldown = o.defaultCooldownSeconds ?? 30;
  const limited = (why: string, seconds: number | undefined): WebFailure => new WebFailure("rate-limited", `${spec.label} ${why}`, seconds === undefined ? {} : { retryAfterSeconds: seconds });

  async function once(q: SearchQuery, key: string, signal: AbortSignal | undefined): Promise<ApiReply> {
    const cooling = limiter.coolingMs();
    if (cooling > 0) throw limited("is cooling down after a rate-limit answer", Math.ceil(cooling / 1000));
    const wait = limiter.reserve(maxInline);
    if (wait === undefined) throw limited("is being asked too often", 1);
    if (wait > 0) await sleep(wait, signal);
    const req = spec.build(q, key, endpoint, now());
    try {
      return await o.request(req, { signal });
    } catch (err) {
      // The transport's typed failures (egress denial, timeout, TLS, unreachable) pass through with the key scrubbed from
      // their text; anything else is reduced to a fixed sentence.
      if (err instanceof WebFailure) throw new WebFailure(err.code, scrub(err.message, key), err.extra);
      throw new WebFailure("network-error", `${spec.label} could not be reached`);
    }
  }

  function failureFor(reply: ApiReply): WebFailure {
    const s = reply.status;
    if (s === 401 || s === 403) return new WebFailure("http-error", `${spec.label} rejected the API key (HTTP ${s}): store a valid key under the configured secret name`, { status: s });
    if (s === 402 || s === 432 || s === 433) return new WebFailure("rate-limited", `${spec.label} refused the request because the plan's quota is used up (HTTP ${s})`, { status: s });
    if (s === 429) return new WebFailure("rate-limited", `${spec.label} rate-limited the request (429)`, { status: 429 });
    return new WebFailure("http-error", `${spec.label} answered HTTP ${s}`, { status: s });
  }

  return {
    id,
    async search(q, signal) {
      let key: string | undefined;
      try {
        const k = await o.apiKey();
        if (k === null || k === "") throw new WebFailure("no-provider", `no API key is stored for ${spec.label}`);
        key = k;
        let reply = await once(q, k, signal);
        if (reply.status === 429) {
          const secs = retryAfterSeconds(reply.headers, now());
          if (secs !== undefined && secs * 1000 <= maxInline) {
            await sleep(secs * 1000, signal);
            reply = await once(q, k, signal);
          }
          if (reply.status === 429) {
            const again = retryAfterSeconds(reply.headers, now()) ?? secs;
            limiter.startCooldown((again ?? defaultCooldown) * 1000);
            throw new WebFailure("rate-limited", `${spec.label} rate-limited the request (429)`, { status: 429, ...(again !== undefined ? { retryAfterSeconds: again } : { retryAfterSeconds: defaultCooldown }) });
          }
        }
        if (reply.status < 200 || reply.status >= 300) {
          const f = failureFor(reply);
          if (f.code === "rate-limited") limiter.startCooldown((retryAfterSeconds(reply.headers, now()) ?? 300) * 1000);
          throw f;
        }
        let doc: unknown;
        try {
          doc = JSON.parse(reply.body.toString("utf8"));
        } catch {
          throw new WebFailure("http-error", `${spec.label} sent an invalid JSON answer`);
        }
        const results = spec.parse(doc);
        if (results === undefined) throw new WebFailure("http-error", `${spec.label} sent an unexpected JSON answer (no results list)`);
        o.onOutcome?.(undefined);
        return results;
      } catch (err) {
        const f = err instanceof WebFailure ? err : new WebFailure("internal-error", "unexpected failure");
        const out = key === undefined ? f : new WebFailure(f.code, scrub(f.message, key), f.extra);
        o.onOutcome?.(out);
        throw out;
      }
    },
  };
}

/** Removes the key, and its URL-encoded form, from a text. */
export function scrub(text: string, key: string): string {
  if (key === "") return text;
  let t = text.split(key).join("[redacted]");
  const enc = encodeURIComponent(key);
  if (enc !== key) t = t.split(enc).join("[redacted]");
  return t;
}
