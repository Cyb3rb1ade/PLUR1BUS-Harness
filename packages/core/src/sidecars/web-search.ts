// web.search backed by the SearXNG sidecar. The config decides where the sidecar is: `sidecars.searxng.mode` is
// `bundled` (the container layer injects the private address as PLUR1BUS_SEARXNG_URL once the sidecar has passed its
// health gate), `remote` (`sidecars.searxng.url`, for example a Tailscale address) or `off`.
//
// A harness inside a container has no `sidecars` section of its own (the selection lives in the host's install record),
// so the container layer also injects PLUR1BUS_SEARXNG_MODE and, for a remote sidecar, PLUR1BUS_SEARXNG_URL. The config
// wins where it has an entry; the environment fills in where it has none.
//
// Egress. The general egress policy is https-only and refuses every private address, which is right for the open web
// and wrong for a sidecar that lives on the container network or the tailnet. So this module has its own, narrower
// rule instead of widening the shared one: exactly the configured origin, private/tailnet/loopback addresses only,
// never a link-local or metadata address, never a redirect.
//
// Privacy. A query goes to the configured SearXNG and nowhere else. Traces and status carry lengths, counts, durations
// and failure codes, never query text, result text or result URLs.
import { readFile, stat } from "node:fs/promises";
import { WebFailure, type WebFailureCode } from "../tools/web/failure.ts";
import { makeAddressPolicy, type AddressPolicy, type Resolver } from "../tools/web/guard.ts";
import { guardedRequest } from "../tools/web/http.ts";
import { canonical, parseAddress } from "../tools/web/ip.ts";
import { createWebSearch, type SearchTrace, type WebSearch } from "../tools/web/search.ts";
import { createSearxngProvider } from "../tools/web/searxng.ts";

/** Set by the container layer on the harness container: the sidecar's URL (the private address of a bundled one, or the remote URL). */
export const BUNDLED_SEARXNG_ENV = "PLUR1BUS_SEARXNG_URL";
/** Set by the container layer: `bundled` or `remote`. Absent means the layer wired no SearXNG. */
export const SEARXNG_MODE_ENV = "PLUR1BUS_SEARXNG_MODE";

export type SidecarMode = "bundled" | "remote" | "off";
export type SidecarsConfig = Record<string, { mode?: SidecarMode; url?: string; caBundle?: string; fingerprint?: string; timeoutMs?: number } | undefined>;

export interface SearxngTarget {
  mode: SidecarMode;
  endpoint: URL | null;
  /** Why there is no endpoint, in words for a person. Absent when `mode` is `off` or an endpoint exists. */
  problem?: string;
}

