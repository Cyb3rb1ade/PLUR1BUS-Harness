// Bounded, abortable client fan-out for the palette's entity groups. One call per keystroke generation: every source runs under its
// own time limit, a source that fails, is forbidden/unavailable or is too slow is dropped silently (only its group), and nothing from
// an aborted generation is ever delivered. Pure scheduling, no DOM and no i18n: unit-tested in test/palette-fanout.test.ts.
export type Source = { id: string; load: (query: string, signal: AbortSignal) => Promise<unknown> };

/** Defaults: debounce before a generation starts, total time per source, hard cap on results per group. */
export const FANOUT = { debounceMs: 150, timeoutMs: 1500, cap: 5 } as const;

/** Starts all sources; `onResult(id, value)` is called once per source that answers in time, `onResult(id, null)` once for one that
 * does not (failed, refused, too slow). After `signal` aborts nothing is called any more. */
export function runFanout(query: string, sources: readonly Source[], signal: AbortSignal, onResult: (id: string, value: unknown) => void, timeoutMs: number = FANOUT.timeoutMs): void {
  for (const src of sources) {
    const ctl = new AbortController();
    let done = false;
    const finish = (value: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (value === null) ctl.abort();
      if (!signal.aborted) onResult(src.id, value);
    };
    const stop = (): void => { done = true; clearTimeout(timer); ctl.abort(); };
    const timer = setTimeout(() => { finish(null); }, timeoutMs);
    if (signal.aborted) { stop(); continue; }
    signal.addEventListener("abort", stop, { once: true });
    let p: Promise<unknown>;
    try { p = src.load(query, ctl.signal); } catch { p = Promise.reject(new Error("source failed")); }
    p.then((v) => { finish(v === null || v === undefined ? [] : v); }, () => { finish(null); });
  }
}
