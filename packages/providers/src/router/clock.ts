import type { Clock } from "./types.ts";

/**
 * The wall clock and real timers. `sleep` rejects with the signal's reason when aborted and leaves no timer or listener
 * behind on any path. Tests inject a fake `Clock` instead.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
