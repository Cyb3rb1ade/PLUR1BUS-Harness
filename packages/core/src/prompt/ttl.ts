import { lookupCacheProfile, type CacheTtl } from "./model-table.ts";

/** ADR-010 R7/Q1: with the 1-hour TTL a write costs 2.0x instead of 1.25x, so it pays once the window is read this often. */
const MIN_PROJECTED_READS_FOR_LONG_TTL = 3;

/**
 * RULING (ADR-010 Q1, the ADR's proposed default): the 1-hour TTL is enabled automatically when the scheduler projects at
 * least 3 reads inside it, for models that offer it; otherwise the shortest TTL the model supports (`5m`, or GPT-5.6+'s
 * only `30m`). `policy: "never"` pins the short TTL. A manual 1-hour request is simply `cacheTtl: "1h"` on the render
 * input. An unknown model gets `5m` (no markers are emitted for it anyway).
 */
export function chooseCacheTtl(o: { model: string; projectedReads: number; policy?: "auto" | "never" }): CacheTtl {
  const p = lookupCacheProfile(o.model);
  const short: CacheTtl = p.ttls.includes("5m") ? "5m" : (p.ttls[0] ?? "5m");
  if ((o.policy ?? "auto") === "never" || !p.ttls.includes("1h")) return short;
  return Number.isFinite(o.projectedReads) && o.projectedReads >= MIN_PROJECTED_READS_FOR_LONG_TTL ? "1h" : short;
}
