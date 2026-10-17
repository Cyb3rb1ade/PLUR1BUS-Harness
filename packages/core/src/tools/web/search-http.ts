// The HTTP client of the keyed search providers. It is the egress-checked counterpart of `guardedRequest` for an API call:
// a method and request headers (the key goes in one), an optional JSON body, no redirects, an identity-encoded answer
// under a byte cap and one deadline.
//
// Every call passes the same two checks as any other outgoing request: the egress gate (https only, `egress.allowPorts`,
// the host must be listed in `egress.allowHosts`) before the name is resolved, and the SSRF range check plus the pin of
// the connect to the vetted address after it. The policy is read per call, so `egress.*` changes apply without a restart.
//
// Nothing here logs or formats a header: the key lives in `req.headers` for the length of the call and is never part of
// an error. Failure texts come from the typed failures of the gate and the guard, which name hosts and ports only.
import http from "node:http";
import https from "node:https";
import { compileEgressPolicy, type EgressConfig } from "../../egress/policy.ts";
import { createGate, effectivePort, isLoopbackHost, type Decision } from "../../egress/gate.ts";
import { WebFailure } from "./failure.ts";
import { makeAddressPolicy, resolveGuarded, systemResolver, type Resolver } from "./guard.ts";
import { makePinnedLookup } from "./http.ts";
import { parseAddress } from "./ip.ts";
import type { ApiClient, ApiReply } from "./search-providers.ts";

export interface SearchApiClientOptions {
  /** The live egress configuration (`egress.*`). */
  egress: () => EgressConfig;
  resolver?: Resolver | undefined;
  /** Cap on the answer body. Default 2 MiB. */
  maxBytes?: number | undefined;
  /** One deadline for the whole call. Default 10 s. */
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
  /** Every gate decision, for the egress counters. */
  onDecision?: ((d: Decision) => void) | undefined;
  /** Extra trusted CA (PEM): tests with a local TLS stub only. */
  tlsCa?: string | undefined;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const LOOPBACK = makeAddressPolicy(["127.0.0.0/8", "::1/128"]).allow;

export function createSearchApiClient(o: SearchApiClientOptions): ApiClient {
  const resolver = o.resolver ?? systemResolver;
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = o.timeoutMs ?? 10_000;
  return async (req, { signal }) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new WebFailure("invalid-url", "the provider endpoint is not a valid URL");
    }
    if (url.username !== "" || url.password !== "") throw new WebFailure("invalid-url", "the provider endpoint must not contain credentials");
    const policy = compileEgressPolicy(o.egress());
    const gate = createGate(policy, o.onDecision ? { onDecision: o.onDecision } : {});
    // Loopback is reachable only through a loopback-spelled host and egress.allowLoopback, as for every other request.
    const addresses = { allow: [], forHost: (h: string) => (policy.allowLoopback && isLoopbackHost(h) ? LOOPBACK : []) };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onOuter = (): void => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener("abort", onOuter, { once: true });
    try {
      gate.beforeResolve(url);
      const pin = await race(resolveGuarded(url.hostname, resolver, addresses), ac.signal);
      gate.afterResolve(url, pin);
      return await send(url, req, pin, { maxBytes, userAgent: o.userAgent ?? "PLUR1BUS/web.search", tlsCa: o.tlsCa }, ac.signal);
    } catch (err) {
      if (ac.signal.aborted && !(err instanceof WebFailure && err.code === "timeout")) throw new WebFailure("timeout", "the request exceeded its time limit");
      if (err instanceof WebFailure) throw err;
      throw new WebFailure("network-error", "the request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  };
}

function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WebFailure("timeout", "the request exceeded its time limit"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WebFailure("timeout", "the request exceeded its time limit"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const TLS_CODES = /^(CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH|ERR_OSSL)/;

function send(url: URL, req: Parameters<ApiClient>[0], pin: { address: string; family: 4 | 6 }, o: { maxBytes: number; userAgent: string; tlsCa: string | undefined }, signal: AbortSignal): Promise<ApiReply> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const body = req.body === undefined ? undefined : Buffer.from(req.body, "utf8");
    const r = (secure ? https : http).request(
      {
        host: hostname,
        port: effectivePort(url),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        agent: false,
        lookup: makePinnedLookup(pin) as never,
        servername: secure && !parseAddress(hostname) ? hostname : undefined,
        ca: secure ? o.tlsCa : undefined,
        headers: { ...req.headers, "user-agent": o.userAgent, "accept-encoding": "identity", connection: "close", ...(body ? { "content-length": String(body.length) } : {}) },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = res.headers as ApiReply["headers"];
        if (status >= 300 && status < 400) {
          res.destroy();
          return reject(new WebFailure("http-error", "the provider answered with a redirect, which is not followed", { status }));
        }
        if (status < 200 || status >= 300) {
          res.destroy(); // an error body is never read: it can echo the key or the query
          return resolve({ status, headers, body: Buffer.alloc(0) });
        }
        const enc = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
        if (enc !== "identity") {
          res.destroy();
          return reject(new WebFailure("http-error", "the provider sent a compressed answer that was not asked for"));
        }
        if (!/json/i.test(String(res.headers["content-type"] ?? ""))) {
          res.destroy();
          return reject(new WebFailure("http-error", "the provider answered with something other than JSON", { status }));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          res.destroy();
          return reject(new WebFailure("too-large", `the answer exceeds ${o.maxBytes} bytes`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > o.maxBytes) {
            res.destroy();
            reject(new WebFailure("too-large", `the answer exceeds ${o.maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
        res.on("error", () => reject(new WebFailure("network-error", "the connection broke while reading the answer")));
      },
    );
    const onAbort = (): void => {
      r.destroy();
      reject(new WebFailure("timeout", "the request exceeded its time limit"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    r.on("close", () => signal.removeEventListener("abort", onAbort));
    r.on("error", (err) => {
      const code = (err as { code?: string }).code ?? "";
      reject(TLS_CODES.test(code) ? new WebFailure("tls-error", `TLS verification failed (${code})`) : new WebFailure("network-error", `the connection failed (${code || "unknown"})`));
    });
    if (body) r.write(body);
    r.end();
  });
}
