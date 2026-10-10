// Break-glass (ADR-007 §Privacy, milestones M3 acceptance 4): the only way Owner/Admin read another user's
// `user`-scope cards. Mandatory reason, time-boxed, audited (grant, every use, expiry, revocation), the affected user
// is notified, read only. `authorize` itself stays pure: this registry mints the grants and hands them to it.
import { randomUUID } from "node:crypto";
import { authorize } from "./authorize.ts";
import type { AuditSink } from "./audit.ts";
import type { BreakGlassGrant, Decision, Principal, Resource } from "./types.ts";

export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 500;
export const DEFAULT_TTL_MS = 15 * 60_000;
export const MIN_TTL_MS = 60_000;
export const MAX_TTL_MS = 60 * 60_000;

export interface BreakGlassNotice {
  kind: "granted";
  /** The affected user: the one whose cards may now be read. */
  userId: string;
  grantId: string;
  holderUserId: string;
  reason: string;
  expiresAt: number;
}

export type BreakGlassErrorCode = "not-permitted" | "invalid-target" | "self-target" | "reason-required" | "ttl-invalid" | "audit-failed" | "unknown-grant" | "notification-failed";
export class BreakGlassError extends Error {
  readonly code: BreakGlassErrorCode;
  constructor(code: BreakGlassErrorCode, message: string) { super(message); this.name = "BreakGlassError"; this.code = code; }
}

export interface BreakGlassOptions {
  audit: AuditSink;
  /** Tells the affected user at once (ADR-007 Q3, recommended default). Required: a grant nobody hears of is not allowed. */
  notify: (notice: BreakGlassNotice) => void;
  requireNotification?: boolean;
  clock: () => number;
  idGen?: () => string;
  /** The `actor.host` of audit lines. */
  host?: string;
}

export interface BreakGlassRequest { targetUserId: string; reason: string; ttlMs?: number }

export interface BreakGlass {
  request(holder: Principal, req: BreakGlassRequest): BreakGlassGrant;
  revoke(actor: Principal, grantId: string): void;
  /** Writes one `break-glass.expired` event per lapsed grant; returns how many it wrote. Safe to call from a timer. */
  sweep(): number;
  /** The holder's live grants. */
  active(holderUserId: string): BreakGlassGrant[];
  /** `authorize` with the registry's own live grants for this principal (any grants on the principal are ignored). */
  authorize(principal: Principal | null | undefined, action: string, resource: Resource): Decision;
}

export function createBreakGlass(o: BreakGlassOptions): BreakGlass {
  const host = o.host ?? "local";
  const id = o.idGen ?? randomUUID;
  const grants = new Map<string, BreakGlassGrant>();

  const record = (action: string, actor: string, target: string, detail: Record<string, unknown>): void =>
    o.audit.append({ at: o.clock(), actor: { user: actor, host }, action, target, detail });

  function sweep(): number {
    const now = o.clock();
    let n = 0;
    for (const g of [...grants.values()]) {
      if (g.expiresAt > now) continue;
      try { record("break-glass.expired", "system", g.targetUserId, { grantId: g.id, holderUserId: g.holderUserId, expiresAt: g.expiresAt }); }
      catch { continue; } // keep it: the next sweep retries, and until then the lapsed grant is already unusable
      grants.delete(g.id);
      n++;
    }
    return n;
  }

  const live = (holderUserId: string): BreakGlassGrant[] => {
    const now = o.clock();
    return [...grants.values()].filter((g) => g.holderUserId === holderUserId && g.expiresAt > now);
  };

  return {
    sweep,
    active: (holderUserId) => { sweep(); return live(holderUserId); },

    request(holder, req) {
      const targetUserId = typeof req?.targetUserId === "string" ? req.targetUserId : "";
      if (targetUserId === "") throw new BreakGlassError("invalid-target", "a target user is required");
      // Who may ask is the policy's call (breakglass.request: Owner/Admin, narrowed by token scopes), not this file's.
      if (authorize(holder, "breakglass.request", { kind: "user", userId: targetUserId }, { now: o.clock() }).effect !== "allow") {
        throw new BreakGlassError("not-permitted", "break-glass is not permitted for this principal");
      }
      if (targetUserId === holder.userId) throw new BreakGlassError("self-target", "break-glass on one's own cards is meaningless");
      const reason = typeof req.reason === "string" ? req.reason.trim() : "";
      if (reason.length < MIN_REASON_CHARS || reason.length > MAX_REASON_CHARS) {
        throw new BreakGlassError("reason-required", `a reason of ${MIN_REASON_CHARS}-${MAX_REASON_CHARS} characters is required`);
      }
      const ttlMs = req.ttlMs ?? DEFAULT_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
        throw new BreakGlassError("ttl-invalid", `ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
      }
      sweep();
      const issuedAt = o.clock();
      const grant: BreakGlassGrant = Object.freeze({ id: id(), holderUserId: holder.userId, targetUserId, reason, issuedAt, expiresAt: issuedAt + ttlMs });
      try { record("break-glass.granted", holder.userId, targetUserId, { grantId: grant.id, reason, issuedAt, expiresAt: grant.expiresAt, ttlMs }); }
      catch { throw new BreakGlassError("audit-failed", "the grant could not be audited, so it was not made"); }
      grants.set(grant.id, grant);
      try { o.notify({ kind: "granted", userId: targetUserId, grantId: grant.id, holderUserId: holder.userId, reason, expiresAt: grant.expiresAt }); }
      catch (e) {
        if (o.requireNotification) grants.delete(grant.id);
        try { record("break-glass.notify-failed", holder.userId, targetUserId, { grantId: grant.id, error: e instanceof Error ? e.message : String(e) }); } catch { /* the grant is already audited */ }
        if (o.requireNotification) throw new BreakGlassError("notification-failed", "no grant without a durable notice");
      }
      return grant;
    },

    revoke(actor, grantId) {
      const g = grants.get(grantId);
      if (!g) throw new BreakGlassError("unknown-grant", "no such live grant");
      if (actor?.userId !== g.holderUserId && actor?.role !== "owner") throw new BreakGlassError("not-permitted", "only the holder or an Owner may revoke");
      try { record("break-glass.revoked", actor.userId, g.targetUserId, { grantId: g.id, holderUserId: g.holderUserId }); }
      catch { throw new BreakGlassError("audit-failed", "the revocation could not be audited"); }
      grants.delete(g.id);
    },

    authorize(principal, action, resource) {
      sweep();
      const now = o.clock();
      const withGrants: Principal | null | undefined =
        principal && typeof principal === "object" ? { ...principal, breakGlass: live(principal.userId) } : principal;
      const d = authorize(withGrants, action, resource, { now });
      if (d.effect !== "allow" || d.reason !== "break-glass") return d;
      const target = resource.kind === "memory" && resource.scope === "user" ? resource.ownerUserId : "";
      try { record("break-glass.used", principal!.userId, target, { grantId: d.breakGlassId, action }); }
      catch { return { effect: "deny", reason: "audit-failed" }; }
      return d;
    },
  };
}
