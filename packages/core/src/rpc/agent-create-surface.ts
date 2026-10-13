import { authenticatedPrincipal, RPC_RULES } from "../rbac/guard.ts";
import type { Handler } from "./server.ts";
import { toRpcError } from "../secrets/rpc.ts";
import { RpcError } from "./errors.ts";
import type { agentCreation } from "../agents/create.ts";
// Reuse the existing Owner/Admin system action. Guard resolves the principal and narrows API-token scopes.
export const AGENT_CREATION_RULES = { ...RPC_RULES, ...Object.fromEntries(["agent.create", "agent.validate", "agent.import"].map(method => [method, { action: "settings.write", humanOnly: true, resource: () => ({ kind: "system" as const }) }])) };
export function buildAgentCreationSurface(service: ReturnType<typeof agentCreation>): Record<string, Handler> {
  const bind = (fn: (p: any, who: ReturnType<typeof authenticatedPrincipal>) => unknown): Handler => async (p, ctx) => {
    const who = authenticatedPrincipal(ctx);
    if (who.kind !== "person" || !["owner", "admin"].includes(who.role)) throw new RpcError("E_DENIED", "agent creation is Owner/Admin people only");
    try { return await fn(p, who); } catch (e) { throw toRpcError(e); }
  };
  return {
    "agent.create": bind((p, who) => service.create(p, who)),
    "agent.validate": bind((p, who) => service.validate(p, who)),
    "agent.import": bind((p, who) => service.import(p.bundle, p.onConflict, who)),
  };
}
