// web.fetch (D94): the pipeline from URL to a provenance-stamped, sectioned Markdown result. Every network hop goes
// through `guardedRequest` (SSRF guard, pinned connect, size and time caps). Out of scope for this module and
// reported as typed failures instead: PDF/Office/image content (`unsupported-type`), the headless render fallback
// (`needs-render`).
import { randomBytes } from "node:crypto";
import { WebFailure, type WebFailureCode } from "./failure.ts";
import { guardedRequest, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, type HttpResponse } from "./http.ts";
import { makeAddressPolicy, systemResolver, type Resolver } from "./guard.ts";
import { decodeBody, estimateTokens, htmlToMarkdown, splitSections, type Section } from "./html.ts";
import { HostPacer, parseRobots, robotsAllows, type Robots } from "./robots.ts";

export interface WebFetchArgs {
  url: string;
  mode?: "auto" | "markdown" | "raw";
  section?: string;
  cursor?: string;
  maxTokens?: number;
  /** Set when following links beyond the page that was asked for: consults robots.txt and paces per host. */
  crawl?: boolean;
}

export interface SectionRef {
  id: string;
  title: string;
  tokens: number;
}

export interface Provenance {
  source: "web";
  url: string;
  fetchedAt: string;
  /** Web content is data, never instructions (the same rule as M5 peer output). */
  trust: "untrusted";
}

export interface WebFetchMeta {
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  lang?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  sections: SectionRef[];
  fetchedAt: string;
  provenance: Provenance;
}

export interface WebFetchResult extends WebFetchMeta {
  markdown: string;
  cursor?: string;
  renderUsed: false;
  fromCache: boolean;
}

export interface TraceEvent {
  tool: "web.fetch";
  url: string;
  finalUrl?: string;
  status?: number;
  bytes?: number;
  ms: number;
  fromCache?: boolean;
  error?: WebFailureCode;
}

export interface WebFetchConfig {
  resolver?: Resolver;
  /** Explicit per-installation CIDR allowlist for private ranges (D94). Default: none. */
  allowPrivate?: readonly string[];
  version?: string;
  userAgent?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  defaultMaxTokens?: number;
  /** Cap on extracted text; above it the call fails loudly rather than truncating silently. Default 200 000. */
  maxExtractedTokens?: number;
  store?: DocStore;
  pacer?: HostPacer;
  now?: () => number;
  trace?: (e: TraceEvent) => void;
  tlsCa?: string;
}

export interface WebFetchContext {
  signal?: AbortSignal;
  /** Cursors are bound to the agent that obtained them. */
  agentId?: string;
}

export interface WebFetch {
  fetch(args: WebFetchArgs, ctx?: WebFetchContext): Promise<WebFetchResult>;
}

// ------------------------------------------------------------ cursor store

interface StoreEntry {
  text: string;
  meta: WebFetchMeta;
  requestedUrl?: string;
}

/** Holds the remainder of a long document for its cursor. Bounded in count and age; keyed per agent. */
export class DocStore {
  private readonly docs = new Map<string, StoreEntry & { agent: string; expires: number }>();
  private readonly maxDocs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxDocs?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxDocs = opts.maxDocs ?? 32;
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  put(agent: string, entry: StoreEntry): string {
    const id = randomBytes(6).toString("hex");
    this.docs.set(id, { ...entry, agent, expires: this.now() + this.ttlMs });
    while (this.docs.size > this.maxDocs) this.docs.delete(this.docs.keys().next().value as string);
    return id;
  }

  get(agent: string, id: string): StoreEntry | undefined {
    const d = this.docs.get(id);
    if (!d) return undefined;
    if (d.expires <= this.now()) {
      this.docs.delete(id);
      return undefined;
    }
    return d.agent === agent ? d : undefined;
  }
}

// ------------------------------------------------------------ helpers

type Kind = "html" | "json" | "xml" | "text";

