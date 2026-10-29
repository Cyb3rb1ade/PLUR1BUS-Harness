import type { HarnessConfig } from "@plur1bus/config-schema";
import type { HarnessLogger } from "../logger.ts";
import type { Principal } from "../rbac/types.ts";
import type { TurnMemory } from "../session/memory-port.ts";
import { resolveExposure } from "./resolve.ts";
import type { ExposureChannel } from "./types.ts";

export interface ExternalMemoryDeps {
  /** The one memory port a normal turn uses (`session/memory-port.ts`); there is no second path to the engine. */
  memory: TurnMemory;
  config: () => HarnessConfig;
  logger: Pick<HarnessLogger, "info" | "warn">;
}

/** What an external turn tells the memory about itself. */
export interface ExternalTurn {
  channel: "mcp" | "a2a";
  agentId: string;
  principal: Principal | undefined;
  sessionId: string;
  signal?: AbortSignal | undefined;
}

export interface ExternalMemory {
  /** The recalled memory text for the turn, "" when nothing is exposed, the recall degrades or fails. Never throws. */
  recall(turn: ExternalTurn, query: string): Promise<string>;
  /** Stores the exchange after the turn, in the background; a failure is logged and never reaches the caller. */
  capture(turn: ExternalTurn & { turnId: string; traceId?: string; spanId?: string }, exchange: { question: string; answer: string }): void;
  /** Resolves once every capture started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
}

export function externalMemory(d: ExternalMemoryDeps): ExternalMemory {
  const pending = new Set<Promise<void>>();
  const caller = (channel: string, principal: Principal) => ({
    channel: "cli" as const,
    accountId: `ext-${channel}`,
    userId: principal.userId,
  });

  return {
    async recall(turn, query) {
      const exposure = resolveExposure({
        channel: turn.channel as ExposureChannel,
        agentId: turn.agentId,
        principal: turn.principal,
        config: d.config(),
      });
      const { recall } = exposure;
      if (!turn.principal || !(recall.workspace || recall.user || recall.agentPrivate)) return "";
      try {
        const r = await d.memory.recall({
          agentId: turn.agentId,
          caller: caller(turn.channel, turn.principal),
          authenticatedPerson: turn.principal.userId,
          query,
          signal: turn.signal ?? new AbortController().signal,
          scopes: recall,
        });
        if (r.degraded) {
          d.logger.info(`${turn.channel}.recall.degraded`, {
            agentId: turn.agentId,
            reason: r.degraded.reason,
            ...(r.degraded.detail ? { detail: r.degraded.detail } : {}),
          });
        }
        return r.text;
      } catch (err) {
        d.logger.warn(`${turn.channel}.recall.failed`, { agentId: turn.agentId, err });
        return "";
      }
    },

    capture(turn, exchange) {
      const exposure = resolveExposure({
        channel: turn.channel as ExposureChannel,
        agentId: turn.agentId,
        principal: turn.principal,
        config: d.config(),
      });
      if (!exposure.capture || !turn.principal) return;

      const task = d.memory.capture({
        agentId: turn.agentId,
        caller: caller(turn.channel, turn.principal),
        authenticatedPerson: turn.principal.userId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        incognito: false,
        messages: [
          { role: "user", content: `[${turn.channel}] External request:\n${exchange.question}` },
          { role: "assistant", content: exchange.answer },
        ],
        provenance: {
          origin: turn.channel,
          ...(turn.traceId ? { traceId: turn.traceId } : {}),
          ...(turn.spanId ? { spanId: turn.spanId } : {})
        },
      }).then(
        (outcome) => {
          if (outcome && !outcome.submitted) {
            d.logger.info(`${turn.channel}.capture.skipped`, {
              agentId: turn.agentId,
              reason: outcome.reason,
            });
          }
        },
        (err) => d.logger.warn(`${turn.channel}.capture.failed`, { agentId: turn.agentId, err }),
      );
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },

    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
