export interface BackoffPolicy { baseMs: number; maxMs: number }

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 60_000 };

/** `baseMs * 2^attempt`, capped at `maxMs`. No jitter: deterministic under a fake clock; one process, no thundering herd. */
export function backoffDelay(p: BackoffPolicy, attempt: number): number {
  const n = Math.max(0, Math.min(attempt, 52)); // 2^52 stays exact; the cap decides long before that
  return Math.min(p.maxMs, p.baseMs * 2 ** n);
}
