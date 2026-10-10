// Existing memory read methods gain an optional break-glass target; all reads still go through the engine's own ACL.
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { Handler } from "./server.ts";
import { authenticatedPrincipal, LOCAL_OWNER } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { BreakGlass } from "../rbac/break-glass.ts";
import type { IdentityService } from "../identity/service.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { callerToPrincipal } from "../principal.ts";
import { projectCard, mapMemoryOpError } from "../memory-ops.ts";
import { RpcError } from "./errors.ts";
export function breakglassMemory(d: { methods: Record<string, Handler>; engine: Engine; identity: IdentityService; breakglass: BreakGlass; workspace: (id: string) => string | undefined }): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const method of ["memory.list", "memory.show"]) {
    const inner = d.methods[method]; if (!inner) continue;
    out[method] = async (p, ctx) => {
      const a = authenticatedPrincipal(ctx);
      if (authorize(a, "agent.read", { kind: "agent", agentId: p.agentId }).effect !== "allow") throw new RpcError("E_DENIED", "agent rights required");
      if (!p.targetUserId) {
        // Legacy local owner calls preserve their engine caller hash. Other people may present only their own active link.
        if (a.userId !== LOCAL_OWNER.userId && d.identity.resolve(p.caller)?.humanId !== a.userId) throw new RpcError("E_DENIED", "caller identity must be linked to the authenticated person", { reason: "caller-not-linked" });
        const result = await inner(p,ctx) as { items?: { scope: string }[]; card?: { scope: string }; [key: string]: unknown };
        const visible = (card: { scope: string }) => authorize(a, card.scope === "user" ? "memory.user.read" : card.scope === "agent-private" ? "memory.agent-private.read" : "memory.workspace.read", card.scope === "user" ? { kind: "memory", scope: "user", ownerUserId: a.userId } : { kind: "memory", scope: card.scope === "agent-private" ? "agent-private" : "workspace", agentId: p.agentId }).effect === "allow";
        if (result.items) return { ...result, items: result.items.filter(visible) };
        if (result.card && !visible(result.card)) throw new RpcError("E_NOT_FOUND", "card not found");
        return result;
      }
      if (typeof p.targetUserId !== "string" || !d.identity.list({}).humans.some(h => h.id === p.targetUserId)) throw new RpcError("E_NOT_FOUND", "person not found");
      if (d.breakglass.authorize(a, "memory.user.read", { kind: "memory", scope: "user", ownerUserId: p.targetUserId }).effect !== "allow") throw new RpcError("E_DENIED", "live read-only break-glass grant required");
      const workspace = d.workspace(p.agentId); if (!workspace) throw new RpcError("E_NOT_FOUND", "agent not found");
      const principal = callerToPrincipal({ channel: "cli", accountId: "breakglass", userId: a.userId }, p.agentId, workspace).principal;
      principal.user = deriveUserPrincipal(p.targetUserId);
      try {
        if (method === "memory.show") {
          const card = await d.engine.memory.show(p.id, principal, { origin: "user", background: false });
          if (card.scope !== "user") throw new RpcError("E_DENIED", "break-glass reads user data only");
          return { card: projectCard(card) };
        }
        if ((p.topic !== undefined) === (p.since !== undefined) || (p.until !== undefined && p.since === undefined)) throw new RpcError("E_INVALID_PARAMS", "exactly one of topic and since is required", { reason: "topic-xor-since" });
        const r = await d.engine.memory.list({ ...(p.topic !== undefined ? { topic: p.topic } : { since: p.since }), ...(p.until !== undefined ? { until: p.until } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }, principal, { origin: "user", background: false });
        return { agentId: r.agentId, items: r.items.filter(c => c.scope === "user").map(projectCard), truncated: r.truncated };
      } catch (e) { throw mapMemoryOpError(e, { stopping: false }) ?? e; }
    };
  }
  return out;
}
