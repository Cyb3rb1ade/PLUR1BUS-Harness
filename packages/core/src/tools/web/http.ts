// The one HTTP client the web tools use. Every hop — the first request and each redirect — goes through the SSRF
// guard (`resolveGuarded`), connects to the vetted address only (the socket's `lookup` is pinned, so the name is
// never resolved a second time: no DNS rebinding), and runs under one shared deadline and one byte cap that
// counts DECOMPRESSED bytes. The web tools send no cookies, no credentials and no caller headers. A harness-owned
// provider call (egress.request with `method`/`headers`/`body`, e.g. a model API POST) may send its own headers and a
// capped body; those calls never follow a redirect (the 3xx is returned as is), so a body or an Authorization header
// never reaches a host the request was not addressed to.
import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate, type BrotliDecompress, type Gunzip, type Inflate } from "node:zlib";
import type { Readable } from "node:stream";
import { WebFailure } from "./failure.ts";
import { makeAddressPolicy, resolveGuarded, systemResolver, type AddressPolicy, type ResolvedAddress, type Resolver } from "./guard.ts";
import { parseAddress } from "./ip.ts";

export interface HttpOptions {
  resolver?: Resolver | undefined;
  policy?: AddressPolicy | undefined;
  /** Redirect hops followed before `too-many-redirects`. Default 10 (D94). */
  maxRedirects?: number | undefined;
  /** Cap on the decompressed body. Default 20 MB (D94). */
  maxBytes?: number | undefined;
  /** Read up to this many (decompressed) bytes of an error response (status >= 400) so the caller can recognise a CAPTCHA or a login form. Default 0: error bodies are discarded. */
  errorBodyBytes?: number | undefined;
  /** One deadline for the whole call, all hops and the body. Default 30 s. */
  timeoutMs?: number | undefined;
  userAgent: string;
  accept?: string | undefined;
  /** Called with the Content-Type of a 2xx answer before its body is read; false → `unsupported-type`. */
  acceptType?: ((contentType: string | undefined) => boolean) | undefined;
  signal?: AbortSignal | undefined;
  /** Optional per-hop policy (the egress gate, B4): consulted before and after name resolution on every hop; throws to refuse. */
  gate?: { beforeResolve(url: URL): void; afterResolve(url: URL, pin: ResolvedAddress): void } | undefined;
  /** Extra trusted CA (PEM) — for tests with a local TLS stub; production uses the system store. */
  tlsCa?: string | undefined;
  /** HTTP method. Default GET. Any other method (or a body) turns redirect following off: a 3xx is returned unread. */
  method?: HttpMethod | undefined;
  /** Caller headers for a harness-owned provider call (e.g. authorization, content-type). Connection-level headers are refused. */
  headers?: Readonly<Record<string, string>> | undefined;
  /** Request body, sent with a computed content-length (never chunked). Capped by `maxRequestBytes`. */
  body?: string | Uint8Array | undefined;
  /** Cap on the request body. Default 20 MB. */
  maxRequestBytes?: number | undefined;
  /** The caller needs the status and headers only (a webhook delivery): the response body is never read, whatever its size or encoding, and `body` comes back empty. */
  discardBody?: boolean | undefined;
}

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Set by the client itself or connection-level: a caller can neither smuggle a second request nor redirect the socket. */
const RESERVED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive", "expect", "proxy-authorization", "proxy-connection", "accept-encoding", "cookie"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Validated caller headers (lower-cased names) and the body as bytes; throws `invalid-url` (or `too-large`) before any I/O. */
function requestParts(o: HttpOptions): { method: HttpMethod; headers: Record<string, string>; body: Buffer | undefined } {
  const method = (o.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new WebFailure("invalid-url", `method ${JSON.stringify(method.slice(0, 16))} is not allowed`);
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(o.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!TOKEN.test(name)) throw new WebFailure("invalid-url", "a request header name is not a valid token");
    if (RESERVED_HEADERS.has(name) || name.startsWith("proxy-")) throw new WebFailure("invalid-url", `request header ${name} is set by the client and cannot be given`);
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new WebFailure("invalid-url", `request header ${name} has an invalid value`);
    headers[name] = value;
  }
  let body: Buffer | undefined;
  if (o.body !== undefined) {
    if (method === "GET" || method === "HEAD") throw new WebFailure("invalid-url", `a ${method} request has no body`);
    body = typeof o.body === "string" ? Buffer.from(o.body, "utf8") : Buffer.from(o.body);
    const cap = o.maxRequestBytes ?? DEFAULT_MAX_BYTES;
    if (body.length > cap) throw new WebFailure("too-large", `request body is ${body.length} bytes (limit ${cap})`);
  }
  return { method: method as HttpMethod, headers, body };
}

