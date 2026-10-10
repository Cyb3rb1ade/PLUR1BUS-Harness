// The SearXNG provider for web.search (D95). It speaks SearXNG's JSON API (`/search?format=json`) through an injected
// `request`, so the caller decides which address may be reached; this module never opens a socket itself.
//
// The answer is untrusted text: `createWebSearch` strips markup and control characters, caps lengths and drops
// non-http(s) URLs. What this module adds is the wire mapping and typed failures that never carry the query.
import { WebFailure } from "./failure.ts";
import type { RawSearchResult, SearchProvider, SearchQuery } from "./search.ts";

export interface SearxngReply {
  status: number;
  body: Buffer;
}

export interface SearxngRequestOptions {
  signal?: AbortSignal | undefined;
}

export interface SearxngOptions {
  /** Base URL of the SearXNG instance, with an optional path prefix and no query. */
  baseUrl: URL;
  /** One GET. Must refuse non-JSON 2xx answers, cap the body and not follow redirects. */
  request(url: string, o: SearxngRequestOptions): Promise<SearxngReply>;
  /** Reported once per call with the failure that ended it, or `undefined` on success. */
  onOutcome?: (failure: WebFailure | undefined) => void;
}

// SearXNG's `time_range` knows day, month and year only; a week is the closest bound that does not lose results.
const TIME_RANGE = { day: "day", week: "month", month: "month", year: "year" } as const;

export function searxngUrl(base: URL, q: SearchQuery): string {
  const u = new URL(base.href);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/search`;
  u.search = "";
  u.searchParams.set("q", q.site ? `${q.query} site:${q.site}` : q.query);
  u.searchParams.set("format", "json");
  u.searchParams.set("pageno", "1");
  if (q.lang) u.searchParams.set("language", q.lang);
  if (q.freshness) u.searchParams.set("time_range", TIME_RANGE[q.freshness]);
  return u.href;
}

function statusFailure(status: number): WebFailure {
  if (status === 403) return new WebFailure("http-error", "SearXNG refused the JSON format (403): enable `json` under search.formats in its settings.yml", { status });
  if (status === 429) return new WebFailure("rate-limited", "SearXNG rate-limited the request (429)", { status });
  return new WebFailure("http-error", `SearXNG answered HTTP ${status}`, { status });
}

// SearXNG prints `publishedDate` without a zone ("2026-09-01T00:00:00"); `Date.parse` would read that as host-local time.
const utc = (s: string): string => (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? `${s}Z` : s);

function parse(body: Buffer): RawSearchResult[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WebFailure("http-error", "SearXNG sent an invalid JSON answer");
  }
  const results = doc !== null && typeof doc === "object" ? (doc as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) throw new WebFailure("http-error", "SearXNG sent an invalid JSON answer (no results list)");
  const out: RawSearchResult[] = [];
  for (const item of results) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    out.push({
      title: typeof e.title === "string" ? e.title : "",
      url: typeof e.url === "string" ? e.url : "",
      ...(typeof e.content === "string" ? { snippet: e.content } : {}),
      ...(typeof e.publishedDate === "string" ? { publishedAt: utc(e.publishedDate) } : {}),
    });
  }
  return out;
}

export function createSearxngProvider(o: SearxngOptions): SearchProvider {
  return {
    id: "searxng",
    async search(q, signal) {
      try {
        const reply = await o.request(searxngUrl(o.baseUrl, q), { signal });
        if (reply.status < 200 || reply.status >= 300) throw statusFailure(reply.status);
        const results = parse(reply.body);
        o.onOutcome?.(undefined);
        return results;
      } catch (err) {
        const failure = err instanceof WebFailure ? err : new WebFailure("internal-error", "unexpected failure");
        o.onOutcome?.(failure);
        throw failure;
      }
    },
  };
}
