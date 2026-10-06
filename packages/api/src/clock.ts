export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

/** A clock a test advances by hand. */
export class FakeClock implements Clock {
  #t: number;
  constructor(start = 1_700_000_000_000) { this.#t = start; }
  now(): number { return this.#t; }
  advance(ms: number): void { this.#t += ms; }
}
