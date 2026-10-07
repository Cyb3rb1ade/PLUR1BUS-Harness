import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { Role } from "./rbac-bridge.ts";

export type { Role };
/** Who a session belongs to. `owner` is the installation owner who logged in with the owner token (bootstrap, ruling R1);
 *  `user` is a local account that logged in with a password. Rights are never stored here: they are read from the user
 *  directory on every request, so a demotion takes effect at once. */
export interface Principal { kind: "owner" | "user"; id: string; role: Role }
export const OWNER: Principal = Object.freeze({ kind: "owner", id: "owner", role: "owner" });

export interface Session {
  readonly principal: Principal; readonly createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number;
  /** The user record's `version` when the session was made; a different one means rights changed since. */
  readonly authVersion: number;
  /** Set when rights changed: the next request gets a new cookie and the old value stops working. */
  mustRotate: boolean;
  /** Epoch ms of the last second-factor check (the T3 step-up window of ADR-007); undefined when none happened. */
  stepUpAt?: number;
}

export interface SessionLimits { idleMs: number; absoluteMs: number; maxSessions: number; csrfTtlMs: number; maxCsrfPerSession: number }
export const DEFAULT_SESSION_LIMITS: SessionLimits = { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000, maxSessions: 64, csrfTtlMs: 10 * 60_000, maxCsrfPerSession: 16 };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");

interface Entry extends Session { csrf: Map<string, number> }

/** Sessions held in memory, keyed by the SHA-256 of the cookie value, so neither a heap snapshot of the map nor a log of
 *  its keys yields a usable cookie. Idle and absolute expiry run on the injected clock. */
export class SessionStore {
  readonly #clock: Clock; readonly #limits: SessionLimits;
  readonly #byId = new Map<string, Entry>();
  constructor(clock: Clock, limits: SessionLimits = DEFAULT_SESSION_LIMITS) { this.#clock = clock; this.#limits = limits; }

  /** A new session; `id` is the cookie value and exists nowhere else. */
  create(principal: Principal, o: { authVersion?: number; stepUpAt?: number } = {}): { id: string; session: Session } {
    const now = this.#clock.now();
    this.#sweep(now);
    while (this.#byId.size >= this.#limits.maxSessions) { const first = this.#byId.keys().next(); if (first.done) break; this.#byId.delete(first.value); }
    const id = newSecret();
    const e: Entry = { principal, createdAt: now, absoluteExpiresAt: now + this.#limits.absoluteMs, idleExpiresAt: now + this.#limits.idleMs, authVersion: o.authVersion ?? 0, mustRotate: false, csrf: new Map(), ...(o.stepUpAt !== undefined ? { stepUpAt: o.stepUpAt } : {}) };
    this.#byId.set(sha256(id), e);
    return { id, session: e };
  }

  /** The live session for a cookie value, with its idle timer pushed out; `undefined` when unknown or expired. */
  get(id: string | undefined): Session | undefined {
    const e = this.#entry(id);
    if (!e) return undefined;
    const now = this.#clock.now();
    e.idleExpiresAt = Math.min(now + this.#limits.idleMs, e.absoluteExpiresAt);
    return e;
  }

  destroy(id: string | undefined): boolean { return id !== undefined && this.#byId.delete(sha256(id)); }

  /** "Log out everywhere": every session of one principal ends. Returns how many. */
  destroyAllFor(principalId: string): number {
    let n = 0;
    for (const [h, e] of this.#byId) if (e.principal.id === principalId) { this.#byId.delete(h); n++; }
    return n;
  }

  /** Marks every session of the principal for rotation at its next request (rights changed). Returns how many. */
  markRotate(principalId: string): number {
    let n = 0;
    for (const e of this.#byId.values()) if (e.principal.id === principalId) { e.mustRotate = true; n++; }
    return n;
  }

  /** Swaps the cookie value of a live session: the old one dies, the lifetime is *not* extended, pending CSRF tokens go. */
  rotate(id: string | undefined): { id: string; session: Session } | undefined {
    const e = this.#entry(id);
    if (!e || id === undefined) return undefined;
    this.#byId.delete(sha256(id));
    const next = newSecret();
    e.csrf.clear(); e.mustRotate = false;
    this.#byId.set(sha256(next), e);
    return { id: next, session: e };
  }

  /** How many live sessions a principal has. */
  countFor(principalId: string): number {
    this.#sweep(this.#clock.now());
    let n = 0; for (const e of this.#byId.values()) if (e.principal.id === principalId) n++;
    return n;
  }

  /** A one-time CSRF token bound to this session (ruling R6). */
  issueCsrf(id: string): { token: string; expiresAt: number } | undefined {
    const e = this.#entry(id);
    if (!e) return undefined;
    const now = this.#clock.now();
    for (const [h, exp] of e.csrf) if (exp <= now) e.csrf.delete(h);
    while (e.csrf.size >= this.#limits.maxCsrfPerSession) { const first = e.csrf.keys().next(); if (first.done) break; e.csrf.delete(first.value); }
    const token = newSecret(); const expiresAt = now + this.#limits.csrfTtlMs;
    e.csrf.set(sha256(token), expiresAt);
    return { token, expiresAt };
  }

  /** Spends a CSRF token: true once, for the session it was issued to, before it expires. */
  consumeCsrf(id: string, token: string | undefined): boolean {
    const e = this.#entry(id);
    if (!e || !token) return false;
    const h = sha256(token); const exp = e.csrf.get(h);
    if (exp === undefined) return false;
    e.csrf.delete(h);
    return exp > this.#clock.now();
  }

  get size(): number { return this.#byId.size; }

  #entry(id: string | undefined): Entry | undefined {
    if (!id) return undefined;
    const h = sha256(id); const e = this.#byId.get(h);
    if (!e) return undefined;
    const now = this.#clock.now();
    if (e.idleExpiresAt <= now || e.absoluteExpiresAt <= now) { this.#byId.delete(h); return undefined; }
    return e;
  }

  #sweep(now: number): void { for (const [h, e] of this.#byId) if (e.idleExpiresAt <= now || e.absoluteExpiresAt <= now) this.#byId.delete(h); }
}

/** Constant-time check of a presented owner token against the real one (ruling R2). Both sides are hashed first so the
 *  comparison length never depends on the guess. */
export function ownerTokenVerifier(ownerToken: string): (candidate: unknown) => boolean {
  if (typeof ownerToken !== "string" || ownerToken.length < 32) throw new Error("the owner token must be a string of at least 32 characters");
  const want = createHash("sha256").update(ownerToken, "utf8").digest();
  return (candidate) => {
    if (typeof candidate !== "string" || candidate.length > 512) return false;
    return timingSafeEqual(createHash("sha256").update(candidate, "utf8").digest(), want);
  };
}

/** The `Cookie` header's value for `name`, or undefined. First occurrence wins; a duplicate is never merged. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
