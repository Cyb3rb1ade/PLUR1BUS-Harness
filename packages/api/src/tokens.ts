import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock.ts";
import { ApiError, errors } from "./errors.ts";
import type { TokenRecord, TokenStore } from "./ports.ts";
import { POLICY, policyFor } from "./rbac-bridge.ts";

export const TOKEN_PREFIX = "plb_";
const SHAPE = /^plb_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const SCOPE_SHAPE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*(\.\*)?$/;
const DAY = 86_400_000;
export const DEFAULT_TTL_MS = 90 * DAY; export const MAX_TTL_MS = 365 * DAY; export const MIN_TTL_MS = 3_600_000;
export const MAX_TOKENS_PER_USER = 50; export const MAX_SCOPES = 20;
/** `lastUsedAt` is written at most this often per token, so a busy script does not turn every request into a store write. */
const TOUCH_EVERY_MS = 60_000;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function parseToken(t: unknown): { id: string; secret: string } | undefined {
  if (typeof t !== "string" || t.length > 80) return undefined;
  const m = SHAPE.exec(t);
  return m ? { id: m[1]!, secret: m[2]! } : undefined;
}

const scopeError = (message: string) => errors.badRequest("scope", message);

/** Scopes can only *narrow* (ADR-007): each is an RBAC action that exists, or `prefix.*` matching at least one. What the
 *  role cannot do stays impossible whatever the scopes say, because `authorize` intersects role and scopes on every use. */
export function validateScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > MAX_SCOPES) throw scopeError(`scopes must be a list of 1 to ${MAX_SCOPES} RBAC actions`);
  const out = new Set<string>();
  for (const s of scopes) {
    if (typeof s !== "string" || s.length > 64 || !SCOPE_SHAPE.test(s)) throw scopeError("a scope is an RBAC action name or `prefix.*`");
    if (s.endsWith(".*")) { const p = s.slice(0, -1); if (!POLICY.some((a) => a.action.startsWith(p))) throw scopeError("no RBAC action matches that scope"); }
    else if (!policyFor(s)) throw scopeError("no such RBAC action");
    out.add(s);
  }
  return [...out];
}

/** What a list or a creation answer shows: never the hash, never the secret. */
export interface PublicToken { id: string; prefix: string; name: string; scopes: readonly string[]; createdAt: number; expiresAt: number; lastUsedAt?: number; revokedAt?: number }
const publicView = (r: TokenRecord): PublicToken => ({
  id: r.id, prefix: `${TOKEN_PREFIX}${r.id}`, name: r.name, scopes: r.scopes, createdAt: r.createdAt, expiresAt: r.expiresAt,
  ...(r.lastUsedAt !== undefined ? { lastUsedAt: r.lastUsedAt } : {}), ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
});

export type TokenAuth =
  | { ok: true; record: TokenRecord }
  /** `id` only when the token is real (revoked, expired): never echoed for a guess. */
  | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired"; id?: string };

export interface TokenServiceOptions { store: TokenStore; clock: Clock }

export class TokenService {
  readonly #store: TokenStore; readonly #clock: Clock;
  readonly #dummy = sha256("no such token");
  constructor(o: TokenServiceOptions) { this.#store = o.store; this.#clock = o.clock; }

  /** Makes a token for `userId`. The returned `token` is the only time the full string exists. */
  async create(userId: string, o: { name: unknown; scopes: unknown; ttlMs?: unknown }): Promise<{ token: string; record: PublicToken }> {
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (name.length < 1 || name.length > 64) throw errors.badRequest("name", "a token needs a name of 1 to 64 characters");
    const scopes = validateScopes(o.scopes);
    const ttl = o.ttlMs === undefined ? DEFAULT_TTL_MS : o.ttlMs;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) throw errors.badRequest("ttl", "the lifetime must be between 1 hour and 365 days");
    const now = this.#clock.now();
    const live = (await this.#store.listByUser(userId)).filter((t) => t.revokedAt === undefined && t.expiresAt > now).length;
    if (live >= MAX_TOKENS_PER_USER) throw new ApiError(409, "E_CONFLICT", "too many tokens", { reason: "token-limit" });
    const id = randomBytes(6).toString("hex"); const secret = randomBytes(32).toString("base64url");
    const rec: TokenRecord = { id, userId, name, scopes, hash: sha256(secret).toString("hex"), createdAt: now, expiresAt: now + ttl };
    await this.#store.put(rec);
    return { token: `${TOKEN_PREFIX}${id}_${secret}`, record: publicView(rec) };
  }

  /** The record behind a presented token string. A wrong secret under a real id and an id that does not exist both
   *  answer `unknown`, and both cost one hash comparison. */
  async authenticate(presented: unknown): Promise<TokenAuth> {
    const p = parseToken(presented);
    if (!p) return { ok: false, reason: "malformed" };
    const rec = await this.#store.get(p.id);
    const want = rec ? Buffer.from(rec.hash, "hex") : this.#dummy;
    const match = want.length === 32 && timingSafeEqual(sha256(p.secret), want);
    if (!rec || !match) return { ok: false, reason: "unknown" };
    const now = this.#clock.now();
    if (rec.revokedAt !== undefined) return { ok: false, reason: "revoked", id: rec.id };
    if (rec.expiresAt <= now) return { ok: false, reason: "expired", id: rec.id };
    if (rec.lastUsedAt === undefined || now - rec.lastUsedAt >= TOUCH_EVERY_MS) { try { await this.#store.update(rec.id, { lastUsedAt: now }); } catch { /* a missed timestamp never fails the call */ } }
    return { ok: true, record: rec };
  }

  async list(userId: string): Promise<PublicToken[]> { return (await this.#store.listByUser(userId)).map(publicView); }

  /** Revokes one of the caller's own tokens; false when it is unknown, someone else's or already revoked. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const rec = typeof id === "string" ? await this.#store.get(id) : undefined;
    if (!rec || rec.userId !== userId || rec.revokedAt !== undefined) return false;
    await this.#store.update(id, { revokedAt: this.#clock.now() });
    return true;
  }
}
