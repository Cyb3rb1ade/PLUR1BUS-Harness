// RE-D29 (RE-14/P5): the weight with which cache reads count against token limits, kept in the budget store's
// settings table beside the time zone. Provider adapters report `inputTokens` as the whole prompt, cache reads and
// writes included (`packages/providers` `Usage`), so a token limit counts input - cacheRead × (1 - w) + output. The
// weight is applied when usage is summed and never written into the ledger, so a changed weight re-rates a whole period
// at once; reservations stay the unweighted estimate. Weight 1, the default, counts every cache read in full: the
// behaviour from before the setting. Which default ships is an open owner decision (RE-D29).
import type { DatabaseSync } from "node:sqlite";

/** Full weight: a cache read counts like any other input token, as before RE-D29. */
export const DEFAULT_CACHE_READ_WEIGHT = 1;
/** A weight is kept and applied in millionths. */
const MICROS = 1_000_000;
const SETTING = "cache_read_weight";
/** What `writeCacheReadWeight` stores: a weight in millionths prints as a plain decimal, never with an exponent. */
const STORED = /^\d+(\.\d+)?$/;

/** A weight as stored and applied: a number from 0 to 1, rounded to millionths; anything else is a RangeError. */
export function validateCacheReadWeight(w: unknown): number {
  if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 1) {
    throw new RangeError("cache read weight must be a number from 0 to 1");
  }
  return (Math.round(w * MICROS) || 0) / MICROS; // `|| 0` stores -0 as 0
}

/** The stored weight. A missing or unparsable value (a store edited by hand) is full weight: every read counts. */
export function storedCacheReadWeight(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING) as { value: string } | undefined;
  const w = row && STORED.test(row.value) ? Number(row.value) : Number.NaN;
  return w >= 0 && w <= 1 ? validateCacheReadWeight(w) : DEFAULT_CACHE_READ_WEIGHT;
}

/** Validates and stores a weight; returns it as it will be applied. */
export function writeCacheReadWeight(db: DatabaseSync, w: unknown): number {
  const v = validateCacheReadWeight(w);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(SETTING, String(v));
  return v;
}

/**
 * SQL over one `usage_event` row: the cache reads the weight may take off. A row never takes off more than its own
 * input, even when a provider reports more cache reads than prompt tokens.
 */
export const CACHE_READS_SQL = "MIN(cache_read_tokens, input_tokens)";

/**
 * The tokens a token limit counts for summed usage: `inputOutput` (input + output, input including cache reads and
 * writes) less the share 1 - w of `cacheReads` (summed with `CACHE_READS_SQL`). The weighted share of the reads,
 * cacheReads × w, is rounded up to a whole token once per sum, in exact integer arithmetic, so a limit never counts
 * less than the rule; with w = 1 the result is `inputOutput` itself.
 */
export function countedTokens(inputOutput: number, cacheReads: number, weight: number): number {
  const micros = BigInt(Math.round(weight * MICROS));
  const kept = (BigInt(cacheReads) * micros + BigInt(MICROS - 1)) / BigInt(MICROS);
  return inputOutput - cacheReads + Number(kept);
}
