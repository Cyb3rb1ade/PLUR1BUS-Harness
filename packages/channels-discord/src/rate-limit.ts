export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** `PATCH /channels/123/messages/456` -> `PATCH /channels/123/messages/:id`. Channels, guilds and webhooks are Discord's "major
 *  parameters" and keep their id; every other snowflake and every interaction/webhook token is masked. */
export function routeKey(method: string, path: string): string {
  const seg = path.split("?")[0]!.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i]!;
    const prev = seg[i - 1];
    if (prev === "interactions" && i === 1) out.push(":id");
    else if (seg[0] === "interactions" && i === 2) out.push(":token");
    else if (seg[0] === "webhooks" && i === 2) out.push(":token");
    else if (/^\d+$/.test(s) && !(prev === "channels" || prev === "guilds" || (prev === "webhooks" && i === 1))) out.push(":id");
    else out.push(s);
  }
  return `${method.toUpperCase()} /${out.join("/")}`;
}

interface BucketState {
  remaining: number;
  resetAt: number;
}

/** Per-route buckets learned from X-RateLimit-* headers, a global limit, and serialised access per bucket so concurrent callers
 *  cannot spend the same remaining slot. Routes that Discord documents as exempt from the global limit pass `global=false`. */
export class RestLimiter {
  readonly #now: () => number;
  readonly #sleep: Sleep;
  readonly #states = new Map<string, BucketState>();
  readonly #routeToState = new Map<string, string>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #globalPerSec: number;
  #globalUntil = 0;
  #windowStart = 0;
  #windowCount = 0;
  constructor(now: () => number, sleep: Sleep, globalPerSec = 45) {
    this.#now = now;
    this.#sleep = sleep;
    this.#globalPerSec = globalPerSec;
  }
  /** Resolves when the request may be sent. Callers MUST call `update` or `release` afterwards (done by DiscordApi). */
  async acquire(route: string, signal: AbortSignal, global: boolean): Promise<void> {
    const prev = this.#tails.get(route) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.#tails.set(route, tail);
    await prev;
    try {
      for (;;) {
        signal.throwIfAborted();
        const wait = this.#waitFor(route, global);
        if (wait <= 0) break;
        await this.#sleep(wait, signal);
      }
      signal.throwIfAborted();
      if (global) this.#countGlobal();
      const st = this.#states.get(this.#routeToState.get(route) ?? route);
      if (st && st.remaining > 0) st.remaining -= 1;
    } catch (e) {
      release();
      if (this.#tails.get(route) === tail) this.#tails.delete(route);
      throw e;
    }
    // Hold the route until the response has been recorded.
    this.#holds.set(route, () => {
      release();
      if (this.#tails.get(route) === tail) this.#tails.delete(route);
    });
  }
  readonly #holds = new Map<string, () => void>();
  /** Record headers of a response and let the next caller on this route proceed. */
  update(route: string, headers: Headers): void {
    const bucket = headers.get("x-ratelimit-bucket");
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const resetAfter = Number(headers.get("x-ratelimit-reset-after"));
    if (headers.has("x-ratelimit-remaining") && Number.isFinite(remaining) && Number.isFinite(resetAfter)) {
      const major = /\/(?:channels|guilds|webhooks)\/(\d+)/.exec(route)?.[1] ?? "";
      const key = bucket ? `${bucket}|${major}` : route;
      if (bucket) this.#routeToState.set(route, key);
      this.#states.set(key, { remaining, resetAt: this.#now() + Math.min(Math.max(resetAfter, 0), 300) * 1000 });
    }
    this.release(route);
  }
  release(route: string): void {
    const h = this.#holds.get(route);
    this.#holds.delete(route);
    h?.();
  }
  /** After a 429: block this route (or everything) for `ms`. */
  penalize(route: string, ms: number, global: boolean): void {
    if (global) this.#globalUntil = Math.max(this.#globalUntil, this.#now() + ms);
    else this.#states.set(this.#routeToState.get(route) ?? route, { remaining: 0, resetAt: this.#now() + ms });
  }
  #waitFor(route: string, global: boolean): number {
    const now = this.#now();
    let wait = 0;
    if (global) {
      wait = Math.max(wait, this.#globalUntil - now);
      if (now - this.#windowStart >= 1000) {
        this.#windowStart = now;
        this.#windowCount = 0;
      }
      if (this.#windowCount >= this.#globalPerSec) wait = Math.max(wait, this.#windowStart + 1000 - now);
    }
    const key = this.#routeToState.get(route) ?? route;
    const st = this.#states.get(key);
    if (st) {
      if (st.resetAt <= now) this.#states.delete(key);
      else if (st.remaining <= 0) wait = Math.max(wait, st.resetAt - now);
    }
    return Math.ceil(wait);
  }
  #countGlobal(): void {
    const now = this.#now();
    if (now - this.#windowStart >= 1000) {
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    this.#windowCount += 1;
  }
}