function mimeOf(contentType: string | undefined): string | undefined {
  const m = contentType?.split(";")[0]?.trim().toLowerCase();
  return m === "" ? undefined : m;
}

function kindOf(mime: string): Kind | null {
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/json" || mime === "text/json" || mime.endsWith("+json")) return "json";
  if (mime === "text/xml" || mime === "application/xml" || (mime.startsWith("application/") && mime.endsWith("+xml"))) return "xml";
  if (["text/plain", "text/markdown", "text/x-markdown", "text/csv", "text/tab-separated-values"].includes(mime)) return "text";
  return null;
}

const MAX_TOKENS_LIMIT = 100_000;

function validate(a: WebFetchArgs): void {
  const bad = (m: string): never => {
    throw new WebFailure("invalid-arguments", m);
  };
  if (a === null || typeof a !== "object") bad("arguments must be an object");
  const known = new Set(["url", "mode", "section", "cursor", "maxTokens", "crawl"]);
  for (const k of Object.keys(a)) if (!known.has(k)) bad(`unknown argument ${JSON.stringify(k)}`);
  if (typeof a.url !== "string" || a.url.trim() === "" || a.url.length > 4096) bad("url must be a non-empty string of at most 4096 characters");
  if (a.mode !== undefined && !["auto", "markdown", "raw"].includes(a.mode)) bad('mode must be "auto", "markdown" or "raw"');
  if (a.section !== undefined && (typeof a.section !== "string" || a.section === "" || a.section.length > 200)) bad("section must be a section id or title");
  if (a.cursor !== undefined && (typeof a.cursor !== "string" || a.cursor.length > 100)) bad("cursor must be the string returned by a previous call");
  if (a.maxTokens !== undefined && (!Number.isInteger(a.maxTokens) || a.maxTokens < 100 || a.maxTokens > MAX_TOKENS_LIMIT)) bad(`maxTokens must be an integer from 100 to ${MAX_TOKENS_LIMIT}`);
  if (a.crawl !== undefined && typeof a.crawl !== "boolean") bad("crawl must be a boolean");
}

/** Cut at a paragraph boundary when there is one in the second half of the window; never silently drop text. */
function chunk(text: string, offset: number, maxChars: number): { part: string; next?: number } {
  if (text.length - offset <= maxChars) return { part: text.slice(offset) };
  let cut = text.lastIndexOf("\n\n", offset + maxChars);
  if (cut > offset + maxChars / 4) return { part: text.slice(offset, cut), next: cut + 2 };
  cut = offset + maxChars;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--; // do not split a surrogate pair
  return { part: text.slice(offset, cut), next: cut };
}

function retryAfterSeconds(h: string | string[] | undefined, now: number): number | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return undefined;
  if (/^\d{1,9}$/.test(v.trim())) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - now) / 1000));
}

function statusFailure(r: HttpResponse, now: number): WebFailure | null {
  const s = r.status;
  if (s >= 200 && s < 300) return null;
  const extra = { status: s, url: r.url };
  if (s === 404) return new WebFailure("not-found", "the page was not found (404)", extra);
  if (s === 410) return new WebFailure("gone", "the page is gone (410)", extra);
  if (s === 401 || s === 403 || s === 407) return new WebFailure("auth-required", `the page needs authentication (${s})`, extra);
  if (s === 402) return new WebFailure("paywall", "the page is behind a paywall (402)", extra);
  if (s === 429) return new WebFailure("rate-limited", "the site is rate limiting requests (429)", { ...extra, retryAfterSeconds: retryAfterSeconds(r.headers["retry-after"], now) });
  if (s === 408 || s === 504) return new WebFailure("timeout", `the site timed out (${s})`, extra);
  return new WebFailure("http-error", `the server answered ${s}`, extra);
}

// ------------------------------------------------------------ the tool

