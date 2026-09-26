import type { CheckpointResult, Deferral, Degraded, Engine, JobName, JobRun, Principal, RecallResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type {
  AgentCloseParams, AgentOpenParams, AgentStatusParams, CallerIdentity, CoreShutdownParams, CoreStatusResult, JobsHistoryParams, JobsRunParams,
  MemoryCaptureParams, MemoryCaptureResult, MemoryCheckpointParams, MemoryCheckpointResult, MemoryRecallParams, MemoryRecallResult,
} from "@plur1bus/rpc-schema";
import type { ActivityTracker } from "../activity.ts";
import type { AgentRegistry } from "../agents.ts";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "../principal.ts";
import { RpcError } from "./errors.ts";
import type { Handler } from "./server.ts";

export interface MethodDeps {
  engine: Engine; config: HarnessConfig; agents: AgentRegistry; activity: ActivityTracker; logger: HarnessLogger;
  status: () => CoreStatusResult; shutdown: (budgetMs?: number) => void; journalBacklog: () => number; clock: () => number;
  /** R19: the core-owned shutdown signal, the only abort a capture observes. */
  captureSignal: AbortSignal;
}

function requireAgent(agents: AgentRegistry, agentId: string): string {
  const ws = agents.workspaceOf(agentId);
  if (!ws) throw new RpcError("E_AGENT_UNKNOWN", `agent not registered: ${agentId}`, { reason: "not-registered" });
  return ws;
}

function identity(d: MethodDeps, caller: CallerIdentity, agentId: string): { principal: Principal; degraded: Degraded | null } {
  return callerToPrincipal(caller, agentId, requireAgent(d.agents, agentId));
}

// The wire shapes are closed (rpc.schema.json): project every engine object onto exactly the schema's keys.
const projectDegraded = (g: Degraded | null | undefined): Degraded | null =>
  g ? { reason: String(g.reason), capability: String(g.capability ?? "recall"), ...(typeof g.detail === "string" ? { detail: g.detail } : {}) } : null;
const projectDeferral = (x: Deferral): Deferral => ({ block: x.block, kind: x.kind, from: x.from, to: x.to, reason: x.reason });

function serializeRecall(r: RecallResult, joined: boolean, capChars: number): MemoryRecallResult {
  const blocks = r.blocks.map((b) => ({ name: b.name, text: b.text, droppable: b.droppable, chars: b.chars, ...(b.tokensEstimate !== undefined ? { tokensEstimate: b.tokensEstimate } : {}) }));
  const engineCap = Number.isFinite(r.capChars) ? r.capChars : null;
  const base: MemoryRecallResult = {
    blocks, capChars: engineCap, degraded: projectDegraded(r.degraded), timing: { ...r.timing }, deferrals: (r.deferrals ?? []).map(projectDeferral),
    ...(r.trace ? { trace: r.trace } : {}),
  };
  return joined ? { ...base, joined: joinBlocks(blocks, engineCap === null ? capChars : Math.min(engineCap, capChars)) } : base;
}

const projectCheckpoint = (c: CheckpointResult): MemoryCheckpointResult => ({ agentId: c.agentId, reason: c.reason, digest: c.digest, written: c.written });

const notAvailable: Handler = async () => { throw new RpcError("E_NOT_AVAILABLE", "memory operations arrive with engine PR E1 (MemoryOps)", { reason: "engine-pr-E1" }); };

export function buildMethods(d: MethodDeps): Record<string, Handler> {
  const openAgents = new Map<string, { close(): Promise<void> }>(); // one map per core

  const runJob = async (p: JobsRunParams, signal: AbortSignal): Promise<JobRun> => {
    requireAgent(d.agents, p.agentId);
    const spec = d.engine.jobs.list().find((j) => j.name === p.job);
    if (!spec) throw new RpcError("E_INVALID_PARAMS", `unknown job ${p.job}`, { detail: "job" });
    d.activity.set(p.agentId, spec.phase ? { state: "dreaming", phase: spec.phase, job: spec.name } : { state: "maintenance", job: spec.name });
    try { return await d.engine.jobs.run(spec.name, p.agentId, { signal, trigger: "harness", ...(p.dryRun !== undefined ? { dryRun: p.dryRun } : {}) }); }
    finally { d.activity.idle(p.agentId); }
  };

  return {
    "core.status": async () => d.status(),
    "core.shutdown": async (p: CoreShutdownParams) => { d.shutdown(p.budgetMs); return { accepted: true as const }; },

    "memory.recall": async (p: MemoryRecallParams, ctx) => {
      const { principal, degraded } = identity(d, p.caller, p.agentId);
      const hardMs = p.budget?.hardMs ?? d.config.core.recall.hardBudgetMs;
      const softMs = p.budget?.softMs ?? d.config.core.recall.softBudgetMs;
      const capChars = p.budget?.capChars ?? d.config.core.recall.capChars;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(hardMs)]);
      d.activity.set(p.agentId, { state: "recalling" });
      try {
        // RecallQuery has no sessionKey (contract 1.4.1): the session key is capture-side until 2c.
        const r = await d.engine.recall({ query: p.query, principal, agent: AGENT_CONTEXT_CLI, budget: { softMs, hardMs, capChars }, signal });
        const out = serializeRecall(r, p.joined === true, capChars);
        return degraded && !out.degraded ? { ...out, degraded } : out;
      } finally { d.activity.idle(p.agentId); }
    },

    // R19: a capture is never lost because of the wait. Its signal is the core's shutdown signal only — not the
    // connection (a client disconnect never aborts it) and not the waitMs timer (which bounds the reply, not the work).
    "memory.capture": async (p: MemoryCaptureParams): Promise<MemoryCaptureResult> => {
      const { principal } = identity(d, p.caller, p.agentId);
      d.activity.set(p.agentId, { state: "capturing" });
      const handle = d.engine.capture({
        agentId: p.agentId, principal, agent: AGENT_CONTEXT_CLI, messages: p.messages, incognito: false, // the engine fails closed on anything but an explicit false
        signal: d.captureSignal,
        ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}), ...(p.runId ? { runId: p.runId } : {}),
      });
      const settle = handle.done
        .then((r) => { d.logger.info("capture done", { agentId: p.agentId, captureId: handle.id, stored: r.stored, skipped: r.skipped, reason: r.reason }); return r; })
        .finally(() => d.activity.idle(p.agentId));
      settle.catch((e) => d.logger.warn("capture failed", { agentId: p.agentId, captureId: handle.id, err: e })); // never an unhandled rejection
      const pending: MemoryCaptureResult = { id: handle.id, acceptedAt: handle.acceptedAt, pending: true };
      if (p.wait === false) return pending;
      const waitMs = p.waitMs ?? d.config.core.capture.waitMs;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<null>((res) => { timer = setTimeout(() => res(null), waitMs); timer.unref(); });
      try {
        const r = await Promise.race([settle, timedOut]);
        if (r === null) return pending; // the capture keeps running; its .finally resets activity and logs the outcome
        return { id: handle.id, acceptedAt: handle.acceptedAt, stored: r.stored, skipped: r.skipped, ...(r.reason ? { reason: r.reason } : {}) };
      } finally { clearTimeout(timer); }
    },

    "memory.checkpoint": async (p: MemoryCheckpointParams) => {
      requireAgent(d.agents, p.agentId);
      d.activity.set(p.agentId, { state: "checkpointing" });
      try { return projectCheckpoint(await d.engine.checkpoint(p.agentId, p.reason)); } finally { d.activity.idle(p.agentId); }
    },

    "memory.list": notAvailable, "memory.show": notAvailable, "memory.forget": notAvailable, "memory.correct": notAvailable, "memory.share": notAvailable, "memory.state": notAvailable,
    "memory.propose": notAvailable, "memory.proposals.list": notAvailable, "memory.proposals.accept": notAvailable, "memory.proposals.reject": notAvailable,

    "agent.list": async () => ({ agents: d.agents.list().map((agentId) => ({ agentId, open: openAgents.has(agentId), activity: d.activity.get(agentId) })) }),
    "agent.open": async (p: AgentOpenParams) => {
      requireAgent(d.agents, p.agentId);
      if (!openAgents.has(p.agentId)) openAgents.set(p.agentId, await d.engine.open(p.agentId));
      return { agentId: p.agentId, open: true as const };
    },
    "agent.close": async (p: AgentCloseParams) => {
      const s = openAgents.get(p.agentId);
      if (s) { openAgents.delete(p.agentId); await s.close(); }
      return { agentId: p.agentId, open: false as const };
    },
    "agent.status": async (p: AgentStatusParams) => {
      const workspace = requireAgent(d.agents, p.agentId);
      const lastJobs = await d.engine.jobs.history(p.agentId, { limit: 5 });
      return { agentId: p.agentId, open: openAgents.has(p.agentId), activity: d.activity.get(p.agentId), workspace, lastJobs };
    },

    "jobs.list": async () => ({ jobs: d.engine.jobs.list() }),
    "jobs.run": async (p: JobsRunParams, ctx) => runJob(p, ctx.signal),
    "jobs.history": async (p: JobsHistoryParams) => {
      requireAgent(d.agents, p.agentId);
      return { runs: await d.engine.jobs.history(p.agentId, { ...(p.job ? { job: p.job as JobName } : {}), ...(p.since !== undefined ? { since: p.since } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }) };
    },
  };
}
