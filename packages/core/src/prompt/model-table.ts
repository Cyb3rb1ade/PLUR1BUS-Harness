// The per-model prompt-cache view the builder needs (ADR-010 R1/R2). The rows themselves are data in
// `packages/providers/schema/cache-profiles.json` (RE-D21, plan §2.6), one row per model family and platform, each with
// its source, verification date and status; this file maps a row to the builder's `CacheProfile`.

import { CACHE_PROFILE_TABLE, findCacheProfile, normalizeModelRef, type CacheProfileRow, type CacheRoute, type CacheTtl as TableTtl } from "../../../providers/src/index.ts";

export type CacheTtl = TableTtl;
export type { CacheRoute };

export interface CacheProfile {
  /** The table row; `unknown` for the fail-closed fallback. */
  id: string;
  provider: CacheProfileRow["provider"] | "unknown";
  /** `explicit`: the caller marks breakpoints; `implicit`: the provider caches the longest stable prefix on its own;
   *  `none`: nothing is known, so no marker is ever emitted. */
  mechanism: "explicit" | "implicit" | "none";
  /** Minimum cacheable prefix in tokens; below it nothing caches and no error is returned (R2). */
  minTokens: number;
  /** Most explicit breakpoints per request; 0 for `implicit`/`none`. */
  maxBreakpoints: number;
  /** How many block positions a cache read walks back from a breakpoint; 0 where the provider documents none. */
  lookbackPositions: number;
  /** TTL tiers the caller can choose, shortest first. */
  ttls: readonly CacheTtl[];
  /** Window in which a repeated prefix is predicted warm; null when unknown. */
  warmMs: number | null;
  known: boolean;
}

/** The table's rows (read-only), in lookup order. */
export const CACHE_PROFILES: readonly CacheProfileRow[] = CACHE_PROFILE_TABLE.rows;

/**
 * RULING (fail closed): a model the table does not know gets no breakpoint markers (a wire format may reject
 * `cache_control` it does not support), the highest floor in the table, and `known: false`, which the builder reports as
 * a typed `prompt.unknown-model` event so the gap is visible instead of silently uncached.
 */
const UNKNOWN: CacheProfile = {
  id: "unknown", provider: "unknown", mechanism: "none", minTokens: Math.max(...CACHE_PROFILES.map((r) => r.minTokens)),
  maxBreakpoints: 0, lookbackPositions: 0, ttls: [], warmMs: null, known: false,
};

/** `Anthropic/Claude-Opus-4.5` -> `claude-opus-4-5`: lower case, no gateway or platform decoration, dots as dashes, served aliases applied. */
export function normalizeModelId(model: string): string {
  return normalizeModelRef(model).id;
}

/** The builder's view of the row for `model` on `route` (first-party when no route is known). */
export function lookupCacheProfile(model: string, route?: CacheRoute): CacheProfile {
  const { row } = findCacheProfile(model, route);
  if (!row) return UNKNOWN;
  return {
    id: row.id, provider: row.provider, mechanism: row.mechanism, minTokens: row.minTokens, maxBreakpoints: row.maxBreakpoints,
    lookbackPositions: row.lookbackPositions, ttls: row.ttls.map((t) => t.ttl), warmMs: row.warmMs, known: true,
  };
}
