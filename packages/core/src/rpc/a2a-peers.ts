import { randomUUID } from "node:crypto";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { SurfaceTrust } from "../policy/index.ts";
import type { A2aPeerClient } from "../a2a/peer-client.ts";
import { A2aPeerError } from "../a2a/peer-error.ts";
import { RpcError } from "./errors.ts";
import type { CallContext, Handler } from "./server.ts";

export function a2aPeerMethods(service: () => A2aPeerClient | null, surfaceOf?: (p: Principal, ctx: CallContext) => SurfaceTrust): Record<string, Handler> {
  const bind = (run: (s: A2aPeerClient, p: any, who: Principal, ctx: CallContext) => unknown): Handler => async (p, ctx) => {
    const who = authenticatedPrincipal(ctx);
    const client = service();
    if (!client) throw new RpcError("E_NOT_AVAILABLE", "A2A client is unavailable", { reason: "unavailable" });
    try { return await run(client, p, who, ctx); }
    catch (e) {
      if (!(e instanceof A2aPeerError)) throw new RpcError("E_NOT_AVAILABLE", "A2A client is unavailable", { reason: "unavailable" });
      const code = e.code === "denied" || e.code === "egress-denied" || e.code === "local-only" ? "E_DENIED"
        : e.code === "approval-required" ? "E_APPROVAL_REQUIRED" : e.code === "peer-not-found" ? "E_NOT_FOUND"
        : e.code === "invalid-peer" || e.code === "invalid-key" ? "E_INVALID_PARAMS"
        : e.code === "peer-exists" || e.code === "peer-revoked" || e.code === "peer-untrusted" ? "E_CONFLICT" : "E_NOT_AVAILABLE";
      throw new RpcError(code, e.message, { reason: e.code });
    }
  };
  return {
    "a2a.peer.add": bind((s, p, who) => s.add(who, p)),
    "a2a.peer.list": bind((s, _p, who) => ({ peers: s.list(who) })),
    "a2a.peer.remove": bind((s, p, who) => ({ id: p.id, removed: s.remove(who, p.id) })),
    "a2a.peer.trust": bind((s, p, who, ctx) => {
      const turn = `a2a-trust:${randomUUID()}`;
      return s.trust(who, p, { person: who.userId, agent: "a2a-owner", session: ctx.connectionId, turn, project: "a2a-peers", surface: surfaceOf?.(who, ctx) ?? 0, policy: {} }, ctx.signal);
    }),
  };
}
