import type { CallerIdentity } from "@plur1bus/rpc-schema";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { IdentityError, type Actor, type ChannelIdentity, type IdentityService } from "./service.ts";

export const IDENTITY_METHODS = ["identity.list", "identity.human.create", "identity.link", "identity.pair.start", "identity.pair.claim", "identity.pair.confirm", "identity.unlink"] as const;

/**
 * Owner only. Until the M3 RBAC `authorize()` chokepoint exists the only principal is the local owner: the CLI caller
 * the schema already requires (`CallerIdentity.channel` is `cli`), who holds the core's token. Anything else is refused
 * here as well, so a future widening of `CallerIdentity` cannot silently open these methods.
 */
// RULING: "owner/admin only" is the local cli caller until the M3 RBAC `authorize()` chokepoint exists (ADR-007).
function owner(caller: CallerIdentity): Actor {
  if (caller?.channel !== "cli") throw new RpcError("E_DENIED", "identity management is owner only", { reason: "owner-only" });
  return { user: caller.userId, host: caller.accountId };
}

/** The service's failures as the closed RPC codes; `reason` carries the service code. */
export function mapIdentityError(e: unknown): never {
  if (!(e instanceof IdentityError)) throw e;
  switch (e.code) {
    case "invalid-params": throw new RpcError("E_INVALID_PARAMS", e.message, { ...(e.field !== undefined ? { detail: e.field } : {}) });
    case "not-found": throw new RpcError("E_NOT_FOUND", e.message);
    case "conflict": throw new RpcError("E_CONFLICT", e.message);
    case "limit": throw new RpcError("E_CONFLICT", e.message, { reason: "limit" });
    case "invalid-code": throw new RpcError("E_DENIED", e.message, { reason: "invalid-code" });
    case "expired": throw new RpcError("E_DENIED", e.message, { reason: "expired" });
    case "rate-limited": throw new RpcError("E_DENIED", e.message, { reason: "rate-limited", detail: `retryAfterMs=${e.retryAfterMs ?? 0}` });
    case "storage": throw new RpcError("E_STORAGE", e.message, { reason: "identity-store" });
  }
}

export function buildIdentityMethods(d: { service: IdentityService; isStopping?: () => boolean }): Record<string, Handler> {
  const guard = <P extends { caller: CallerIdentity }, R>(fn: (p: P, actor: Actor) => R): Handler => async (p: P) => {
    if (d.isStopping?.()) throw new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });
    const actor = owner(p.caller);
    try { return fn(p, actor); } catch (e) { return mapIdentityError(e); }
  };
  const s = d.service;
  return {
    "identity.list": guard((p: { caller: CallerIdentity; includeRevoked?: boolean }) => s.list({ ...(p.includeRevoked !== undefined ? { includeRevoked: p.includeRevoked } : {}) })),
    "identity.human.create": guard((p: { caller: CallerIdentity; displayName: string }, a) => s.createHuman({ displayName: p.displayName }, a)),
    "identity.link": guard((p: { caller: CallerIdentity; humanId: string; identity: ChannelIdentity }, a) => s.link({ humanId: p.humanId, identity: p.identity }, a)),
    "identity.pair.start": guard((p: { caller: CallerIdentity; humanId: string; channel: string }, a) => s.startPairing({ humanId: p.humanId, channel: p.channel }, a)),
    "identity.pair.claim": guard((p: { caller: CallerIdentity; code: string; identity: ChannelIdentity }) => s.claim({ code: p.code, identity: p.identity })),
    "identity.pair.confirm": guard((p: { caller: CallerIdentity; pairingId: string; approve: boolean }, a) => s.confirm({ pairingId: p.pairingId, approve: p.approve }, a)),
    "identity.unlink": guard((p: { caller: CallerIdentity; linkId: string }, a) => s.unlink({ linkId: p.linkId }, a)),
  };
}
