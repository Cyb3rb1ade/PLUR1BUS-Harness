/** Time as a port: the lifecycle never calls `setTimeout` directly, so tests drive it with a fake clock and no sleeps. */
export interface Timer { cancel(): void }
export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): Timer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const h = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(h) };
  },
};

/** Race `fn()` against a deadline. A synchronous throw, a rejection and a hang are all turned into one rejection. */
export function withTimeout<T>(clock: Clock, fn: () => Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimer(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    try {
      fn().then(
        (v) => { timer.cancel(); resolve(v); },
        (e) => { timer.cancel(); reject(e); },
      );
    } catch (e) {
      timer.cancel();
      reject(e);
    }
  });
}
