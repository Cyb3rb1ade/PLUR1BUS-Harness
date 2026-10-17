import * as processScope from "../agents/scope.ts";
import { CollabError } from "./errors.ts";

/** Collaboration adapter for the process-wide AgentScope (ADR-003); consult/delegate fail closed without one. */
export interface AgentScopeValue {
  agentId: string;
  projectId: string;
  secretScope: string;
  paths: { workdir: string };
  budgetLedger: string;
  toolView: readonly string[];
}



export function currentAgentScope(): AgentScopeValue | undefined {
  // A turn's own process-wide scope (agents/scope.ts) carries no project; only a scope entered through a collaboration run does.
  const scope = processScope.currentAgentScope() as (Partial<AgentScopeValue> & { agentId: string }) | undefined;
  return scope?.projectId === undefined ? undefined : (scope as AgentScopeValue);
}

export function requireAgentScope(): AgentScopeValue {
  const s = currentAgentScope();
  if (!s) throw new CollabError("no-scope", "AgentScope is required; unscoped access is refused");
  return s;
}

export function runWithAgentScope<T>(scope: AgentScopeValue, fn: () => T): T {
  return processScope.runWithAgentScope(scope, fn);
}

export function alsAgentScopePort(): import("./ports.ts").AgentScopePort {
  return {
    run: (scope, fn) => processScope.runWithAgentScope(scope, fn),
    current: () => currentAgentScope(),
  };
}

export function scopeFor(agentId: string, projectId: string): AgentScopeValue {
  return {
    agentId, projectId, secretScope: `agent:${agentId}`,
    paths: { workdir: `agents/${agentId}` },
    budgetLedger: `agent:${agentId}`,
    toolView: [],
  };
}
