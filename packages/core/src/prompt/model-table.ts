// The per-model prompt-cache table (ADR-010 R1/R2, §3 of docs/provider-matrix.md). This is the fragile part of the caching
// design ("revisit when a provider changes its contract"), so it is data, one row per model family, each with its source.
// Rows are tried in order; the first match wins, so a narrower family must precede a broader one.

export type CacheTtl = "5m" | "1h" | "30m";

export interface CacheProfile {
  /** The table row; `unknown` for the fail-closed fallback. */
  id: string;
  provider: "anthropic" | "openai" | "google" | "unknown";
  /** `explicit`: the caller marks breakpoints; `implicit`: the provider caches the longest stable prefix on its own;
   *  `none`: nothing is known, so no marker is ever emitted. */
  mechanism: "explicit" | "implicit" | "none";
  /** Minimum cacheable prefix in tokens; below it nothing caches and no error is returned (R2). */
  minTokens: number;
  /** Most explicit breakpoints per request; 0 for `implicit`/`none`. */
  maxBreakpoints: number;
  /** How many block positions a cache read walks back from a breakpoint; 0 where the provider documents none. */
  lookbackPositions: number;
  ttls: readonly CacheTtl[];
  known: boolean;
}

interface Row extends Omit<CacheProfile, "known"> {
  match: RegExp;
  source: string;
}

const MATRIX = "docs/provider-matrix.md §3";
const anthropic = (id: string, match: RegExp, minTokens: number, source = MATRIX): Row => ({
  id, match, provider: "anthropic", mechanism: "explicit", minTokens, maxBreakpoints: 4, lookbackPositions: 20, ttls: ["5m", "1h"], source,
});
const implicit = (id: string, provider: "openai" | "google", match: RegExp, minTokens: number, source: string): Row => ({
  id, match, provider, mechanism: "implicit", minTokens, maxBreakpoints: 0, lookbackPositions: 0, ttls: [], source,
});

export const CACHE_PROFILES: readonly Row[] = [
  // Anthropic, by documented minimum. Narrow rows first: `claude-mythos-preview` before the Mythos 5 family.
  anthropic("anthropic.mythos-preview", /^claude-mythos-preview(-|$)/, 2048),
  anthropic("anthropic.fable-mythos-5", /^claude-(fable|mythos)-5(-\d{1,2})?(-|$)/, 512),
  // RULING: the matrix lists "Opus 5"; Opus 5.x and Sonnet 5.x are treated as the same row (same family generation).
  anthropic("anthropic.opus-5", /^claude-opus-5(-\d{1,2})?(-|$)/, 512, "docs/provider-matrix.md §3 (Opus 5); RULING: minor releases share the row"),
  anthropic("anthropic.sonnet-5", /^claude-sonnet-5(-\d{1,2})?(-|$)/, 1024, "docs/provider-matrix.md §3 (Sonnet 5); RULING: minor releases share the row"),
  anthropic("anthropic.sonnet-4.5-4.6", /^claude-sonnet-4-[56](-|$)/, 1024),
  anthropic("anthropic.opus-4.7", /^claude-opus-4-7(-|$)/, 2048),
  anthropic("anthropic.opus-4.5-4.6", /^claude-opus-4-[56](-|$)/, 4096),
  anthropic("anthropic.opus-4-4.1", /^claude-opus-4(-[01])?(-\d{8})?$/, 1024),
  anthropic("anthropic.haiku-4.5", /^claude-haiku-4-5(-|$)/, 4096),
  anthropic("anthropic.haiku-3.5", /^claude-(3-5-haiku|haiku-3-5)(-|$)/, 2048),
  // OpenAI GPT-5.6+: explicit `prompt_cache_options`, 30m the only TTL. The matrix gives no breakpoint count for it.
  {
    id: "openai.gpt-5.6+", provider: "openai", mechanism: "explicit", minTokens: 1024, maxBreakpoints: 4, lookbackPositions: 0, ttls: ["30m"],
    match: /^gpt-5-(?:[6-9]|\d{2,})(-|$)/, source: "docs/provider-matrix.md §3 (GPT-5.6+); RULING: 4 explicit breakpoints, the same shape as Anthropic (ADR-010 §1)",
  },
  // RULING: pre-5.6 minimums are "variable"; 1 024 is the documented GPT-5.6+ floor and the lowest plausible one.
  implicit("openai.implicit", "openai", /^(gpt-|o\d)/, 1024, "docs/provider-matrix.md §3 (pre-5.6: automatic only); RULING: floor 1 024"),
  implicit("google.gemini-2.5", "google", /^gemini-2-5(-|$)/, 2048, MATRIX),
  implicit("google.gemini-3", "google", /^gemini-3(-|$)/, 4096, MATRIX),
  // RULING: any other Gemini gets the higher documented floor (fail closed: warn rather than assume it caches).
  implicit("google.gemini-other", "google", /^gemini-/, 4096, "RULING: highest documented Gemini floor"),
];

const UNKNOWN: CacheProfile = {
  id: "unknown", provider: "unknown", mechanism: "none", minTokens: 4096, maxBreakpoints: 0, lookbackPositions: 0, ttls: [], known: false,
};

/** `Anthropic/Claude-Opus-4.5` -> `claude-opus-4-5`: lower case, no `vendor/` prefix (OpenRouter), dots as dashes. */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/^(anthropic|openai|google)\//, "").replace(/\./g, "-");
}

/**
 * RULING (fail closed): a model the table does not know gets no breakpoint markers (a wire format may reject
 * `cache_control` it does not support), the highest floor in the table, and `known: false`, which the builder reports as
 * a typed `prompt.unknown-model` event so the gap is visible instead of silently uncached.
 */
export function lookupCacheProfile(model: string): CacheProfile {
  const id = normalizeModelId(model);
  const row = CACHE_PROFILES.find((r) => r.match.test(id));
  if (!row) return UNKNOWN;
  const { match: _m, source: _s, ...profile } = row;
  return { ...profile, known: true };
}
