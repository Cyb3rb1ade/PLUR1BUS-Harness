// A small sliding-window limiter: at most `max` accepted hits per key within `windowMs`. Denied hits are not recorded,
// so a client that keeps hammering does not extend its own block beyond the oldest accepted hit leaving the window.
// In-memory by design: the limits protect an hour-long pairing window, not a long-lived resource.
import type { EpochMs } from "./types.ts";

export interface LimitDecision { readonly allowed: boolean; readonly retryAfterMs: number }

export class SlidingWindowLimiter {
  readonly max: number;
  readonly windowMs: number;
  private readonly hits = new Map<string, EpochMs[]>();

  constructor(o: { max: number; windowMs: number }) {
    if (!Number.isInteger(o.max) || o.max < 1) throw new Error("max must be a positive integer");
    if (!Number.isFinite(o.windowMs) || o.windowMs <= 0) throw new Error("windowMs must be positive");
    this.max = o.max;
    this.windowMs = o.windowMs;
  }

  hit(key: string, now: EpochMs): LimitDecision {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: recent[0]! + this.windowMs - now };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Drops keys with nothing left in the window. */
  sweep(now: EpochMs): void {
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > now - this.windowMs)) this.hits.delete(key);
    }
  }

  size(): number {
    return this.hits.size;
  }
}
