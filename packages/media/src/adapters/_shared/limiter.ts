import { MediaError } from '../../types.ts';
/** Bounded concurrency for one adapter (`maxConcurrent`). Waiting callers can be cancelled; slots are always released. */
export class Limiter {
  readonly max: number; private active = 0; private readonly waiters: (() => void)[] = [];
  constructor(max: number) { if (!Number.isInteger(max) || max < 1 || max > 64) throw new MediaError('unsupported_parameter'); this.max = max; }
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new MediaError('cancelled'));
    if (this.active < this.max) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { const at = this.waiters.indexOf(grant); if (at >= 0) this.waiters.splice(at, 1); reject(new MediaError('cancelled')); };
      this.waiters.push(grant); signal.addEventListener('abort', cancel, { once: true });
    });
  }
  private release(): void { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  async run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try { return await fn(); } finally { this.release(); }
  }
}
