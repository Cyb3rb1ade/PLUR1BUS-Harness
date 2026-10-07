// Token buckets over an injected clock (no timers, no sleeps). One bucket per key; full again = forgotten.
export interface RateClock { now(): number }

export class Buckets {
  readonly #perMinute: number; readonly #clock: RateClock; readonly #max: number;
  readonly #b = new Map<string, { tokens: number; at: number }>();
  constructor(perMinute: number, clock: RateClock, maxKeys = 10_000) {
    if (!(perMinute >= 1)) throw new Error("rate must be >= 1 per minute");
    this.#perMinute = perMinute; this.#clock = clock; this.#max = maxKeys;
  }
  #refill(key: string): { tokens: number; at: number } {
    const now = this.#clock.now();
    const cur = this.#b.get(key);
    const b = cur ?? { tokens: this.#perMinute, at: now };
    b.tokens = Math.min(this.#perMinute, b.tokens + Math.max(0, now - b.at) / 60_000 * this.#perMinute);
    b.at = now;
    return b;
  }
  /** Draws one token. `retryAfterSec` is meaningful when it answers false. */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const b = this.#refill(key);
    this.#b.delete(key);
    if (this.#b.size >= this.#max) { const first = this.#b.keys().next(); if (!first.done) this.#b.delete(first.value); } // oldest idle key goes
    this.#b.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / (this.#perMinute / 60))) };
  }
  /** Whether a token is available, without drawing one. */
  has(key: string): boolean { return this.#refill(key).tokens >= 1; }
}
