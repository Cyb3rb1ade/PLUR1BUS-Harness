// telemetry.cache.summary (D120 H2-1): prompt-cache hit ratio from the budget ledger plus process-local per-session miss causes.
// Read-only; counts and ids only, never prompt content.
import { BudgetInputError, type BudgetService } from "../budget/service.ts";
import type { CacheTelemetry } from "../prompt/index.ts";
import { RpcError } from "./errors.ts";
import type { Handler } from "./server.ts";

export interface TelemetrySurfaceDeps {
  clock: () => number;
  budget: () => Pick<BudgetService, "cacheUsage"> | null;
  cacheTelemetry: () => Pick<CacheTelemetry, "sessionModels"> | null;
  /** The harness session's agent id, or null when the session does not exist. Must not throw. */
  sessionAgent: (sessionId: string) => string | null;
}

interface Params { window?: "24h" | "7d"; agentId?: string; sessionId?: string }

export function buildTelemetryMethods(d: TelemetrySurfaceDeps): Record<string, Handler> {
  return {
    "telemetry.cache.summary": async (raw) => {
      const p = (raw ?? {}) as Params;
      const window = p.window ?? "24h";
      const until = d.clock();
      const since = until - (window === "7d" ? 604_800_000 : 86_400_000);
      const budget = d.budget();
      if (!budget) throw new RpcError("E_NOT_AVAILABLE", "budget ledger unavailable", { reason: "budget-unavailable" });
      let providers;
      try {
        providers = budget.cacheUsage({ since, until, ...(p.agentId !== undefined ? { agentId: p.agentId } : {}) });
      } catch (e) {
        if (e instanceof BudgetInputError) throw new RpcError("E_INVALID_PARAMS", "invalid telemetry window", { reason: "invalid-window" });
        throw new RpcError("E_INTERNAL", "cache usage unavailable");
      }
      let session = null;
      if (p.sessionId !== undefined) {
        const agent = d.sessionAgent(p.sessionId);
        if (agent === null) throw new RpcError("E_NOT_FOUND", "session not found", { reason: "session-not-found" });
        if (p.agentId !== undefined && p.agentId !== agent) throw new RpcError("E_INVALID_PARAMS", "agentId does not match the session's agent", { reason: "agent-session-mismatch" });
        const models = (d.cacheTelemetry()?.sessionModels(agent, p.sessionId) ?? []).map(({ model, summary: s }) => ({
          model, turns: s.turns, inputTokens: s.inputTokens, cacheReadTokens: s.cacheReadTokens, cacheCreationTokens: s.cacheCreationTokens,
          totalInputTokens: s.totalInputTokens, hitRatio: s.hitRatio, hits: s.hits, misses: s.misses, notCacheable: s.notCacheable, missCauses: { ...s.missCauses },
        }));
        session = { sessionId: p.sessionId, agentId: agent, models };
      }
      return { window, since: new Date(since).toISOString(), until: new Date(until).toISOString(), providers, session };
    },
  };
}
