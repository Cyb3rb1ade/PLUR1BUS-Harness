// API callers never inherit the local-token compatibility paths of unguarded legacy methods.
import { RPC_RULES } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Handler } from "./server.ts";
import { RpcError } from "./errors.ts";
import { apiPrincipal } from "@plur1bus/module-api";

export function apiAdmission(methods: Record<string, Handler>, resolve: PrincipalResolver): Record<string, Handler> {
  return Object.fromEntries(Object.entries(methods).map(([method, inner]) => [method, async (params, ctx) => {
    if (method.startsWith("admin.api.") || (method === "user.invite.redeem" && apiPrincipal(ctx) === null) || apiPrincipal(ctx) === undefined || RPC_RULES[method] || method.startsWith("secret.")) return inner(params, ctx);
    const who = await resolve(ctx, method, params);
    if (!who) throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "no-principal" });
    if (method === "core.status") {
      if (authorize(who, "doctor.read", { kind: "system" }).effect !== "allow") throw new RpcError("E_DENIED", "diagnostics denied", { reason: "role-denied" });
      return inner(params, ctx);
    }
    if (method === "agent.list") {
      const result = await inner(params, ctx) as { agents: { agentId: string }[] };
      return { ...result, agents: result.agents.filter(a => authorize(who, "agent.read", { kind: "agent", agentId: a.agentId }).effect === "allow") };
    }
    // These methods have no guard yet. Until their owning packages secure them, their web compatibility path is
    // restricted to the actual stored installation owner. Existing local clients keep their current behaviour.
    if (who.kind !== "person" || who.role !== "owner") throw new RpcError("E_DENIED", "legacy web method denied", { reason: "web-legacy-owner" });
    return inner(params, ctx);
  }]));
}
