/** Serialized reservations prevent concurrent sends from spending the same token. Fake clocks advance via sleep in tests. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #interval: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #tokens: number;
  #at: number;
  #tail: Promise<void> = Promise.resolve();
  constructor(
    capacity: number,
    intervalMs: number,
    now: () => number,
    sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  ) {
    this.#capacity = capacity;
    this.#interval = intervalMs;
    this.#now = now;
    this.#sleep = sleep;
    this.#tokens = capacity;
    this.#at = now();
  }
  take(signal: AbortSignal): Promise<void> {
    const run = this.#tail.then(async () => {
      signal.throwIfAborted();
      const now = Math.max(this.#at, this.#now());
      this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#at) / this.#interval);
      this.#at = now;
      if (this.#tokens < 1) {
        const wait = Math.ceil((1 - this.#tokens) * this.#interval);
        await this.#sleep(wait, signal);
        signal.throwIfAborted();
        this.#at = Math.max(this.#now(), now + wait);
        this.#tokens = 1;
      }
      this.#tokens -= 1;
    });
    this.#tail = run.catch(() => {});
    return run;
  }
}
