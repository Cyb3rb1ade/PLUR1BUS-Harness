// Retry with equal-jitter exponential backoff, only for errors where retrying the identical request can succeed (G2).
import { AdapterError } from "./errors.ts";

export interface RetryPolicy {
  /** Total attempts including the first; 1 disables retrying. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A server Retry-After above this is not slept: the error goes back to the caller, who knows the larger picture. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4000, maxRetryAfterMs: 10_000 });

export function resolveRetryPolicy(partial: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...partial };
}

export interface RetryDeps {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Uniform in [0, 1). */
  random: () => number;
  signal?: AbortSignal;
}

/** Half the capped exponential ceiling is guaranteed, the other half is jitter: spread without ever hammering. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AdapterError("aborted", "aborted while waiting to retry"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AdapterError("aborted", "aborted while waiting to retry"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy, deps: RetryDeps): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (deps.signal?.aborted) throw new AdapterError("aborted", "aborted before the request was sent");
    try {
      return await fn(attempt);
    } catch (e) {
      if (!(e instanceof AdapterError) || !e.retryable || attempt >= policy.maxAttempts) throw e;
      let delay: number;
      if (e.retryAfterMs !== undefined) {
        if (e.retryAfterMs > policy.maxRetryAfterMs) throw e;
        delay = e.retryAfterMs;
      } else {
        delay = backoffDelayMs(attempt, policy, deps.random);
      }
      await deps.sleep(delay, deps.signal);
    }
  }
}
