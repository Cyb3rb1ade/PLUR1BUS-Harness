// The one HTTP client the web tools use. Every hop — the first request and each redirect — goes through the SSRF
// guard (`resolveGuarded`), connects to the vetted address only (the socket's `lookup` is pinned, so the name is
// never resolved a second time: no DNS rebinding), and runs under one shared deadline and one byte cap that
// counts DECOMPRESSED bytes. No cookies, no credentials, no caller headers are ever forwarded.
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
}

export interface HttpResponse {
  /** The URL of the final response (after redirects). */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Empty for status >= 400 and for 3xx. */
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
function hop(url: URL, pin: ResolvedAddress, o: HttpOptions & { maxBytes: number }, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const req = (secure ? https : http).request(
      {
        host: hostname,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        lookup: makePinnedLookup(pin) as never,
        // SNI and certificate verification use the NAME; an IP literal has no name to verify against.
        servername: secure && !parseAddress(hostname) ? hostname : undefined,
        ca: secure ? o.tlsCa : undefined,
        headers: {
          "user-agent": o.userAgent,
          accept: o.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
          connection: "close",
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
    req.end();
  });
}

export async function guardedRequest(rawUrl: string, options: HttpOptions): Promise<HttpResponse> {
  const resolver = options.resolver ?? systemResolver;
  const policy = options.policy ?? makeAddressPolicy([]);
  const maxRedirects = options.maxRedirects ?? 10;
  const o = { ...options, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES };

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
      if (REDIRECT.has(r.status) && typeof location === "string" && location !== "") {
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
