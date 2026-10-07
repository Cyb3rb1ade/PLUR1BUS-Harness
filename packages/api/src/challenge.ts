import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "./clock.ts";

export interface ChallengeLimits { ttlMs: number; maxAttempts: number; maxChallenges: number }
export const DEFAULT_CHALLENGE_LIMITS: ChallengeLimits = { ttlMs: 5 * 60_000, maxAttempts: 5, maxChallenges: 256 };

interface Entry { userId: string; version: number; expiresAt: number; attempts: number }
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The half-finished login between a right password and a right second factor. It is not a session: it grants nothing,
 *  works once, expires in minutes, dies after a few wrong codes, and is bound to the user's record version (a changed
 *  password or role ends it). Held by the SHA-256 of its value, like sessions. */
export class LoginChallenges {
  readonly #clock: Clock; readonly #limits: ChallengeLimits;
  readonly #byId = new Map<string, Entry>();
  constructor(clock: Clock, limits: ChallengeLimits = DEFAULT_CHALLENGE_LIMITS) { this.#clock = clock; this.#limits = limits; }

  create(userId: string, version: number): { id: string; expiresAt: number } {
    const now = this.#clock.now();
    for (const [h, e] of this.#byId) if (e.expiresAt <= now) this.#byId.delete(h);
    while (this.#byId.size >= this.#limits.maxChallenges) { const first = this.#byId.keys().next(); if (first.done) break; this.#byId.delete(first.value); }
    const id = randomBytes(32).toString("base64url"); const expiresAt = now + this.#limits.ttlMs;
    this.#byId.set(sha256(id), { userId, version, expiresAt, attempts: 0 });
    return { id, expiresAt };
  }

  get(id: unknown): { userId: string; version: number } | undefined {
    if (typeof id !== "string" || id.length > 100) return undefined;
    const h = sha256(id); const e = this.#byId.get(h);
    if (!e) return undefined;
    if (e.expiresAt <= this.#clock.now()) { this.#byId.delete(h); return undefined; }
    return { userId: e.userId, version: e.version };
  }

  /** A wrong code: counts, and the challenge ends at the limit. */
  fail(id: string): void {
    const h = sha256(id); const e = this.#byId.get(h);
    if (!e) return;
    e.attempts += 1;
    if (e.attempts >= this.#limits.maxAttempts) this.#byId.delete(h);
  }

  /** Spends the challenge: true once. */
  consume(id: string): boolean { return this.#byId.delete(sha256(id)); }

  get size(): number { return this.#byId.size; }
}
