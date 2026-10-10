// The origin-pinned HTTP client for model scans (spec §2.4, R10, R11; plan Task 3, P8).
// node:http / node:https, not fetch: control over the connect timeout, redirects and the decompression cap.
// Core composition supplies its egress gate: each hop is allowlisted and pinned to its vetted IP.
// A credential goes in a header only, never into a URL, an Error message or a log field.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import type net from "node:net";
import { gunzip, inflate, brotliDecompress } from "node:zlib";
import type { CredentialLease } from "./ports.ts";
import type { ScanResultCode } from "./types.ts";

export const LIMITS = {
  connectTimeoutMs: 5000, requestTimeoutMs: 15000, scanTimeoutMs: 60000, maxPages: 10,
  maxBodyBytes: 4194304, maxTotalBytes: 8388608, maxEntries: 5000, maxRedirects: 3, maxStringBytes: 512,
} as const;
type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export class ScanError extends Error {
  readonly result: Exclude<ScanResultCode, "ok" | "failed:empty">;
  readonly reason: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  constructor(result: ScanError["result"], reason: string, extra: { httpStatus?: number; retryAfterMs?: number } = {}) {
    super(`${result}: ${reason}`); // reason is a fixed token, never a header value, URL or body
    this.name = "ScanError";
    this.result = result; this.reason = reason;
    if (extra.httpStatus !== undefined) this.httpStatus = extra.httpStatus;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface PinnedClient {
  get(req: { path: string; query?: Record<string, string> }, headers?: Record<string, string>): Promise<unknown>;
  readonly pages: number;
}
export interface PinnedClientOptions {
  baseUrl: string; lease: CredentialLease | null; userAgent: string; signal?: AbortSignal;
  limits?: Partial<Limits>; lookup?: net.LookupFunction;
  egress?: import("../egress/service.ts").Egress;
  /** In-process test transport; the real egress decision still runs before each hop. */
  request?: typeof http.request;
}

const MAX_RETRY_AFTER_MS = 86_400_000;
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.min(Math.max(0, t - nowMs), MAX_RETRY_AFTER_MS);
}

function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || isLoopbackIp(h);
}

export function parseBaseUrl(rawUrl: string): URL {
  let base: URL;
  try { base = new URL(rawUrl); } catch { throw new ScanError("failed:invalid", "invalid_base_url"); }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    throw new ScanError("failed:invalid", "invalid_base_url");
  }
  return base;
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

