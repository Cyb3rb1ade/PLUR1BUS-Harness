import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "./clock.ts";
import { normalizeUsername } from "./memory-stores.ts";
import { hashPassword, needsRehash, verifyPassword } from "./password.ts";
import type { UserDirectory, UserRecord } from "./ports.ts";

export interface LockoutPolicy {
  /** Failures (per account name, known or not) before the first lock. */
  maxFailures: number; baseDelayMs: number; maxDelayMs: number;
  /** Bound on remembered names; the oldest is dropped, so a flood of random names cannot grow memory. */
  maxKeys: number;
}
export const DEFAULT_LOCKOUT: LockoutPolicy = { maxFailures: 5, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000, maxKeys: 10_000 };

export type PasswordResult =
  | { ok: true; user: UserRecord; rehashed: boolean }
  /** One failure shape for an unknown name, a wrong password, a disabled or password-less account: no enumeration. */
  | { ok: false; locked: boolean; retryAfterSec?: number };

export interface PasswordLoginOptions {
  users: UserDirectory; clock: Clock; policy?: Partial<LockoutPolicy>;
  /** Test seams. */
  verify?: typeof verifyPassword; hash?: typeof hashPassword;
}

interface Attempt { failures: number; lockedUntil: number }

/** Password check with constant work for unknown names (a dummy Argon2id verification), and a lock that backs off
 *  exponentially per account *name*. The lock applies to names that do not exist as well, so it reveals nothing. */
export class PasswordLogin {
  readonly #users: UserDirectory; readonly #clock: Clock; readonly #p: LockoutPolicy;
  readonly #verify: typeof verifyPassword; readonly #hash: typeof hashPassword;
  readonly #attempts = new Map<string, Attempt>();
  #dummy: Promise<string> | undefined;
  constructor(o: PasswordLoginOptions) {
    this.#users = o.users; this.#clock = o.clock; this.#p = { ...DEFAULT_LOCKOUT, ...o.policy };
    this.#verify = o.verify ?? verifyPassword; this.#hash = o.hash ?? hashPassword;
  }

  #key(username: string): string { return createHash("sha256").update(normalizeUsername(username)).digest("hex"); }
  #dummyHash(): Promise<string> { return (this.#dummy ??= this.#hash(randomBytes(24).toString("base64url"))); }

  get trackedNames(): number { return this.#attempts.size; }

  /** Seconds the name stays locked, or 0. */
  lockedFor(username: string): number {
    const a = this.#attempts.get(this.#key(username)); const now = this.#clock.now();
    return a && a.lockedUntil > now ? Math.ceil((a.lockedUntil - now) / 1000) : 0;
  }

  async check(username: unknown, password: unknown): Promise<PasswordResult> {
    if (typeof username !== "string" || typeof password !== "string" || username.length === 0 || username.length > 128) return { ok: false, locked: false };
    const key = this.#key(username);
    const wait = this.lockedFor(username);
    if (wait > 0) return { ok: false, locked: true, retryAfterSec: wait };

    const user = await this.#users.findByUsername(username);
    const usable = user !== undefined && user.disabled !== true && user.passwordHash !== undefined;
    // Always one verification, against the real hash or a dummy, so the response time does not tell the cases apart.
    const good = await this.#verify(usable ? user.passwordHash! : await this.#dummyHash(), password);
    if (!usable || !good) { this.#fail(key); return { ok: false, locked: false }; }

    this.#attempts.delete(key);
    let rehashed = false;
    if (needsRehash(user.passwordHash!)) {
      try { await this.#users.updatePasswordHash(user.id, await this.#hash(password)); rehashed = true; } catch { /* the login stands, the next one retries */ }
    }
    return { ok: true, user: (await this.#users.findById(user.id)) ?? user, rehashed };
  }

  #fail(key: string): void {
    const now = this.#clock.now();
    const a = this.#attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
    a.failures += 1;
    if (a.failures >= this.#p.maxFailures) a.lockedUntil = now + Math.min(this.#p.maxDelayMs, this.#p.baseDelayMs * 2 ** (a.failures - this.#p.maxFailures));
    this.#attempts.delete(key); this.#attempts.set(key, a);
    while (this.#attempts.size > this.#p.maxKeys) { const first = this.#attempts.keys().next(); if (first.done) break; this.#attempts.delete(first.value); }
  }
}
