import type { Handler, CallContext } from "./server.ts";
import { RpcError } from "./errors.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Actor, IdentityService } from "../identity/service.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { surfaceError } from "./surface-errors.ts";

export function buildIdentitySurface(
  service: () => IdentityService | null,
): Record<string, Handler> {
  const bind =
    (fn: (s: IdentityService, p: any, actor: Actor) => unknown): Handler =>
    async (p, ctx: CallContext) => {
      const principal = authenticatedPrincipal(ctx);
      const s = service();
      if (!s) throw new RpcError("E_NOT_AVAILABLE", "identity unavailable");
      const actor: Actor = {
        user: principal.userId,
        host: "rpc",
        role: principal.role,
        ...(principal.kind ? { kind: principal.kind } : {}),
        ...(principal.tokenScopes
          ? { tokenScopes: principal.tokenScopes }
          : {}),
      };
      try {
        return fn(s, p, actor);
      } catch (e) {
        return surfaceError(e);
      }
    };
  const target = (p: { humanId?: string }, a: Actor) => {
    const id = p.humanId ?? a.user;
    if (id !== a.user && !["owner", "admin"].includes(a.role ?? ""))
      throw new RpcError("E_DENIED", "self identities only");
    return id;
  };
  const confirm = (approve: boolean) =>
    bind((s, p, a) => {
      const pairing = s
        .list({})
        .pairings.find((pair) => pair.id === p.pairingId);
      if (!pairing) throw new RpcError("E_NOT_FOUND", "pairing not found");
      target({ humanId: pairing.humanId }, a);
      return s.confirm({ pairingId: p.pairingId, approve }, a);
    });
  return {
    "identity.link.request": bind((s, p, a) => {
      const result = s.startPairing(
        { humanId: target(p, a), channel: p.channel },
        a,
      );
      return {
        id: result.pairingId,
        code: result.code,
        expiresAt: result.expiresAt,
      };
    }),
    "identity.link.list": bind((s, p, a) => {
      const humanId = target(p, a);
      const list = s.list({});
      return {
        humanId,
        links: list.humans.find((h) => h.id === humanId)?.identities ?? [],
        pairings: list.pairings.filter((pair) => pair.humanId === humanId),
      };
    }),
    "identity.link.approve": confirm(true),
    "identity.link.decline": confirm(false),
    "identity.link.remove": bind((s, p, a) => {
      const link = s
        .list({})
        .humans.flatMap((h) => h.identities)
        .find((link) => link.id === p.linkId);
      if (!link) throw new RpcError("E_NOT_FOUND", "link not found");
      target({ humanId: link.humanId }, a);
      return s.unlink({ linkId: p.linkId }, a);
    }),
    "identity.principals": bind((s, p, a) => {
      const humanId = target(p, a);
      return {
        humanId,
        principals: s.resolvePrincipals(deriveUserPrincipal(humanId)),
      };
    }),
  };
}