export interface HttpResponse {
  /** The URL of the final response (after redirects). */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Empty for 3xx, and for status >= 400 unless `errorBodyBytes` asked for a (possibly cut-off) copy. */
  body: Buffer;
  /** Every URL requested before `url`, in order. */
  redirects: string[];
}

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const TLS_CODES = /^(CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH|ERR_OSSL)/;

/** The `lookup` for the socket: whatever name it is asked about, it answers with the vetted address. */
export function makePinnedLookup(pin: ResolvedAddress) {
  return (_hostname: string, options: { all?: boolean } | number | undefined, cb: (...args: any[]) => void): void => {
    if (typeof options === "object" && options?.all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFailure("invalid-url", `not a valid URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFailure("egress-denied", `scheme ${url.protocol} is not allowed (http and https only)`);
  if (url.username !== "" || url.password !== "") throw new WebFailure("invalid-url", "URLs with embedded credentials are refused");
  if (url.hostname === "") throw new WebFailure("invalid-url", "URL has no host");
  return url;
}

function decoders(encodingHeader: string | undefined): Array<Gunzip | Inflate | BrotliDecompress> {
  const out: Array<Gunzip | Inflate | BrotliDecompress> = [];
  const list = (encodingHeader ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "" && s !== "identity");
  for (const enc of list.reverse()) {
    if (enc === "gzip" || enc === "x-gzip") out.push(createGunzip());
    else if (enc === "deflate") out.push(createInflate());
    else if (enc === "br") out.push(createBrotliDecompress());
    else throw new WebFailure("unsupported-type", `content-encoding ${JSON.stringify(enc.slice(0, 32))} is not supported`);
  }
  return out;
}

/** Read at most `max` bytes and stop; a longer body is cut, never an error (used for error pages, which are only inspected). */
async function readUpTo(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
    if (total >= max) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new WebFailure("too-large", `response exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function mapError(err: unknown): WebFailure {
  if (err instanceof WebFailure) return err;
  const code = (err as { code?: string })?.code ?? "";
  if (TLS_CODES.test(code)) return new WebFailure("tls-error", `TLS verification failed (${code})`);
  if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || /^ERR_BROTLI/.test(code)) return new WebFailure("network-error", "the response body could not be decompressed");
  return new WebFailure("network-error", `request failed (${code || (err as Error)?.message || "unknown"})`);
}

/** One hop. Resolves with the response, its headers and (for 2xx) the capped, decoded body. */
function hop(url: URL, pin: ResolvedAddress, o: HttpOptions & { maxBytes: number; parts: ReturnType<typeof requestParts> }, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const req = (secure ? https : http).request(
      {
        host: hostname,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: o.parts.method,
        agent: false,
        lookup: makePinnedLookup(pin) as never,
        // SNI and certificate verification use the NAME; an IP literal has no name to verify against.
        servername: secure && !parseAddress(hostname) ? hostname : undefined,
        ca: secure ? o.tlsCa : undefined,
        headers: {
          "user-agent": o.userAgent,
          accept: o.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
          ...o.parts.headers,
          "accept-encoding": "gzip, deflate, br",
          connection: "close",
          ...(o.parts.body ? { "content-length": String(o.parts.body.length) } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = res.headers;
        if (status >= 300 && status < 400) {
          res.destroy();
          return resolve({ status, headers, body: Buffer.alloc(0) });
        }
        if (status < 200 || status >= 400) {
          const peek = status >= 400 ? (o.errorBodyBytes ?? 0) : 0;
          if (peek <= 0) {
            res.destroy();
            return resolve({ status, headers, body: Buffer.alloc(0) });
          }
          void (async () => {
            try {
              let stream: Readable = res;
              for (const d of decoders(headers["content-encoding"])) {
                stream.on("error", (e) => d.destroy(e));
                stream = stream.pipe(d);
              }
              resolve({ status, headers, body: await readUpTo(stream, peek) });
            } catch {
              res.destroy();
              resolve({ status, headers, body: Buffer.alloc(0) }); // an unreadable error page is still an error status
            }
          })();
          return;
        }
        if (o.discardBody) {
          res.destroy();
          return resolve({ status, headers, body: Buffer.alloc(0) });
        }
        void (async () => {
          try {
            if (o.acceptType && !o.acceptType(headers["content-type"])) throw new WebFailure("unsupported-type", `content type ${JSON.stringify(String(headers["content-type"] ?? "unknown").slice(0, 80))} is not readable`);
            const stages = decoders(headers["content-encoding"]);
            const declared = Number(headers["content-length"]);
            if (stages.length === 0 && Number.isFinite(declared) && declared > o.maxBytes) throw new WebFailure("too-large", `response is ${declared} bytes (limit ${o.maxBytes})`);
            let stream: Readable = res;
            for (const d of stages) {
              stream.on("error", (e) => d.destroy(e));
              stream = stream.pipe(d);
            }
            resolve({ status, headers, body: await readCapped(stream, o.maxBytes) });
          } catch (err) {
            res.destroy();
            reject(err);
          }
        })();
      },
    );
    const onAbort = (): void => {
      req.destroy();
      reject(new WebFailure("timeout", "the request exceeded its time limit"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", reject);
    req.on("close", () => signal.removeEventListener("abort", onAbort));
    req.end(o.parts.body);
  });
}

export async function guardedRequest(rawUrl: string, options: HttpOptions): Promise<HttpResponse> {
  const resolver = options.resolver ?? systemResolver;
  const policy = options.policy ?? makeAddressPolicy([]);
  const parts = requestParts(options);
  // Only a plain GET/HEAD without caller headers follows redirects: a provider call's body and headers stay with its host.
  const follows = (parts.method === "GET" || parts.method === "HEAD") && parts.body === undefined && Object.keys(parts.headers).length === 0;
  const maxRedirects = follows ? (options.maxRedirects ?? 10) : 0;
  const o = { ...options, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES, parts };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onCallerAbort = (): void => ac.abort();
  if (options.signal?.aborted) ac.abort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const redirects: string[] = [];
    let url = parseTarget(rawUrl);
    for (;;) {
      if (ac.signal.aborted) throw new WebFailure("timeout", "the request exceeded its time limit");
      options.gate?.beforeResolve(url);
      const pin = await raceAbort(resolveGuarded(url.hostname, resolver, policy), ac.signal);
      options.gate?.afterResolve(url, pin);
      const r = await hop(url, pin, o, ac.signal);
      const location = r.headers.location;
      if (follows && REDIRECT.has(r.status) && typeof location === "string" && location !== "") {
        if (redirects.length >= maxRedirects) throw new WebFailure("too-many-redirects", `more than ${maxRedirects} redirects`);
        redirects.push(url.href);
        try {
          url = new URL(location, url);
        } catch {
          throw new WebFailure("invalid-url", "redirect to an invalid URL");
        }
        url = parseTarget(url.href); // scheme / credentials re-checked; the host is re-resolved at the top of the loop
        continue;
      }
      return { url: url.href, status: r.status, headers: r.headers, body: r.body, redirects };
    }
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof WebFailure && err.code === "timeout")) throw new WebFailure("timeout", "the request exceeded its time limit");
    throw mapError(err);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WebFailure("timeout", "the request exceeded its time limit"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WebFailure("timeout", "the request exceeded its time limit"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
