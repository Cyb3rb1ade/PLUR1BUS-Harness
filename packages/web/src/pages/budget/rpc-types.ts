// Wire types of budget.status and budget.set (docs/rpc.md, M2 L8, ADR-010 §4), merged into the typed client. Documented
// shapes only. Bounds count tokens (input + output), generated images or video seconds; there is no money dimension
// (owner decisions 2026-10-19).

export type BudgetMetric = "tokens" | "images" | "videoSeconds";
export type BudgetPeriodName = "day" | "month";
export type BudgetScope = "global" | "agent";

export type BudgetLimit = { scope: BudgetScope; agentId?: string; period: BudgetPeriodName; metric: BudgetMetric; soft: number | null; hard: number | null };
export type BudgetLimitState = BudgetLimit & { used: number; state: "ok" | "soft" | "hard" };

/** `images`/`videoSeconds` are absent from an older core; the page reads them as 0. */
export type UsageTotals = { events: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; images: number; videoSeconds: number };
export type BudgetPeriod = {
  period: BudgetPeriodName; key: string; start: string; end: string; total: UsageTotals;
  agents: { agentId: string; total: UsageTotals; models: (UsageTotals & { model: string })[] }[];
};
export type BudgetStatusResult = { timeZone: string; now: string; periods: BudgetPeriod[]; limits: BudgetLimitState[] };

export type BudgetSetParams = {
  limit?: { scope: BudgetScope; agentId?: string; period: BudgetPeriodName; metric: BudgetMetric; soft?: number | null; hard?: number | null };
  timeZone?: string;
};
export type BudgetSetResult = { timeZone: string; limit?: BudgetLimit | null; limits: BudgetLimit[] };

declare module "../../api/index.ts" {
  interface RpcMethods {
    "budget.status": { params: { agentId?: string } | undefined; result: BudgetStatusResult };
    "budget.set": { params: BudgetSetParams; result: BudgetSetResult };
  }
}
