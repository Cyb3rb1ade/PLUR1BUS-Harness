import type { GuardrailReason } from "./errors.ts";

export type ProjectRole = "member" | "lead";
export type CollabKind = "consult" | "delegate";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type SpanStatus = "partial" | "running" | "succeeded" | "failed" | "cancelled" | "refused";
export type AgentState = "active" | "paused" | "archived";

export interface CollabSettings {
  /** D124: read-only hops after the root agent (default 2); writers remain at depth 1. */
  maxDepth: number;
  /** D124 read helper starts per calling turn (default 8, ceiling 32). */
  maxFanout: number;
  /** D124 consult starts per (from, to) pair per calling turn (default 4). */
  maxPairPerTurn: number;
  maxTurns: number;
  timeoutMs: number;
  /** Delegate return cap in tokens (ADR-010 §4, ≈2 000). */
  returnTokens: number;
  allowCrossProject: boolean;
  repeatWindowMs: number;
  tokenBudget: number | null;
}

export interface ProjectMember { userId: string; role: ProjectRole }
export interface Project {
  id: string;
  name: string;
  owner: string;
  members: ProjectMember[];
  agents: string[];
  settings: CollabSettings;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface Provenance {
  agentId: string;
  projectId: string;
  traceId: string;
  spanId: string;
  at: number;
  cost: { inputTokens: number; outputTokens: number };
  origin?: "a2a";
  targetKind: "local" | "external" | "a2a";
}

export interface ConsultAnswer {
  status?: "done" | "partial";
  kind: "consult.answer";
  text: string;
  provenance: Provenance;
  path: string[];
  traceId: string;
}

export interface DelegateTask {
  origin?: "a2a";
  targetKind?: "local" | "external" | "a2a";
  id: string;
  projectId: string;
  traceId: string;
  spanId: string;
  parentTaskId: string | null;
  fromAgent: string;
  toAgent: string;
  status: TaskStatus;
  task: string;
  acceptanceCriteria: string;
  /** Capped body plus marker and pointer when truncated; never silently cut. */
  result: string | null;
  truncated: boolean;
  artifactId: string | null;
  artifactPointer: string | null;
  error: string | null;
  path: string[];
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface DelegateHandle {
  task: DelegateTask;
  done: Promise<DelegateTask>;
}

export interface CollabSpan {
  origin?: "a2a";
  targetKind?: "local" | "external" | "a2a";
  sessionId?: string;
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  agentId: string;
  kind: CollabKind | "guardrail";
  startedAt: number;
  endedAt: number | null;
  status: SpanStatus;
  inputTokens: number;
  outputTokens: number;
  inputPreview: string;
  outputPreview: string;
  error: string | null;
  guardrail: GuardrailReason | null;
}

export interface CollabTrace {
  traceId: string;
  traceparent: string;
  projectId: string;
  rootAgent: string;
  rootSpanId: string;
  createdAt: number;
  endedAt: number | null;
  status: SpanStatus;
  spans: CollabSpan[];
}

export const COLLAB_EVENT_TYPES = [
  "project.created", "project.archived", "project.member.added", "project.member.removed",
  "project.agent.added", "project.agent.removed",
  "consult.started", "consult.finished",
  "delegate.queued", "delegate.started", "delegate.finished", "delegate.cancelled",
  "guardrail.refused", "chain.abandoned",
] as const;
export type CollabEventType = (typeof COLLAB_EVENT_TYPES)[number];

export interface CollabEvent {
  type: CollabEventType;
  at: number;
  projectId: string;
  traceId?: string;
  agentId?: string;
  data: Record<string, unknown>;
}

export interface ConsultInput {
  taskClass?: import('./limits.ts').TaskClass;
  callClass?: import('./limits.ts').CallClass;
  outbound?: import("./runner.ts").AgentRunInput["outbound"];
  handoff?: import("./runner.ts").AgentRunInput["handoff"];
  principal: import("../rbac/types.ts").Principal;
  projectId: string;
  fromAgent: string;
  toAgent: string;
  question: string;
  context: string;
  signal?: AbortSignal;
  traceId?: string;
  parentSpanId?: string | null;
  path?: string[];
  parentTaskId?: string | null;
}

export interface DelegateInput {
  taskClass?: import('./limits.ts').TaskClass;
  callClass?: import('./limits.ts').CallClass;
  outbound?: import("./runner.ts").AgentRunInput["outbound"];
  handoff?: import("./runner.ts").AgentRunInput["handoff"];
  principal: import("../rbac/types.ts").Principal;
  projectId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  acceptanceCriteria: string;
  signal?: AbortSignal;
  traceId?: string;
  parentSpanId?: string | null;
  path?: string[];
  parentTaskId?: string | null;
}
