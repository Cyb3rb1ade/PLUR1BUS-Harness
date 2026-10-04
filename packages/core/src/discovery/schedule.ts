// Schedule calculation and backoff math for model discovery (spec §2.8, §2.9, R12, R13; plan Task 6).
import type { Rng } from "./ports.ts";

/**
 * Next regular scan time: fromMs + interval * (1 + 0.1 * (2u - 1)), floor 1 h after jitter.
 */
export function nextRegularAt(fromMs: number, intervalHours: number, rng: Rng): number {
  const intervalMs = intervalHours * 3600_000;
  const u = rng();
  const jittered = intervalMs * (1 + 0.1 * (2 * u - 1));
  const floored = Math.max(3600_000, jittered);
  return fromMs + floored;
}

/**
 * Exponential backoff: min(300_000 * 2^(n-1), 21_600_000) * (1 +/- 0.1), n >= 1.
 */
export function backoffDelayMs(consecutiveFailures: number, rng: Rng): number {
  const n = Math.max(1, consecutiveFailures);
  const base = Math.min(300_000 * Math.pow(2, n - 1), 21_600_000);
  const u = rng();
  return Math.round(base * (1 + 0.1 * (2 * u - 1)));
}

/**
 * Retry delay: max(backoff step, Retry-After).
 */
export function retryDelayMs(consecutiveFailures: number, retryAfterMs: number | undefined, rng: Rng): number {
  const backoff = backoffDelayMs(consecutiveFailures, rng);
  if (retryAfterMs !== undefined && retryAfterMs > backoff) {
    return retryAfterMs;
  }
  return backoff;
}
