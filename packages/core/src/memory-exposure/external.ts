import type { HarnessConfig } from "@plur1bus/config-schema";
import { joinBlocks } from "../join.ts";
import type { HarnessLogger } from "../logger.ts";
import type { MemorySensitivityService } from "../memory-sensitivity/service.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { Principal } from "../rbac/types.ts";
import type { TurnMemory } from "../session/memory-port.ts";
import { resolveExposure } from "./resolve.ts";
import { filterSensitiveBlocks, sensitivityRefusal, sensitivityService } from "./sensitivity.ts";
import type { ExposureChannel } from "./types.ts";

export interface ExternalMemoryDeps {
  /** The one memory port a normal turn uses (`session/memory-port.ts`); there is no second path to the engine. */
  memory: TurnMemory;
  config: () => HarnessConfig;
  logger: Pick<HarnessLogger, "info" | "warn">;
  sensitivity?: MemorySensitivityService | (() => MemorySensitivityService | null | undefined) | undefined;
  audit?: AuditSink | undefined;
}

/** What an external turn tells the memory about itself. */
export interface ExternalTurn {
  channel: "mcp" | "a2a";
  agentId: string;
  principal: Principal | undefined;
  sessionId: string;
  turnId?: string | undefined;
  signal?: AbortSignal | undefined;
  filter?: readonly string[] | undefined;
  disclose?: "agent-decides" | "never" | string | undefined;
  project?: string | undefined;
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
      const disclose = turn.disclose ?? turn.principal?.binding?.memory?.disclose;
      if (disclose === "never") return "";

      if (turn.principal?.binding?.groups && !turn.principal.binding.groups.includes("memory")) {
        return "";
      }

      const exposure = resolveExposure({
        channel: turn.channel as ExposureChannel,
        agentId: turn.agentId,
        principal: turn.principal,
        config: d.config(),
      });
      const { recall } = exposure;
      if (!turn.principal || !(recall.workspace || recall.user || recall.agentPrivate)) return "";

      // Engine limit: the engine can only withhold the user scope. If workspace or agentPrivate is off,
      // fail closed with degraded reason scope-not-enforceable without querying the engine.
      if (!(recall.workspace && recall.agentPrivate)) {
        d.logger.info(`${turn.channel}.recall.refused`, {
          agentId: turn.agentId,
          reason: "scope-not-enforceable",
          scopes: [!recall.workspace && "workspace", !recall.agentPrivate && "agent-private"].filter(Boolean).join(", "),
        });
        return "";
      }

      const filter = [...(turn.principal.binding?.memory?.filter ?? []), ...(turn.filter ?? [])];
      const sensitivity = filter.length ? sensitivityService(d.sensitivity) : undefined;
      const refusal = sensitivityRefusal(filter, sensitivity);
      if (refusal) {
        d.logger.info(`${turn.channel}.recall.refused`, { agentId: turn.agentId, reason: refusal });
        return "";
      }
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
        if (!r.text) return "";

        const blocks = await filterSensitiveBlocks(r.blocks ?? [], filter, sensitivity);
        if (filter.length && blocks.length === 0) return "";

        const cardIds = blocks.map((b) => b.name);
        if (turn.channel === "a2a" && d.audit) {
          d.audit.append({
            at: Date.now(),
            actor: { user: turn.principal.userId || "anonymous", host: "local" },
            action: "a2a.memory.recalled",
            target: `agent:${turn.agentId}`,
            detail: {
              turnId: turn.turnId ?? turn.sessionId,
              sessionId: turn.sessionId,
              cardIds,
            },
          });
        }

        if (blocks.length !== (r.blocks?.length ?? 0)) {
          const capChars = d.config().core.recall.capChars;
          const contextBlocks = blocks.map((b) => ({
            name: b.name,
            text: b.text,
            droppable: b.droppable ?? false,
            chars: b.chars ?? b.text.length,
          }));
          return joinBlocks(contextBlocks, capChars).text;
        }

        return r.text;
      } catch (err) {
        d.logger.warn(`${turn.channel}.recall.failed`, { agentId: turn.agentId, err });
        return "";
      }
    },

    capture(turn, exchange) {
      if (turn.principal?.binding?.memory?.capture === false) return;
      if (turn.principal?.binding?.groups && !turn.principal.binding.groups.includes("memory")) return;

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
          ...(turn.spanId ? { spanId: turn.spanId } : {}),
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

/** Channel adapter for MCP turns (analogous to collabMemory). */
export function mcpMemory(d: ExternalMemoryDeps): ExternalMemory {
  const ext = externalMemory(d);
  return {
    recall: (turn, query) => ext.recall({ ...turn, channel: "mcp" }, query),
    capture: (turn, exchange) => ext.capture({ ...turn, channel: "mcp" }, exchange),
    idle: () => ext.idle(),
  };
}

/** Channel adapter for A2A turns (analogous to collabMemory). */
export function a2aMemory(d: ExternalMemoryDeps): ExternalMemory {
  const ext = externalMemory(d);
  return {
    recall: (turn, query) => ext.recall({ ...turn, channel: "a2a" }, query),
    capture: (turn, exchange) => ext.capture({ ...turn, channel: "a2a" }, exchange),
    idle: () => ext.idle(),
  };
}
