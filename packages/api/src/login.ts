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
  /** The tail of the attempts in flight per name: see `check`. Entries leave the map when their chain is idle. */
  readonly #inFlight = new Map<string, Promise<unknown>>();
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

  /** One attempt at a time per name: the lock is read before the (slow) verification and written after it, so attempts
   *  that overlapped would all be checked against the same, still unlocked counter and `maxFailures` could be outrun by
   *  concurrency. Different names do not wait for each other. */
  check(username: unknown, password: unknown): Promise<PasswordResult> {
    if (typeof username !== "string" || typeof password !== "string" || username.length === 0 || username.length > 128) return Promise.resolve({ ok: false, locked: false });
    const key = this.#key(username);
    const run = (this.#inFlight.get(key) ?? Promise.resolve()).then(() => this.#attempt(key, username, password));
    const tail = run.then(() => undefined, () => undefined);
    this.#inFlight.set(key, tail);
    void tail.then(() => { if (this.#inFlight.get(key) === tail) this.#inFlight.delete(key); });
    return run;
  }

  async #attempt(key: string, username: string, password: string): Promise<PasswordResult> {
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
