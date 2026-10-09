import { setTimeout as delay } from 'node:timers/promises';
export interface RetryPolicy {
  /** Total attempts including the first. Default 3, at most 10. */
  maxAttempts?: number; baseMs?: number; maxMs?: number;
  /** Test seam. Must reject when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; random?: () => number;
}
export const DEFAULT_RETRY = { maxAttempts: 3, baseMs: 500, maxMs: 30_000 } as const;
export const defaultSleep = async (ms: number, signal: AbortSignal): Promise<void> => { await delay(ms, undefined, { signal }); };
/** Seconds or an HTTP date, in milliseconds; undefined when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim(); if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  if (!/[a-z]/i.test(text) || !/\d{4}/.test(text)) return undefined;
  const at = Date.parse(text); if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
/**
 * 429 means the request was rejected before processing, so a resend cannot bill twice. A 5xx on a submission may have
 * been processed; only idempotent reads are retried on it. This keeps the MG-1 rule that a submission is never resent blindly.
 */
export function retryable(method: string, status: number): boolean {
  if (status === 429) return true;
  return method === 'GET' && [500, 502, 503, 504].includes(status);
}
/** Milliseconds to wait before the next attempt, or undefined when the provider asks for longer than the bound. */
export function retryDelay(attempt: number, policy: RetryPolicy, retryAfter: string | null | undefined, now = Date.now()): number | undefined {
  const maxMs = policy.maxMs ?? DEFAULT_RETRY.maxMs; const advertised = parseRetryAfter(retryAfter, now);
  if (advertised !== undefined) return advertised > maxMs ? undefined : advertised;
  const base = (policy.baseMs ?? DEFAULT_RETRY.baseMs) * 2 ** attempt;
  return Math.min(maxMs, base + Math.floor((policy.random ?? Math.random)() * (policy.baseMs ?? DEFAULT_RETRY.baseMs)));
}
