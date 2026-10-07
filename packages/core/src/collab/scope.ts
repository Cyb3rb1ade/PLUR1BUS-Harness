import { AsyncLocalStorage } from "node:async_hooks";
import { CollabError } from "./errors.ts";

/** Collab-local AgentScope (ADR-003). The M3 process-wide scope is a follow-up; consult/delegate fail closed without one. */
export interface AgentScopeValue {
  agentId: string;
  projectId: string;
  secretScope: string;
  paths: { workdir: string };
  budgetLedger: string;
  toolView: readonly string[];
}

const als = new AsyncLocalStorage<AgentScopeValue>();

export function currentAgentScope(): AgentScopeValue | undefined {
  return als.getStore();
}

export function requireAgentScope(): AgentScopeValue {
  const s = als.getStore();
  if (!s) throw new CollabError("no-scope", "AgentScope is required; unscoped access is refused");
  return s;
}

export function runWithAgentScope<T>(scope: AgentScopeValue, fn: () => T): T {
  return als.run(scope, fn);
}

export function alsAgentScopePort(): import("./ports.ts").AgentScopePort {
  return {
    run: (scope, fn) => als.run(scope, fn),
    current: () => als.getStore(),
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
