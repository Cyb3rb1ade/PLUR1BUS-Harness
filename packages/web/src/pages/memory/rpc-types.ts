// Wire types of the RPC methods the Memories & Dreams page uses (docs/rpc.md, packages/rpc-schema). Declared by merging into
// RpcMethods so `api.rpc("memory.list", params)` is typed. `core.status` is deliberately NOT merged: other pages read it too and
// two differing declarations of one key would not compile; data.ts reads it through its own narrow type.

// `caller` is required by the documented schema but a browser never asserts identity; the Harness API must derive it from the session (docs/web-ui.md F1)
export type AgentRef = { agentId: string };

export type Degraded = { reason: string; capability: string; detail?: string };

export type MemoryScope = "agent-private" | "workspace" | "user";
export type MemoryCard = {
  id: string; scope: MemoryScope; text: string; summary: string; createdAt: number | null; origin: string | null; epistemicStatus: string | null;
  score?: number; sharedBy?: string; sourceId?: string;
};

export type MemoryListParams = AgentRef & { topic?: string; since?: number; until?: number; limit?: number };
export type MemoryListResult = { agentId: string; items: MemoryCard[]; truncated: boolean; degraded?: Degraded };
export type MemoryShowResult = { card: MemoryCard; degraded?: Degraded };
export type MemoryStateResult = {
  agentId: string; cards: { agentPrivate: number | null; workspace: number | null; user: number | null }; tombstones: number | null; archiveDir: string; degraded?: Degraded;
};

export type ContextBlock = { name: string; text: string; droppable: boolean; chars: number; tokensEstimate?: number };
export type Deferral = { block: string; kind: "clipped" | "dropped"; from: number; to: number; reason: "global-cap" | "memories-cap" };
export type RecallResult = {
  blocks: ContextBlock[]; capChars: number | null; degraded: Degraded | null; trace?: Record<string, unknown>;
  timing: { totalMs: number; phases?: Record<string, unknown> | null }; deferrals: Deferral[];
};

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";
export type MemoryProposal = {
  id: string; sharedId: string; sourceId: string; target: "workspace" | "user"; sharerAgentId: string; proposerAgentId: string;
  oldText: string; newText: string; note: string | null; createdAt: number; status: ProposalStatus; resolvedAt: number | null; resultId: string | null; resolutionNote: string | null;
};
export type ProposalsListResult = { agentId: string; items: MemoryProposal[]; truncated: boolean; unreadable: number; degraded?: Degraded };

export type DreamPhase = "light" | "rem" | "deep";
export type DreamOutcome = "completed" | "skipped" | "failed" | "aborted";
export type DreamTrigger = "cron" | "importance" | "manual" | "catchup";
export type DreamRun = {
  runId: string; agentId: string; phase: DreamPhase; jobId: string; idempotencyKey: string; claimed: boolean; trigger: DreamTrigger;
  scheduledFor?: number | null; startedAt: number; finishedAt?: number | null; durationMs?: number | null; outcome: DreamOutcome | null; reason: string | null;
  counts: Record<string, number>; tokensIn?: number | null; tokensOut?: number | null; costMicros?: number | null; logPath?: string | null;
  error?: { message: string; name?: string } | null;
};
export type DreamPhaseStatus = {
  phase: DreamPhase; enabled: boolean; cron: string; timezone: string; staggerOffsetS: number; nextRunAt: number | null; running: boolean; lastRun: DreamRun | null;
  breaker: { state: "closed" | "open"; until: number | null; reason: string | null; sessionsUsed: number; limit: number };
  importance: { accumulated: number; threshold: number; capturesSinceRun: number; minCorpus: number };
};
export type DreamAgentStatus = { agentId: string; phases: DreamPhaseStatus[]; diary: { path: string; exists: boolean; bytes: number } | null };
export type DreamStatusResult = {
  agents: DreamAgentStatus[];
  counters: { runs: Record<string, number>; skips: Record<string, number>; triggers: Record<string, number>; breakerTrips: number; reconciled: number };
  schemaVersion: number;
};
export type DreamSchedule = { agentId: string; phase: DreamPhase; cron: string; timezone: string; enabled: boolean; staggerOffsetS: number; nextRunAt: number | null };
export type DreamPlan = { dryRun: true; wouldRun: boolean; reason: string | null; jobs: string[]; idempotencyKey: string; counts: Record<string, number> };

declare module "../../api/index.ts" {
  interface RpcMethods {
    "memory.list": { params: MemoryListParams; result: MemoryListResult };
    "memory.show": { params: AgentRef & { id: string }; result: MemoryShowResult };
    "memory.state": { params: AgentRef; result: MemoryStateResult };
    "memory.recall": { params: AgentRef & { query: string; joined?: boolean }; result: RecallResult };
    "memory.proposals.list": { params: AgentRef & { status?: ProposalStatus; limit?: number }; result: ProposalsListResult };
    "dreams.status": { params: { agentId?: string } | void; result: DreamStatusResult };
    "dreams.log": { params: { agentId?: string; phase?: DreamPhase; runId?: string; limit?: number }; result: { runs: DreamRun[]; log?: string } };
    "dreams.run": { params: { agentId: string; phase: DreamPhase; dryRun?: boolean }; result: DreamRun | DreamPlan };
    "dreams.schedule.get": { params: { agentId: string }; result: { schedules: DreamSchedule[] } };
    "dreams.enable": { params: { agentId: string; phase: DreamPhase }; result: { schedule: DreamSchedule } };
    "dreams.disable": { params: { agentId: string; phase: DreamPhase }; result: { schedule: DreamSchedule } };
  }
}
