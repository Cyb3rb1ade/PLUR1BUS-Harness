import { authorize as rbacAuthorize } from "../rbac/authorize.ts";
import type { Principal, Resource } from "../rbac/types.ts";
import { createRedactor } from "../logs/redact.ts";
import type { GuardrailReason as GR } from "./errors.ts";
import type { AgentState, CollabEvent } from "./types.ts";
import type { AgentScopeValue } from "./scope.ts";

export type { Principal, Resource };

export type AuthorizePort = (
  principal: Principal | null | undefined,
  action: string,
  resource: Resource,
) => { effect: "allow" | "deny"; reason: string };

export const rbacAuthorizePort: AuthorizePort = (principal, action, resource) => {
  const d = rbacAuthorize(principal, action, resource);
  return { effect: d.effect, reason: d.reason };
};

export interface BudgetCheck {
  tokens: number;
  cost: number;
  projectId: string;
  agentId: string;
  chainId: string;
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: Extract<GR, "token-budget" | "cost-budget"> };

export interface BudgetPort {
  check(estimate: BudgetCheck): BudgetDecision;
  record(usage: BudgetCheck): void;
}

export interface ArtifactRecord { id: string; projectId: string; body: string; contentType: string; createdAt: number }
export interface ArtifactPort {
  put(input: { projectId: string; body: string; contentType?: string }): { id: string; pointer: string };
  get(id: string): ArtifactRecord | null;
}

export interface RedactionPort {
  text(s: string): string;
  value<T>(v: T): T;
}

export interface EventEmitter {
  emit(e: CollabEvent): void;
}

export interface AgentInfo { id: string; state: AgentState; projectIds?: readonly string[] }
export interface AgentDirectoryPort {
  get(agentId: string): AgentInfo | null;
}

export interface AgentScopePort {
  run<T>(scope: AgentScopeValue, fn: () => Promise<T>): Promise<T>;
  current(): AgentScopeValue | undefined;
}

export function noopEmitter(): EventEmitter {
  return { emit() { /* default no-op */ } };
}

export function unlimitedBudget(): BudgetPort {
  return { check: () => ({ allowed: true }), record() { /* no-op */ } };
}

export function logsRedactionPort(secrets?: Iterable<string>): RedactionPort {
  const r = createRedactor({ pii: true, ...(secrets ? { secrets } : {}) });
  return { text: (s) => r.text(s), value: (v) => r.value(v) };
}

export function activeDirectory(): AgentDirectoryPort {
  return { get: (id) => ({ id, state: "active" }) };
}

export type { GR as GuardrailReason };
