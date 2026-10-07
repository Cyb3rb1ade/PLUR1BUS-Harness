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
}

/** Probes every candidate (in parallel, results in candidate order). One dead service never hides another. */
export async function discoverLocalEndpoints(o: DiscoverOptions = {}): Promise<DiscoveredEndpoint[]> {
  const candidates = o.candidates ?? DEFAULT_CANDIDATES;
  const { candidates: _c, ...probe } = o;
  return Promise.all(candidates.map(async (c) => ({
    ...(await probeEndpoint(c, probe)),
    label: c.label ?? c.origin,
    origin: c.origin,
  })));
}

/** The endpoints a chat can use right now: reachable and with at least one model. */
export function usable(found: readonly DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  return found.filter((f) => f.state === "ok");
}
