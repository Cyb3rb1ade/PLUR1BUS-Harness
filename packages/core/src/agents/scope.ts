import { AsyncLocalStorage } from "node:async_hooks";
import { RpcError } from "../rpc/errors.ts";
export interface AgentScopeValue {
  agentId: string; projectId?: string; paths: { workdir: string }; secretScope: string; budgetLedger: string; toolView: readonly string[];
}
// One process-wide instance. Worker isolates intentionally begin without a scope.
const storage = new AsyncLocalStorage<AgentScopeValue>();
export const currentAgentScope = () => storage.getStore();
/** Foreign protocol targets execute without authority to any local agent store. */
export function withoutAgentScope<T>(fn: () => T): T { return storage.exit(fn); }
export function requireAgentScope(agentId?: string): AgentScopeValue {
  const scope = storage.getStore();
  if (!scope || (agentId !== undefined && scope.agentId !== agentId)) throw new RpcError("E_DENIED", "AgentScope required for agent storage", { reason: "agent-scope-required" });
  return scope;
}
export function runWithAgentScope<T>(scope: AgentScopeValue, fn: () => T): T {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope.agentId) || scope.secretScope !== `agent:${scope.agentId}` || scope.budgetLedger !== `agent:${scope.agentId}`) throw new RpcError("E_DENIED", "invalid AgentScope");
  return storage.run(Object.freeze({ ...scope, paths: Object.freeze({ ...scope.paths }), toolView: Object.freeze([...scope.toolView]) }), fn);
}
export const scopeFor = (agentId: string, workdir: string): AgentScopeValue => ({ agentId, paths: { workdir }, secretScope: `agent:${agentId}`, budgetLedger: `agent:${agentId}`, toolView: [] });
