// Rate-limited text for the polite live region: the first message goes out at once, later ones at most once per interval
// (only the latest is kept), so a screen reader hears "12 new entries" now and then, never one line per row.
export type Announcer = { say(text: string): void; stop(): void };
type Opts = { intervalMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (id: unknown) => void };

export function createAnnouncer(set: (text: string) => void, opts: Opts = {}): Announcer {
  const interval = opts.intervalMs ?? 5000;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => { clearTimeout(id as ReturnType<typeof setTimeout>); });
  let last = Number.NEGATIVE_INFINITY, pending: string | null = null, timer: unknown = null, lastText = "";
  const emit = (text: string): void => { last = now(); lastText = text; set(text); };
  return {
    say(text) {
      if (timer === null && text === lastText) return;
      const wait = last + interval - now();
      if (wait <= 0 && timer === null) { emit(text); return; }
      pending = text;
      timer ??= setTimer(() => { timer = null; const p = pending; pending = null; if (p !== null && p !== lastText) emit(p); }, Math.max(0, wait));
    },
    stop() { if (timer !== null) clearTimer(timer); timer = null; pending = null; },
  };
}
