import { probeEndpoint } from "./probe.ts";
import type { LocalCandidate, ProbeOptions, ProbeResult } from "./types.ts";

export const DEFAULT_CANDIDATES: readonly LocalCandidate[] = Object.freeze([
  // Ollama also serves /v1/models, so a failing /api/tags still finds it.
  { origin: "http://127.0.0.1:11434", dialects: ["ollama", "openai"], label: "ollama" },
  { origin: "http://127.0.0.1:1234", dialects: ["openai"], label: "lmstudio" },
]);

export interface DiscoveredEndpoint extends ProbeResult {
  label: string;
  origin: string;
}

export interface DiscoverOptions extends ProbeOptions {
  /** Replaces the defaults. Non-loopback entries need `allowNonLoopback` and `egress`. */
  candidates?: readonly LocalCandidate[];
  /**
   * Overall wall-clock bound for the whole discovery (default 3000 ms). Candidates still unfinished when it passes
   * come back as `timeout`; their requests are cancelled. `timeoutMs` stays the per-request bound.
   */
  deadlineMs?: number;
}

export const DEFAULT_DISCOVER_DEADLINE_MS = 3000;

function baseUrlOf(origin: string): string {
  try { return new URL("/v1", origin).href; } catch { return origin; }
}

/**
 * Probes every candidate (in parallel, results in candidate order). One dead service never hides another.
 * RULING: only a caller abort rejects; a hung or dead service is a `timeout`/`unreachable` result, and the total wall
 * time never exceeds `deadlineMs` (even when an egress policy or a socket hangs), so callers can poll without blocking.
 */
export async function discoverLocalEndpoints(o: DiscoverOptions = {}): Promise<DiscoveredEndpoint[]> {
  const candidates = o.candidates ?? DEFAULT_CANDIDATES;
  const { candidates: _c, deadlineMs, ...probe } = o;
  const deadline = deadlineMs ?? DEFAULT_DISCOVER_DEADLINE_MS;
  const inner = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, inner.signal]) : inner.signal;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((ok) => { timer = setTimeout(() => ok("expired"), deadline); });
  try {
    const out = Promise.all(candidates.map(async (c): Promise<DiscoveredEndpoint> => {
      const label = c.label ?? c.origin;
      const p = probeEndpoint(c, { ...probe, signal }).then((r) => ({ ...r, label, origin: c.origin }));
      p.catch(() => {}); // a probe cancelled by the deadline rejects after the race is settled
      const r = await Promise.race([p, expired]);
      if (r !== "expired") return r;
      return { state: "timeout", baseUrl: baseUrlOf(c.origin), models: [], detail: `no answer within the ${deadline} ms discovery deadline`, label, origin: c.origin };
    }));
    return await out;
  } catch (e) {
    if (o.signal?.aborted) throw o.signal.reason ?? e;
    throw e;
  } finally {
    clearTimeout(timer);
    inner.abort();
  }
}

/** The endpoints a chat can use right now: reachable and with at least one model. */
export function usable(found: readonly DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  return found.filter((f) => f.state === "ok");
}
