import type { Clock } from "./clock.ts";

export interface BucketSpec { capacity: number; refillPerSec: number }
/** The route classes of ADR-004 *Rate limits*: `auth` (login), `totp` (second factor), `read`, `write`, and `stream`
 *  (opening a long-lived SSE/WebSocket connection; no such route exists yet, the class is ready for the first one). */
export type RateClass = "auth" | "totp" | "read" | "write" | "stream";
/** A configuration may name only `auth`, `read` and `write`; `totp` and `stream` then keep their defaults. */
export type RateClasses = Record<"auth" | "read" | "write", BucketSpec> & Partial<Record<"totp" | "stream", BucketSpec>>;

/** Per principal and per IP, per route class. `auth` is the login class: a handful of attempts, then one more every
 *  12 s. `totp` is stricter still: 5 codes, then one more a minute (a six-digit code has a million values; the ±1 window
 *  and the replay guard sit on top of this). */
export const DEFAULT_RATE_CLASSES: Record<RateClass, BucketSpec> = {
  auth: { capacity: 5, refillPerSec: 1 / 12 },
  totp: { capacity: 5, refillPerSec: 1 / 60 },
  read: { capacity: 120, refillPerSec: 20 },
  write: { capacity: 30, refillPerSec: 5 },
  stream: { capacity: 6, refillPerSec: 0.2 },
};

interface Bucket { tokens: number; at: number }
export type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

/** A token bucket per key. A key's bucket starts full, refills continuously from the injected clock and is dropped
 *  once it is full again, so memory follows the *active* keys; when `maxKeys` active keys exist the oldest goes. */
export class RateLimiter {
  readonly #clock: Clock; readonly #classes: Record<RateClass, BucketSpec>; readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();
  constructor(clock: Clock, given: RateClasses = DEFAULT_RATE_CLASSES, maxKeys = 10_000) {
    const classes: Record<RateClass, BucketSpec> = { ...DEFAULT_RATE_CLASSES, ...given };
    for (const [name, s] of Object.entries(classes)) {
      if (!(s.capacity >= 1) || !(s.refillPerSec > 0)) throw new Error(`rate class ${name}: capacity must be >= 1 and refillPerSec > 0`);
    }
    this.#clock = clock; this.#classes = classes; this.#maxKeys = maxKeys;
  }

  /** Takes one token from `key`'s bucket of class `cls`. */
  take(cls: RateClass, key: string): Verdict {
    const spec = this.#classes[cls];
    const k = `${cls}\u0000${key}`;
    const now = this.#clock.now();
    let b = this.#buckets.get(k);
    if (!b) {
      if (this.#buckets.size >= this.#maxKeys) this.#evict(now);
      b = { tokens: spec.capacity, at: now };
    } else {
      b.tokens = Math.min(spec.capacity, b.tokens + Math.max(0, now - b.at) / 1000 * spec.refillPerSec);
      b.at = now;
    }
    this.#buckets.delete(k); this.#buckets.set(k, b); // re-insert: Map order is least recently used first
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / spec.refillPerSec)) };
  }

  /** Both buckets a request draws on must have a token; the second is only drawn when the first answered. */
  takeAll(cls: RateClass, keys: string[]): Verdict {
    for (const key of keys) { const v = this.take(cls, key); if (!v.ok) return v; }
    return { ok: true };
  }

  get size(): number { return this.#buckets.size; }

  #evict(now: number): void {
    for (const [k, b] of this.#buckets) {
      const cls = k.slice(0, k.indexOf("\u0000")) as RateClass;
      const spec = this.#classes[cls];
      if (b.tokens + Math.max(0, now - b.at) / 1000 * spec.refillPerSec >= spec.capacity) this.#buckets.delete(k);
    }
    while (this.#buckets.size >= this.#maxKeys) { const first = this.#buckets.keys().next(); if (first.done) break; this.#buckets.delete(first.value); }
  }
}