export function createWebFetch(cfg: WebFetchConfig = {}): WebFetch {
  const now = cfg.now ?? Date.now;
  const policy = makeAddressPolicy(cfg.allowPrivate ?? []);
  const resolver = cfg.resolver ?? systemResolver;
  const userAgent = cfg.userAgent ?? `PLUR1BUS/${cfg.version ?? "0.1.0"} (+https://plur1bus.app/bot)`;
  const store = cfg.store ?? new DocStore({ now });
  const pacer = cfg.pacer ?? new HostPacer({ now });
  const defaultMaxTokens = cfg.defaultMaxTokens ?? 6000;
  const maxExtractedTokens = cfg.maxExtractedTokens ?? 200_000;
  const robotsCache = new Map<string, { robots: Robots; at: number }>();

  const base = (signal?: AbortSignal) => ({ resolver, policy, userAgent, signal, tlsCa: cfg.tlsCa, maxRedirects: cfg.maxRedirects });

  async function robotsFor(url: URL, signal?: AbortSignal): Promise<Robots> {
    const hit = robotsCache.get(url.origin);
    if (hit && now() - hit.at < 24 * 3600_000) return hit.robots;
    let robots: Robots;
    try {
      const r = await guardedRequest(`${url.origin}/robots.txt`, {
        ...base(signal),
        maxBytes: 512 * 1024,
        timeoutMs: Math.min(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5000),
        accept: "text/plain,*/*;q=0.1",
        acceptType: (ct) => ct === undefined || ct.toLowerCase().startsWith("text/"),
      });
      if (r.status >= 200 && r.status < 300) robots = parseRobots(decodeBody(r.body, r.headers["content-type"]));
      else if (r.status >= 400 && r.status < 500) robots = parseRobots("");
      else throw new WebFailure("robots-disallowed", `robots.txt is unavailable (${r.status}); treated as disallow`);
    } catch (err) {
      if (err instanceof WebFailure && (err.code === "private-address" || err.code === "robots-disallowed")) throw err;
      throw new WebFailure("robots-disallowed", "robots.txt could not be fetched; treated as disallow");
    }
    robotsCache.set(url.origin, { robots, at: now() });
    return robots;
  }

  function present(meta: WebFetchMeta, text: string, offset: number, maxTokens: number, agent: string, requestedUrl: string, fromCache: boolean, docId?: string): WebFetchResult {
    const { part, next } = chunk(text, offset, maxTokens * 4);
    const cursor = next === undefined ? undefined : `${docId ?? store.put(agent, { text, meta, requestedUrl })}.${next}`;
    return { ...meta, markdown: part, ...(cursor ? { cursor } : {}), renderUsed: false, fromCache };
  }

  async function run(args: WebFetchArgs, ctx: WebFetchContext, probe: { bytes?: number; finalUrl?: string; status?: number; fromCache?: boolean }): Promise<WebFetchResult> {
    validate(args);
    const agent = ctx.agentId ?? "default";
    const maxTokens = args.maxTokens ?? defaultMaxTokens;

    if (args.cursor !== undefined) {
      const m = /^([0-9a-f]{12})\.(\d{1,9})$/.exec(args.cursor);
      const entry = m ? store.get(agent, m[1]!) : undefined;
      const offset = m ? Number(m[2]) : -1;
      if (!entry || entry.requestedUrl !== args.url || offset < 0 || offset > entry.text.length) throw new WebFailure("cursor-expired", "the cursor is unknown or has expired");
      probe.fromCache = true;
      probe.finalUrl = entry.meta.finalUrl;
      return present(entry.meta, entry.text, offset, maxTokens, agent, args.url, true, m![1]);
    }

    let target: URL | undefined;
    try {
      target = new URL(args.url);
    } catch {
      /* guardedRequest reports invalid-url */
    }
    if (args.crawl && target && (target.protocol === "http:" || target.protocol === "https:")) {
      const robots = await robotsFor(target, ctx.signal);
      if (!robotsAllows(robots, userAgent, `${target.pathname}${target.search}`)) throw new WebFailure("robots-disallowed", `robots.txt disallows ${target.pathname}`, { url: args.url });
      await pacer.wait(target.host, (robots.crawlDelaySeconds(userAgent) ?? 0) * 1000);
    }

    const r = await guardedRequest(args.url, {
      ...base(ctx.signal),
      maxBytes: cfg.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      acceptType: (ct) => {
        const mime = mimeOf(ct);
        return mime === undefined || kindOf(mime) !== null;
      },
    });
    probe.finalUrl = r.url;
    probe.status = r.status;
    probe.bytes = r.body.length;
    const failure = statusFailure(r, now());
    if (failure) throw failure;

    let mime = mimeOf(r.headers["content-type"]);
    let kind: Kind;
    if (mime === undefined) {
      if (r.body.subarray(0, 512).includes(0)) throw new WebFailure("unsupported-type", "the response has no content type and looks binary", { url: r.url });
      kind = /^\s*(<!doctype html|<html)/i.test(r.body.subarray(0, 256).toString("latin1")) ? "html" : "text";
      mime = kind === "html" ? "text/html" : "text/plain";
    } else kind = kindOf(mime)!;

    const text = decodeBody(r.body, r.headers["content-type"]);
    const fetchedAt = new Date(now()).toISOString();
    const meta: Partial<WebFetchMeta> = {};
    let markdown: string;
    const mode = args.mode ?? "auto";
    if (mode === "raw") markdown = text;
    else if (kind === "html") {
      const ex = htmlToMarkdown(text, r.url);
      if (ex.markdown.trim() === "" || ex.looksClientRendered) throw new WebFailure("needs-render", "the page has no readable text without running its scripts", { url: r.url });
      markdown = ex.markdown;
      Object.assign(meta, { title: ex.title, lang: ex.lang, publishedAt: ex.publishedAt, canonicalUrl: ex.canonicalUrl });
    } else if (kind === "json") {
      try {
        markdown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        markdown = text;
      }
    } else markdown = text;

    if (estimateTokens(markdown) > maxExtractedTokens) throw new WebFailure("too-large", `the extracted text exceeds ${maxExtractedTokens} tokens`, { url: r.url });
    const sections: Section[] = splitSections(markdown);
    let selected = markdown;
    if (args.section !== undefined) {
      const want = args.section.toLowerCase();
      const hit = sections.find((s) => s.id === args.section) ?? sections.find((s) => s.title.toLowerCase() === want);
      if (!hit) throw new WebFailure("invalid-arguments", `no section ${JSON.stringify(args.section)}; available: ${sections.map((s) => `${s.id} (${s.title.slice(0, 40)})`).join(", ").slice(0, 600)}`);
      selected = hit.text;
    }
    const full: WebFetchMeta = {
      finalUrl: r.url,
      status: r.status,
      contentType: mime,
      ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
      sections: sections.map((s) => ({ id: s.id, title: s.title, tokens: s.tokens })),
      fetchedAt,
      provenance: { source: "web", url: r.url, fetchedAt, trust: "untrusted" },
    };
    return present(full, selected, 0, maxTokens, agent, args.url, false);
  }

  return {
    async fetch(args, ctx = {}) {
      const t0 = now();
      const probe: { bytes?: number; finalUrl?: string; status?: number; fromCache?: boolean } = {};
      let error: WebFailureCode | undefined;
      try {
        return await run(args, ctx, probe);
      } catch (err) {
        error = err instanceof WebFailure ? err.code : "network-error";
        throw err;
      } finally {
        // URL, status, sizes and timing only: response bodies never reach logs or traces (D94).
        cfg.trace?.({ tool: "web.fetch", url: String(args?.url ?? ""), ...probe, ms: now() - t0, ...(error ? { error } : {}) });
      }
    },
  };
}
