import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock.ts";

export type Role = "owner";
/** The one principal until the users store (ADR-007) lands (ruling R1). */
export interface Principal { kind: "owner"; id: string; role: Role }
export const OWNER: Principal = Object.freeze({ kind: "owner", id: "owner", role: "owner" });

export interface Session { readonly principal: Principal; readonly createdAt: number; absoluteExpiresAt: number; idleExpiresAt: number }

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
  create(principal: Principal): { id: string; session: Session } {
    const now = this.#clock.now();
    this.#sweep(now);
    while (this.#byId.size >= this.#limits.maxSessions) { const first = this.#byId.keys().next(); if (first.done) break; this.#byId.delete(first.value); }
    const id = newSecret();
    const e: Entry = { principal, createdAt: now, absoluteExpiresAt: now + this.#limits.absoluteMs, idleExpiresAt: now + this.#limits.idleMs, csrf: new Map() };
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
