import { isLoopbackUrl } from "./loopback.ts";
import type { LocalCandidate, LocalDialect, LocalModel, ProbeOptions, ProbeResult } from "./types.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODELS = 1000;

const PATHS: Record<LocalDialect, string> = { ollama: "/api/tags", openai: "/v1/models" };

class Bad extends Error {}

function parseOrigin(origin: string): URL | undefined {
  try {
    const u = new URL(origin);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) return undefined;
    if (u.pathname !== "/") return undefined;
    return u;
  } catch { return undefined; }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Bad("response body too large"); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function parseModelList(dialect: LocalDialect, text: string): LocalModel[] {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Bad("response is not JSON"); }
  const list = dialect === "ollama" ? (json as { models?: unknown } | null)?.models : (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Bad(`response has no ${dialect === "ollama" ? "models" : "data"} array`);
  const key = dialect === "ollama" ? "name" : "id";
  const ids = new Set<string>();
  for (const item of list.slice(0, MAX_MODELS)) {
    const id = (item as Record<string, unknown> | null)?.[key];
    if (typeof id === "string" && id !== "" && id.length <= 256) ids.add(id);
  }
  // A non-empty list in which no entry has a usable id is not a model list.
  if (list.length > 0 && ids.size === 0) throw new Bad("model entries carry no ids");
  return [...ids].map((id) => ({ id }));
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || (e.name === "AbortError" && e.cause instanceof Error && e.cause.name === "TimeoutError"));
}

/** One keyless request for one dialect. Never sends credentials; never follows a redirect. */
async function tryDialect(origin: URL, dialect: LocalDialect, o: ProbeOptions, baseUrl: string): Promise<ProbeResult> {
  const doFetch = o.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const fail = (state: ProbeResult["state"], detail: string, httpStatus?: number): ProbeResult =>
    ({ state, baseUrl, models: [], detail, ...(httpStatus === undefined ? {} : { httpStatus }) });
  try {
    const res = await doFetch(new URL(PATHS[dialect], origin), { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal });
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => {}); return fail("protocol", "redirect not followed", res.status); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return fail("protocol", `HTTP ${res.status}`, res.status); }
    const models = parseModelList(dialect, await readCapped(res));
    return { state: models.length === 0 ? "empty" : "ok", baseUrl, dialect, models, httpStatus: res.status };
  } catch (e) {
    if (isTimeout(e) || timeout.aborted) return fail("timeout", `no answer within ${o.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS} ms`);
    if (o.signal?.aborted) throw o.signal.reason ?? e;
    if (e instanceof Bad) return fail("protocol", e.message);
    return fail("unreachable", "connection failed");
  }
}

/**
 * Probe one candidate: try its dialects in order and return the first that answers as a model server. When none does,
 * the result of the most informative attempt is returned (a protocol answer beats a timeout beats unreachable).
 */
export async function probeEndpoint(candidate: LocalCandidate, o: ProbeOptions = {}): Promise<ProbeResult> {
  const origin = parseOrigin(candidate.origin);
  const refused = (detail: string): ProbeResult => ({ state: "refused", baseUrl: candidate.origin, models: [], detail });
  if (!origin) return refused("not a plain http(s) origin");
  const baseUrl = new URL("/v1", origin).href;
  if (!isLoopbackUrl(origin.href)) {
    // RULING: non-loopback needs both the explicit opt-in and an egress policy that allows it; no policy → refused.
    if (!o.allowNonLoopback) return refused("not a loopback address");
    if (!o.egress) return refused("non-loopback endpoint needs an egress policy");
    if (!(await o.egress.allow(origin.href))) return refused("blocked by egress policy");
  }
  const rank = { protocol: 3, timeout: 2, unreachable: 1 } as const;
  let worst: ProbeResult | undefined;
  for (const dialect of candidate.dialects) {
    const r = await tryDialect(origin, dialect, o, baseUrl);
    if (r.state === "ok" || r.state === "empty") {
      // An empty list from the first dialect does not rule out a populated one from the second.
      if (r.state === "ok") return r;
      worst ??= r;
      continue;
    }
    if (!worst || (worst.state !== "empty" && rank[r.state as keyof typeof rank] > rank[worst.state as keyof typeof rank])) worst = r;
    // Unreachable and timeout are properties of the host, not of the dialect: do not retry the same dead door.
    if (r.state === "unreachable" || r.state === "timeout") break;
  }
  return worst ?? refused("no dialect to try");
}
