// A manual clock for idle and deadline tests: no sleeping, timers fire in order as `advance` moves time.
import type { Clock } from "../../../src/mcp/clock.ts";

interface Timer { id: number; at: number; fn: () => void }

export class FakeClock implements Clock {
  private t = 1_000_000;
  private next = 1;
  private timers = new Map<number, Timer>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = this.next++; this.timers.set(id, { id, at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown): void { this.timers.delete(h as number); }
  get pending(): number { return this.timers.size; }
  /** Moves time forward, firing due timers in order (including ones they schedule). Awaits a macrotask between
   *  firings so promise continuations triggered by a timer run before the next one. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.values()].filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers.delete(due.id); this.t = Math.max(this.t, due.at); due.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.t = target;
    await new Promise<void>((r) => setImmediate(r));
  }
}
