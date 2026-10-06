import type { Clock } from "../../src/auth/clock.ts";

/** A clock the test moves by hand; no real timers anywhere in the auth tests. */
export class FakeClock implements Clock {
  #t: number;
  constructor(start = 1_000_000_000_000) { this.#t = start; }
  now(): number { return this.#t; }
  advance(ms: number): void { this.#t += ms; }
}

/** Invented tokens: every test secret carries a marker so a leak is greppable. */
export const MARK = { access: "CANARY-ACCESS-7f3a", refresh: "CANARY-REFRESH-9c1d", key: "CANARY-APIKEY-2b8e" };
