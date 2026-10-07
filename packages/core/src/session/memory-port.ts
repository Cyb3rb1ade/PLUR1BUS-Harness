// The turn loop's one door to the engine (acceptance 4: no second memory loop). The loop calls `recall` once before a
// turn and `capture` once after it; the engine-backed port below makes exactly the engine calls `memory.recall` and
// `memory.capture` make (rpc/methods.ts), with the same identity, budgets and signals.
import type { Degraded, Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import type { AgentRegistry } from "../agents.ts";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import { requireAgent } from "../memory-ops.ts";
import { AGENT_CONTEXT_CLI, callerToPrincipal } from "../principal.ts";

export interface TurnMemory {
  /** One call per turn, before the provider runs. Never throws for a degraded recall (returns `degraded`). */
  recall(a: { agentId: string; caller: CallerIdentity; query: string; signal: AbortSignal }): Promise<{ text: string; degraded: Degraded | null }>;
  /** One call per turn, after it completed, and never for an incognito session. `incognito` is derived by the core from
   *  the session (F10): it is never a client parameter. */
  capture(a: { agentId: string; caller: CallerIdentity; sessionId: string; turnId: string; messages: { role: "user" | "assistant"; content: string }[]; incognito: boolean }): Promise<void>;
  /** D23: the `compaction` checkpoint before a swap; never called for an incognito session. */
  checkpoint(a: { agentId: string; reason: "compaction" | "session-end" }): Promise<void>;
}

export interface EnginePortDeps {
  engine: Engine; config: () => HarnessConfig; agents: AgentRegistry; logger: HarnessLogger;
  /** R19: the core's shutdown signal, the only abort a capture observes. */
  captureSignal: AbortSignal; isStopping: () => boolean;
  onStoredCapture?: (agentId: string) => void;
}

export function engineTurnMemory(d: EnginePortDeps): TurnMemory {
  const identity = (caller: CallerIdentity, agentId: string) => callerToPrincipal(caller, agentId, requireAgent(d.agents, agentId));
  return {
    async recall({ agentId, caller, query, signal }) {
      const { principal, degraded } = identity(caller, agentId);
      const r = d.config().core.recall;
      const hard = AbortSignal.timeout(r.hardBudgetMs);
      const res = await d.engine.recall({ query, principal, agent: AGENT_CONTEXT_CLI, budget: { softMs: r.softBudgetMs, hardMs: r.hardBudgetMs, capChars: r.capChars }, signal: AbortSignal.any([signal, hard]) });
      const blocks = res.blocks.map((b) => ({ name: b.name, text: b.text, droppable: b.droppable, chars: b.chars }));
      const engineCap = Number.isFinite(res.capChars) ? res.capChars : null;
      const text = joinBlocks(blocks, engineCap === null ? r.capChars : Math.min(engineCap, r.capChars)).text;
      const g = res.degraded ? { reason: String(res.degraded.reason), capability: String(res.degraded.capability ?? "recall") } : null;
      return { text, degraded: g ?? degraded };
    },
    async capture({ agentId, caller, sessionId, turnId, messages, incognito }) {
      if (d.isStopping()) return; // the turn is already stored; a stopping core takes no new capture (the next start does not replay it: RULING, a lost capture is logged)
      const { principal } = identity(caller, agentId);
      const handle = d.engine.capture({
        agentId, principal, agent: AGENT_CONTEXT_CLI, messages, incognito, signal: d.captureSignal, sessionKey: `session:${sessionId}`, runId: turnId,
      });
      const r = await handle.done;
      if (r.stored > 0) d.onStoredCapture?.(agentId);
      d.logger.info("session capture done", { agentId, sessionId, turnId, captureId: handle.id, stored: r.stored, skipped: r.skipped, reason: r.reason });
    },
    async checkpoint({ agentId, reason }) {
      requireAgent(d.agents, agentId);
      await d.engine.checkpoint(agentId, reason);
    },
  };
}