export function createPinnedClient(o: PinnedClientOptions): PinnedClient {
  const limits: Limits = { ...LIMITS, ...o.limits };
  const base = parseBaseUrl(o.baseUrl);
  if (o.lease !== null) {
    if (o.lease.origin !== base.origin) throw new ScanError("failed:invalid", "credential_origin_mismatch");
    if (base.protocol === "http:" && !isLoopback(base.hostname)) throw new ScanError("failed:invalid", "insecure_transport");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const scanSignal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(limits.scanTimeoutMs)]);
  let pages = 0;
  let totalBytes = 0;

  async function once(url: URL, extra: Record<string, string> | undefined): Promise<Reply> {
    let pinnedLookup = o.lookup;
    if (o.egress) {
      const decision = await o.egress.decide(url.toString());
      if (!decision.allowed) throw new ScanError("failed:invalid", "egress_" + decision.reason);
      pinnedLookup = ((_hostname: string, options: any, cb: any) => {
        if (options?.all) cb(null, [{ address: decision.address, family: decision.family }]);
        else cb(null, decision.address, decision.family);
      }) as net.LookupFunction;
    }
    if (o.egress && scanSignal.aborted) throw new ScanError("failed:network", o.signal?.aborted ? "aborted" : "scan_timeout");
    return new Promise<Reply>((resolve, reject) => {
      let done = false;
      let connectTimer: NodeJS.Timeout | undefined; let requestTimer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (requestTimer) clearTimeout(requestTimer);
        scanSignal.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (e: ScanError) => finish(() => { req.destroy(); reject(e); });
      const onAbort = () => fail(new ScanError("failed:network", o.signal?.aborted ? "aborted" : "scan_timeout"));
      const headers: Record<string, string> = { Accept: "application/json", "Accept-Encoding": "gzip, deflate, br", "User-Agent": o.userAgent, ...extra };
      if (o.lease) headers[o.lease.headerName] = o.lease.headerValue;
      const isHttps = url.protocol === "https:";

      let lookupFn = pinnedLookup;
      if (o.lease !== null && url.protocol === "http:" && url.hostname.toLowerCase() === "localhost") {
        const baseLookup = lookupFn ?? dns.lookup;
        lookupFn = ((hostname: string, options: any, callback: any) => {
          const cb = typeof options === "function" ? options : callback;
          const opts = typeof options === "function" ? {} : options;
          baseLookup(hostname, { ...opts, all: true } as any, (err: any, addresses: any) => {
            if (err) return cb(err);
            const addrs: Array<{ address: string; family: number }> = Array.isArray(addresses)
              ? addresses
              : [{ address: addresses, family: 4 }];
            for (const entry of addrs) {
              const addr = typeof entry === "string" ? entry : entry.address;
              if (!isLoopbackIp(addr)) {
                return cb(new ScanError("failed:invalid", "insecure_transport"));
              }
            }
            if (opts.all) {
              cb(null, addrs);
            } else {
              cb(null, addrs[0]!.address, addrs[0]!.family);
            }
          });
        }) as typeof o.lookup;
      }

      const req = (o.request ?? (isHttps ? https : http).request)(url, { method: "GET", agent: false, headers, ...(lookupFn ? { lookup: lookupFn } : {}) }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300) { // errors and redirects never have their body read
          res.destroy();
          return finish(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }));
        }
        const type = String(res.headers["content-type"] ?? "");
        if (!/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(type)) return fail(new ScanError("failed:invalid", "content_type"));
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > limits.maxBodyBytes) return fail(new ScanError("failed:invalid", "response_too_large"));
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > limits.maxBodyBytes) return fail(new ScanError("failed:invalid", "response_too_large"));
          chunks.push(c);
        });
        res.on("error", (e) => fail(mapNetError(e)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "identity").toLowerCase().trim();
          if (enc === "identity" || enc === "") return finish(() => resolve({ status, headers: res.headers, body: raw }));
          const onDecompress = (err: Error | null, out: Buffer, badToken: string) => {
            if (err) {
              const code = (err as NodeJS.ErrnoException).code;
              return fail(new ScanError("failed:invalid", code === "ERR_BUFFER_TOO_LARGE" ? "response_too_large" : badToken));
            }
            if (out.length > limits.maxBodyBytes) return fail(new ScanError("failed:invalid", "response_too_large"));
            finish(() => resolve({ status, headers: res.headers, body: out }));
          };
          if (enc === "gzip") {
            return gunzip(raw, { maxOutputLength: limits.maxBodyBytes }, (err, out) => onDecompress(err, out, "bad_gzip"));
          }
          if (enc === "deflate") {
            return inflate(raw, { maxOutputLength: limits.maxBodyBytes }, (err, out) => onDecompress(err, out, "bad_deflate"));
          }
          if (enc === "br") {
            return brotliDecompress(raw, { maxOutputLength: limits.maxBodyBytes }, (err, out) => onDecompress(err, out, "bad_brotli"));
          }
          return fail(new ScanError("failed:invalid", "content_encoding"));
        });
      });
      req.on("error", (e) => fail(mapNetError(e)));
      req.on("socket", (s) => {
        if (done) return;
        connectTimer = setTimeout(() => fail(new ScanError("failed:network", "connect_timeout")), limits.connectTimeoutMs);
        if (connectTimer.unref) connectTimer.unref();
        s.once(isHttps ? "secureConnect" : "connect", () => {
          if (connectTimer) clearTimeout(connectTimer);
        });
      });
      requestTimer = setTimeout(() => fail(new ScanError("failed:network", "request_timeout")), limits.requestTimeoutMs);
      if (requestTimer.unref) requestTimer.unref();
      if (scanSignal.aborted) return onAbort();
      scanSignal.addEventListener("abort", onAbort, { once: true });
      req.end();
    });
  }

  async function get(req: { path: string; query?: Record<string, string> }, extra?: Record<string, string>): Promise<unknown> {
    pages += 1;
    if (pages > limits.maxPages) throw new ScanError("failed:invalid", "too_many_pages");
    let url = new URL(base.origin + basePath + (req.path.startsWith("/") ? req.path : `/${req.path}`));
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    for (let hops = 0; ; hops += 1) {
      if (url.origin !== base.origin) throw new ScanError("failed:invalid", "redirect_foreign_origin"); // before any socket
      const r = await once(url, extra);
      if (r.status >= 200 && r.status < 300) {
        totalBytes += r.body.length;
        if (totalBytes > limits.maxTotalBytes) throw new ScanError("failed:invalid", "response_too_large");
        try { return JSON.parse(r.body.toString("utf8")); } catch { throw new ScanError("failed:invalid", "invalid_json"); }
      }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.location;
        if (typeof loc !== "string") throw new ScanError("failed:invalid", `http_${r.status}`, { httpStatus: r.status });
        let next: URL;
        try { next = new URL(loc, url); } catch { throw new ScanError("failed:invalid", "bad_redirect"); }
        if (next.username !== "" || next.password !== "") throw new ScanError("failed:invalid", "bad_redirect");
        if (next.origin !== base.origin) throw new ScanError("failed:invalid", "redirect_foreign_origin");
        if (hops >= limits.maxRedirects) throw new ScanError("failed:invalid", "too_many_redirects");
        url = next;
        continue;
      }
      if (r.status === 401 || r.status === 403) throw new ScanError("failed:auth", "renew_sign_in", { httpStatus: r.status });
      if (r.status === 429) {
        const ra = parseRetryAfter(typeof r.headers["retry-after"] === "string" ? r.headers["retry-after"] : undefined, Date.now());
        throw new ScanError("failed:server", "rate_limited", { httpStatus: 429, ...(ra !== undefined ? { retryAfterMs: ra } : {}) });
      }
      if (r.status >= 500) throw new ScanError("failed:server", `http_${r.status}`, { httpStatus: r.status });
      throw new ScanError("failed:invalid", `http_${r.status}`, { httpStatus: r.status });
    }
  }

  return { get, get pages() { return pages; } };
}

function mapNetError(e: unknown): ScanError {
  if (e instanceof ScanError) return e;
  const code = (e as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code === "ECONNREFUSED") return new ScanError("failed:network", "connection_refused");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new ScanError("failed:network", "dns_failure");
  if (code === "ECONNRESET" || code === "EPIPE") return new ScanError("failed:network", "connection_reset");
  if (code === "ETIMEDOUT") return new ScanError("failed:network", "timeout");
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code)) return new ScanError("failed:network", "tls_error");
  return new ScanError("failed:network", "network_error");
}

