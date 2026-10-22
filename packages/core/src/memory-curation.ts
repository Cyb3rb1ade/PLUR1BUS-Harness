// A4: public human curation of Neo records; separate from D31 memory.proposals.
import type { Engine, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { AgentRegistry } from "./agents.ts";
import type { HarnessLogger } from "./logger.ts";
import { callerToPrincipal, AGENT_CONTEXT_CLI } from "./principal.ts";
import { deriveUserPrincipal } from "./identity/principals.ts";
import { mapMemoryOpError, requireAgent } from "./memory-ops.ts";
import { authenticatedPrincipal } from "./rbac/guard.ts";
import { authorize } from "./rbac/authorize.ts";
import { RpcError } from "./rpc/errors.ts";
import type { Handler } from "./rpc/server.ts";

export const CURATION_METHODS = ["memory.curation.list", "memory.curation.resolve"] as const;

// Public Engine 1.17.0 structural contract while only the Controller changes the pin.
// No private Engine import; absence remains a visible refusal, never a local substitute queue.
interface Curation117 {
  list(q: { limit?: number }, p: Principal, a: typeof AGENT_CONTEXT_CLI): Promise<{ agentId: string; items: { id: string; status: string; text: string; category: string | null }[]; truncated: boolean }>;
  resolve(id: string, action: "keep" | "drop", p: Principal, a: typeof AGENT_CONTEXT_CLI): Promise<{ id: string; ok: boolean; status?: string; reason?: string }>;
}
export function buildMemoryCurationMethods(d: { engine: Engine; agents: AgentRegistry; logger: HarnessLogger; isStopping: () => boolean }): Record<string, Handler> {
  const bind = (fn: (api: Curation117, p: any, principal: Principal) => Promise<object>): Handler => async (p, ctx) => {
    if (d.isStopping()) throw new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });
    const who = authenticatedPrincipal(ctx);
    if (who.kind !== "person" || authorize(who, "agent.manage", { kind: "agent", agentId: p.agentId }).effect !== "allow") throw new RpcError("E_DENIED", "human agent management required", { reason: "curation-not-permitted" });
    const workspace = requireAgent(d.agents, p.agentId);
    const api = (d.engine.memory as typeof d.engine.memory & { curation?: Curation117 }).curation;
    if (!api || typeof api.list !== "function" || typeof api.resolve !== "function") throw new RpcError("E_NOT_AVAILABLE", "curation requires Engine contract 1.17.0", { reason: "engine-contract-unavailable" });
    try {
      const { principal } = callerToPrincipal({ channel: "cli", accountId: "curation", userId: who.userId }, p.agentId, workspace);
      principal.user = deriveUserPrincipal(who.userId);
      return await fn(api, p, principal);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const mapped = mapMemoryOpError(error, { stopping: d.isStopping() });
      if (mapped) throw mapped;
      d.logger.warn("curation operation failed", { agentId: p.agentId });
      throw new RpcError("E_STORAGE", "curation unavailable", { reason: "curation-failed" });
    }
  };
  return {
    "memory.curation.list": bind(async (api, p, principal) => {
      const result = await api.list(p.limit === undefined ? {} : { limit: p.limit }, principal, AGENT_CONTEXT_CLI);
      if (result.agentId !== p.agentId) throw new RpcError("E_CONFLICT", "curation agent did not match", { reason: "curation-agent-mismatch" });
      return { agentId: result.agentId, items: result.items.map(({ id, status, text, category }) => ({ id, status, text, category })), truncated: result.truncated };
    }),
    "memory.curation.resolve": bind(async (api, p, principal) => {
      const result = await api.resolve(p.id, p.action, principal, AGENT_CONTEXT_CLI);
      const expectedStatus = p.action === "keep" ? "promoted" : "demoted";
      if (!result.ok || result.id !== p.id || result.status !== expectedStatus) throw new RpcError("E_CONFLICT", "curation was not confirmed", { reason: result.reason ?? "curation-unconfirmed" });
      return { agentId: p.agentId, id: result.id, status: result.status };
    }),
  };
}
