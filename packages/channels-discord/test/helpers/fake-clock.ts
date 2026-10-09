interface Timer {
  at: number;
  seq: number;
  fire: () => void;
}

/** Virtual time. `sleep` resolves only when `advance` passes its deadline (or the signal aborts, like the production sleep). */
export class FakeClock {
  t = 1_700_000_000_000;
  readonly slept: number[] = [];
  #timers: Timer[] = [];
  #seq = 0;
  readonly now = (): number => this.t;
  readonly sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      this.slept.push(ms);
      if (signal.aborted) return resolve();
      const timer: Timer = {
        at: this.t + Math.max(0, ms),
        seq: this.#seq++,
        fire: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.#timers = this.#timers.filter((x) => x !== timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#timers.push(timer);
    });
  get pending(): number {
    return this.#timers.length;
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r));
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await this.flush();
      const due = this.#timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fire();
    }
    this.t = target;
    await this.flush();
  }
}

/** Advances virtual time until `p` settles (retries and backoff sleep on the clock). Throws if it never settles. */
export async function drive(clock: FakeClock, p: Promise<unknown>): Promise<void> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 500 && !done; i++) {
    await clock.advance(1000);
  }
  if (!done) throw new Error("promise did not settle under virtual time");
}

/** Lets real loopback I/O run (HTTP bodies arrive on later event-loop turns) until `cond` holds. Virtual time is not advanced. */
export async function settle(clock: FakeClock, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) {
    await clock.flush();
    if (!cond()) await new Promise((r) => setTimeout(r, 1));
  }
  if (!cond()) throw new Error("condition did not settle");
}
