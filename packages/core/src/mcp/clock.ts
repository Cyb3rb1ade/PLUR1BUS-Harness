// An injectable clock so idle shutdown and call deadlines are testable without sleeping (ADR-014 §2).
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};