function parseEndpoint(raw: string, what: string): { endpoint: URL } | { problem: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { problem: `${what} is not a valid URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { problem: `${what} must use http or https` };
  if (u.username !== "" || u.password !== "") return { problem: `${what} must not contain credentials` };
  if (u.search !== "" || u.hash !== "") return { problem: `${what} must not contain a query or fragment` };
  return { endpoint: u };
}

export function resolveSearxngTarget(sidecars: SidecarsConfig | undefined, env: NodeJS.ProcessEnv): SearxngTarget {
  const c = sidecars?.searxng;
  const fromEnv = env[SEARXNG_MODE_ENV] === "bundled" || env[SEARXNG_MODE_ENV] === "remote" ? env[SEARXNG_MODE_ENV] : undefined;
  const mode: SidecarMode = c?.mode ?? fromEnv ?? "off";
  if (mode !== "bundled" && mode !== "remote") return { mode: "off", endpoint: null };
  const injected = env[BUNDLED_SEARXNG_ENV];
  if (mode === "remote") {
    const url = c?.url ?? injected;
    if (!url) return { mode, endpoint: null, problem: "sidecars.searxng.url is required in remote mode" };
    const p = parseEndpoint(url, c?.url ? "sidecars.searxng.url" : BUNDLED_SEARXNG_ENV);
    return "endpoint" in p ? { mode, endpoint: p.endpoint } : { mode, endpoint: null, problem: p.problem };
  }
  if (!injected) return { mode, endpoint: null, problem: "the bundled SearXNG sidecar is not running (the container layer published no address)" };
  const p = parseEndpoint(injected, BUNDLED_SEARXNG_ENV);
  return "endpoint" in p ? { mode, endpoint: p.endpoint } : { mode, endpoint: null, problem: p.problem };
}

// Where a sidecar may live: container networks (RFC 1918), the tailnet (100.64/10), unique-local IPv6 and loopback.
// Link-local, the unspecified address and everything public are absent on purpose.
const SIDECAR_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "fc00::/7", "::1/128"];
// Inside 100.64/10, but a cloud metadata address.
const METADATA_HOSTS = new Set(["100.100.100.200"]);
const sidecarPolicy: AddressPolicy = makeAddressPolicy(SIDECAR_RANGES);

function hostOf(url: URL): string {
  return (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname).toLowerCase();
}

function sidecarGate(endpoint: URL) {
  const deny = (message: string): never => {
    throw new WebFailure("private-address", message);
  };
  return {
    beforeResolve(url: URL): void {
      if (url.origin !== endpoint.origin) throw new WebFailure("egress-denied", "the sidecar client only talks to the configured SearXNG origin");
      const literal = parseAddress(hostOf(url));
      if (literal && METADATA_HOSTS.has(hostOf(url))) deny("cloud metadata addresses are never a sidecar");
    },
    afterResolve(url: URL, pin: { address: string }): void {
      const a = parseAddress(pin.address);
      if (!a) return deny("the sidecar address could not be parsed");
      const c = canonical(a);
      // `resolveGuarded` has already refused anything non-public outside `sidecarPolicy`; what remains here is the
      // reverse rule (a sidecar is never on a public address) and the metadata address inside the tailnet range.
      if (c.family === 4 && METADATA_HOSTS.has(Array.from(c.bytes).join("."))) deny("cloud metadata addresses are never a sidecar");
      if (!sidecarPolicy.allow.some((r) => r.family === c.family && inCidrBytes(c.bytes, r.bytes, r.prefix))) deny(`${hostOf(url)} is not on a private or tailnet address`);
    },
  };
}

function inCidrBytes(addr: Uint8Array, net: Uint8Array, prefix: number): boolean {
  for (let i = 0, left = prefix; left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((addr[i]! & mask) !== (net[i]! & mask)) return false;
  }
  return true;
}

export type WebSearchState = "off" | "unknown" | "ok" | "unreachable" | "error" | "not-running" | "misconfigured";

export interface WebSearchStatus {
  provider: "searxng";
  mode: SidecarMode;
  state: WebSearchState;
  /** `http(s)://host:port[/prefix]` of the configured endpoint, or null. No credentials by construction. */
  endpoint: string | null;
  lastCheckedAt?: string;
  /** The failure code of the last attempt, when it failed. */
  lastError?: WebFailureCode;
}

export interface SearxngWebSearchOptions {
  config: () => SidecarsConfig | undefined;
  env: NodeJS.ProcessEnv;
  resolver?: Resolver | undefined;
  now?: (() => number) | undefined;
  trace?: ((e: SearchTrace) => void) | undefined;
  /** One search's limit. Default 10 s. */
  timeoutMs?: number | undefined;
  /** Cap on the sidecar's answer. Default 1 MiB. */
  maxBytes?: number | undefined;
}

export interface SearxngWebSearch {
  search: WebSearch;
  status(): WebSearchStatus;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_CA_BYTES = 1024 * 1024;
const UNREACHABLE = new Set<WebFailureCode>(["network-error", "timeout"]);

const display = (u: URL): string => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;

async function readCa(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    if ((await stat(path)).size > MAX_CA_BYTES) throw new Error("too large");
    return await readFile(path, "utf8");
  } catch {
    throw new WebFailure("tls-error", "the CA bundle in sidecars.searxng.caBundle could not be read");
  }
}

export function createSearxngWebSearch(o: SearxngWebSearchOptions): SearxngWebSearch {
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  let health: { endpoint: string; state: "ok" | "unreachable" | "error"; at: number; error?: WebFailureCode } | undefined;

  const statusNow = (): WebSearchStatus => {
    const target = resolveSearxngTarget(o.config(), o.env);
    if (target.mode === "off") return { provider: "searxng", mode: "off", state: "off", endpoint: null };
    if (!target.endpoint) return { provider: "searxng", mode: target.mode, state: target.mode === "bundled" && !o.env[BUNDLED_SEARXNG_ENV] ? "not-running" : "misconfigured", endpoint: null };
    const endpoint = display(target.endpoint);
    if (health?.endpoint !== endpoint) return { provider: "searxng", mode: target.mode, state: "unknown", endpoint };
    return { provider: "searxng", mode: target.mode, state: health.state, endpoint, lastCheckedAt: new Date(health.at).toISOString(), ...(health.error ? { lastError: health.error } : {}) };
  };

  const search: WebSearch = {
    async search(args, ctx = {}) {
      const target = resolveSearxngTarget(o.config(), o.env);
      const fail = (f: WebFailure): never => {
        o.trace?.({ tool: "web.search", queryChars: typeof args?.query === "string" ? args.query.trim().length : 0, skipped: [], ms: 0, error: f.code });
        throw f;
      };
      if (target.mode === "off") return fail(new WebFailure("no-provider", "web search needs the SearXNG sidecar: set sidecars.searxng.mode to bundled or remote"));
      if (!target.endpoint) return fail(new WebFailure("provider-failed", target.problem ?? "SearXNG is not available"));
      const endpoint = target.endpoint;
      const cfg = o.config()?.searxng;
      // The pin protects the health probe; this client has no pinned-TLS mode, so honouring the config silently would be wrong.
      if (cfg?.fingerprint) return fail(new WebFailure("tls-error", "sidecars.searxng.fingerprint is not supported by web.search; trust the host with sidecars.searxng.caBundle instead"));

      let last: WebFailure | undefined;
      const record = (f: WebFailure | undefined): void => {
        last = f;
        const at = now();
        const key = display(endpoint);
        if (!f) health = { endpoint: key, state: "ok", at };
        else health = { endpoint: key, state: UNREACHABLE.has(f.code) ? "unreachable" : "error", at, error: f.code };
      };
      const requestTimeout = Math.max(50, Math.floor(timeoutMs * 0.9));
      const provider = createSearxngProvider({
        baseUrl: endpoint,
        onOutcome: record,
        async request(url, { signal }) {
          const tlsCa = endpoint.protocol === "https:" ? await readCa(cfg?.caBundle) : undefined;
          let res;
          try {
            res = await guardedRequest(url, {
              ...(o.resolver ? { resolver: o.resolver } : {}),
              policy: sidecarPolicy,
              gate: sidecarGate(endpoint),
              maxRedirects: 0,
              maxBytes,
              timeoutMs: requestTimeout,
              userAgent: "PLUR1BUS/web.search",
              accept: "application/json",
              acceptType: (ct) => /json/i.test(ct ?? ""),
              signal,
              ...(tlsCa ? { tlsCa } : {}),
            });
          } catch (err) {
            if (!(err instanceof WebFailure)) throw err;
            if (err.code === "too-many-redirects") throw new WebFailure("http-error", "SearXNG answered with a redirect, which the sidecar client does not follow");
            if (err.code === "network-error") throw new WebFailure("network-error", `the SearXNG sidecar is unreachable at ${endpoint.host}`);
            throw err;
          }
          return { status: res.status, body: res.body };
        },
      });
      const inner = createWebSearch({ providers: [provider], timeoutMs, ...(o.now ? { now: o.now } : {}), ...(o.trace ? { trace: o.trace } : {}) });
      try {
        return await inner.search(args, ctx);
      } catch (err) {
        // `createWebSearch` reports a lone failed provider as a generic "all providers failed"; the person needs the cause.
        if (err instanceof WebFailure && err.code === "provider-failed" && last) throw last;
        if (err instanceof WebFailure && err.code === "timeout" && !last) record(err);
        throw err;
      }
    },
  };

  return { search, status: statusNow };
}
