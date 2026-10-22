import type { Clock } from "./clock.ts";

export interface BucketSpec { capacity: number; refillPerSec: number }
/** The route classes of ADR-004 *Rate limits*: `auth` (login), `totp` (second factor), `read`, `write`, `stream`
 *  (opening a long-lived SSE/WebSocket connection) and `expensive` (model-backed work: a chat turn, a job or dream run, a
 *  realtime voice session; it also sits under the global concurrency cap, `ConcurrencyLimit`). */
export type RateClass = "auth" | "totp" | "read" | "write" | "stream" | "rpc" | "expensive";
/** A configuration may name only `auth`, `read` and `write`; the other classes then keep their defaults. */
export type RateClasses = Record<"auth" | "read" | "write", BucketSpec> & Partial<Record<"totp" | "stream" | "rpc" | "expensive", BucketSpec>>;

/** Per principal and per IP, per route class. `auth` is the login class: a handful of attempts, then one more every
 *  12 s. `totp` is stricter still: 5 codes, then one more a minute (a six-digit code has a million values; the ±1 window
 *  and the replay guard sit on top of this). */
export const DEFAULT_RATE_CLASSES: Record<RateClass, BucketSpec> = {
  auth: { capacity: 5, refillPerSec: 1 / 12 },
  totp: { capacity: 5, refillPerSec: 1 / 60 },
  read: { capacity: 120, refillPerSec: 20 },
  write: { capacity: 30, refillPerSec: 5 },
  rpc: { capacity: 60, refillPerSec: 10 },
  stream: { capacity: 6, refillPerSec: 0.2 },
  expensive: { capacity: 10, refillPerSec: 1 / 6 },
};

/** How much wider an address bucket is when the address says nothing about the client: behind `tailscale serve` every
 *  tailnet client reaches the API from 127.0.0.1. The address bucket is then only an upper bound for everybody together;
 *  the per-name (login) and per-principal buckets are the ones that tell clients apart. */
export const SHARED_ADDRESS_SCALE = 10;

/** RPC methods reachable through `POST /rpc` that start model-backed work. They draw on the `expensive` bucket of the caller and
 *  hold one slot of the global concurrency cap while they run (the REST chat submit does the same through its route class). */
export const EXPENSIVE_RPC_METHODS: ReadonlySet<string> = new Set(["session.submit", "jobs.run", "dreams.run", "voice.realtime.start", "media.generate", "media.edit"]);
export const DEFAULT_EXPENSIVE_CONCURRENCY = 8;

/** At most `max` model-backed operations run at the same time, installation-wide (ADR-004: global concurrency cap). */
export class ConcurrencyLimit {
  readonly #max: number; #active = 0;
  constructor(max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("the concurrency limit must be a positive integer");
    this.#max = max;
  }
  /** A release function (call it exactly once; later calls do nothing), or `undefined` when all slots are taken. */
  tryAcquire(): (() => void) | undefined {
    if (this.#active >= this.#max) return undefined;
    this.#active++; let done = false;
    return () => { if (!done) { done = true; this.#active--; } };
  }
  get active(): number { return this.#active; }
}

interface Bucket { tokens: number; at: number; capacity: number; refillPerSec: number }
export type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

/** A token bucket per key. A key's bucket starts full, refills continuously from the injected clock and is dropped
 *  once it is full again, so memory follows the *active* keys; when `maxKeys` active keys exist the oldest goes. */
export class RateLimiter {
  readonly #clock: Clock; readonly #classes: Record<RateClass, BucketSpec>; readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();
  constructor(clock: Clock, given: RateClasses = DEFAULT_RATE_CLASSES, maxKeys = 10_000) {
    const classes: Record<RateClass, BucketSpec> = { ...DEFAULT_RATE_CLASSES, ...given };
    for (const [name, s] of Object.entries(classes)) {
      // Finite, because an infinite refill turns `0 elapsed x Infinity` into NaN tokens and the bucket then refuses for good.
      if (!Number.isFinite(s.capacity) || !Number.isFinite(s.refillPerSec) || !(s.capacity >= 1) || !(s.refillPerSec > 0)) throw new Error(`rate class ${name}: capacity must be finite and >= 1, and refillPerSec finite and > 0`);
    }
    this.#clock = clock; this.#classes = classes; this.#maxKeys = maxKeys;
  }

  /** Takes one token from `key`'s bucket of class `cls`. `scale` widens capacity and refill of that one bucket (an upper
   *  bound for a shared address); a key must always be taken with the same scale. */
  take(cls: RateClass, key: string, scale = 1): Verdict {
    const base = this.#classes[cls];
    const spec = scale === 1 ? base : { capacity: base.capacity * scale, refillPerSec: base.refillPerSec * scale };
    const k = `${cls}\u0000${key}`;
    const now = this.#clock.now();
    let b = this.#buckets.get(k);
    if (!b) {
      if (this.#buckets.size >= this.#maxKeys) this.#evict(now);
      b = { tokens: spec.capacity, at: now, capacity: spec.capacity, refillPerSec: spec.refillPerSec };
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
      if (b.tokens + Math.max(0, now - b.at) / 1000 * b.refillPerSec >= b.capacity) this.#buckets.delete(k);
    }
    while (this.#buckets.size >= this.#maxKeys) { const first = this.#buckets.keys().next(); if (first.done) break; this.#buckets.delete(first.value); }
  }
}
