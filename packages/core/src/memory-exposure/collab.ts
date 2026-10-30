import type { HarnessConfig } from "@plur1bus/config-schema";
import type { HarnessLogger } from "../logger.ts";
import type { Principal } from "../rbac/types.ts";
import type { TurnMemory } from "../session/memory-port.ts";
import { resolveExposure } from "./resolve.ts";

export interface CollabMemoryDeps {
  /** The one memory port a normal turn uses (`session/memory-port.ts`); there is no second path to the engine. */
  memory: TurnMemory;
  config: () => HarnessConfig;
  logger: Pick<HarnessLogger, "info" | "warn">;
}

/** What a collab turn tells the memory about itself. `fromAgent` is the agent that asked or delegated. */
export interface CollabTurn {
  /** The agent that runs the turn (consult_agent / delegate_task target). */
  agentId: string;
  /** The authenticated person (or agent) who asked; the recall and the capture run as them. */
  principal: Principal | undefined;
  fromAgent: string | undefined;
  sessionId: string;
  signal: AbortSignal;
}

export interface CollabMemory {
  /** The recalled memory text for the turn, "" when nothing is exposed, the recall degrades or fails. Never throws. */
  recall(turn: CollabTurn, query: string): Promise<string>;
  /** Stores the exchange after the turn, in the background; a failure is logged and never reaches the caller. */
  capture(turn: CollabTurn & { turnId: string; traceId?: string; spanId?: string }, exchange: { question: string; answer: string }): void;
  /** Resolves once every capture started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
}

const origin = "collab";

/** Memory for the `collab` channel (owner decision 2026-10-29, ADR-003): the asked agent recalls and captures with the
 *  asking person as principal, through the same port as a normal turn. */
export function collabMemory(d: CollabMemoryDeps): CollabMemory {
  const pending = new Set<Promise<void>>();
  const caller = (principal: Principal) => ({ channel: "cli" as const, accountId: origin, userId: principal.userId });
  return {
    async recall(turn, query) {
      const exposure = resolveExposure({ channel: origin, agentId: turn.agentId, principal: turn.principal, config: d.config() });
      const { recall } = exposure;
      if (!turn.principal || !(recall.workspace || recall.user || recall.agentPrivate)) return "";
      try {
        const r = await d.memory.recall({ agentId: turn.agentId, caller: caller(turn.principal), authenticatedPerson: turn.principal.userId, query, signal: turn.signal, scopes: recall });
        if (r.degraded) d.logger.info("collab.recall.degraded", { agentId: turn.agentId, fromAgent: turn.fromAgent, reason: r.degraded.reason, ...(r.degraded.detail ? { detail: r.degraded.detail } : {}) });
        return r.text;
      } catch (err) {
        d.logger.warn("collab.recall.failed", { agentId: turn.agentId, fromAgent: turn.fromAgent, err });
        return "";
      }
    },
    capture(turn, exchange) {
      const exposure = resolveExposure({ channel: origin, agentId: turn.agentId, principal: turn.principal, config: d.config() });
      if (!exposure.capture || !turn.principal) return;
      if (!turn.fromAgent) {
        // A card whose origin is unknown would read as the person's own words.
        d.logger.warn("collab.capture.skipped", { agentId: turn.agentId, reason: "no-requesting-agent" });
        return;
      }
      const task = d.memory.capture({
        agentId: turn.agentId, caller: caller(turn.principal), authenticatedPerson: turn.principal.userId, sessionId: turn.sessionId, turnId: turn.turnId, incognito: false,
        messages: [
          { role: "user", content: `[${origin}] Request from agent "${turn.fromAgent}" on behalf of the person asking:\n${exchange.question}` },
          { role: "assistant", content: exchange.answer },
        ],
        provenance: { origin, fromAgent: turn.fromAgent, ...(turn.traceId ? { traceId: turn.traceId } : {}), ...(turn.spanId ? { spanId: turn.spanId } : {}) },
      }).then(
        outcome => { if (outcome && !outcome.submitted) d.logger.info("collab.capture.skipped", { agentId: turn.agentId, fromAgent: turn.fromAgent, reason: outcome.reason }); },
        err => d.logger.warn("collab.capture.failed", { agentId: turn.agentId, fromAgent: turn.fromAgent, err }),
      );
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}
