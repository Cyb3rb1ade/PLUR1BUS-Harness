// A small sliding-window limiter: at most `max` accepted hits per key within `windowMs`. Denied hits are not recorded,
// so a client that keeps hammering does not extend its own block beyond the oldest accepted hit leaving the window.
// In-memory by design: the limits protect an hour-long pairing window, not a long-lived resource.
import type { EpochMs } from "./types.ts";

export interface LimitDecision { readonly allowed: boolean; readonly retryAfterMs: number }

export class SlidingWindowLimiter {
  readonly max: number;
  readonly windowMs: number;
  /** Ceiling on remembered keys: past it the oldest-seen key is forgotten, so a flood of distinct sources cannot grow memory. */
  readonly maxKeys: number;
  private readonly hits = new Map<string, EpochMs[]>();
  private lastSweep: EpochMs | undefined;

  constructor(o: { max: number; windowMs: number; maxKeys?: number }) {
    if (!Number.isInteger(o.max) || o.max < 1) throw new Error("max must be a positive integer");
    if (!Number.isFinite(o.windowMs) || o.windowMs <= 0) throw new Error("windowMs must be positive");
    if (o.maxKeys !== undefined && (!Number.isInteger(o.maxKeys) || o.maxKeys < 1)) throw new Error("maxKeys must be a positive integer");
    this.max = o.max;
    this.windowMs = o.windowMs;
    this.maxKeys = o.maxKeys ?? 100_000;
  }

  hit(key: string, now: EpochMs): LimitDecision {
    // Idle keys leave once per window without anyone having to call sweep(); the ceiling holds even inside one window.
    if (this.lastSweep === undefined || now - this.lastSweep >= this.windowMs || now < this.lastSweep) { this.sweep(now); this.lastSweep = now; }
    if (!this.hits.has(key)) while (this.hits.size >= this.maxKeys) { const oldest = this.hits.keys().next(); if (oldest.done) break; this.hits.delete(oldest.value); }
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
