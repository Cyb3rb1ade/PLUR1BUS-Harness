// The re-embedding run's view of the call budget (L8 `createCallBudget`): before each batch of a cloud target its estimated
// input tokens are reserved under the principal/agent/project `memory-reembed`; a hard token limit pauses the run.
// Settled with the estimate after the batch: the engine reports no usage. There is no money dimension (owner 2026-10-19).
import type { CallBudget } from "../budget/index.ts";
import type { BatchBudget } from "./driver.ts";

export const REEMBED_BUDGET_ID = "memory-reembed";

export function reembedBatchBudget(budget: Pick<CallBudget, "checkBeforeCall" | "settle" | "releaseUnused">): BatchBudget {
  return {
    admit({ provider, model, estimatedTokens }) {
      const id = (v: string) => (/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$/.test(v) ? v : "unknown");
      const decision = budget.checkBeforeCall({ principal: REEMBED_BUDGET_ID, agent: REEMBED_BUDGET_ID, project: REEMBED_BUDGET_ID, model: id(model), provider: id(provider), estimatedInputTokens: estimatedTokens, maxOutputTokens: 0 });
      if (decision.kind === "refuse") {
        const what = `${decision.scope} ${decision.metric} limit ${decision.limit} reached (used ${decision.used})`;
        return { ok: false, message: what };
      }
      let done = false;
      return { ok: true, ticket: {
        settle(tokens) { if (done) return; done = true; budget.settle(decision.reservationId, { inputTokens: tokens, outputTokens: 0 }); },
        release() { if (done) return; done = true; budget.releaseUnused(decision.reservationId); },
      } };
    },
  };
}
