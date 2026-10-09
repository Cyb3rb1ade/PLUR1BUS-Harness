import table from './prices.json' with { type: 'json' };
import { validateRequest } from './types.ts';
import type { ImageRequest } from './types.ts';
export interface CostEstimate { usd: number | null; asOf: string; currency: 'USD'; disclaimer: string }
export function estimateCost(req: ImageRequest, adapter: { id: string; model?: string }): CostEstimate {
  validateRequest(req);
  const prices: Record<string, number> = table.perImage;
  const price = ['draw-things', 'coreml-local'].includes(adapter.id) ? 0 : prices[`${adapter.id}:${adapter.model}`];
  return { usd: price === undefined ? null : price * (req.n ?? 1), asOf: table.asOf, currency: 'USD', disclaimer: table.disclaimer };
}
/** Implementations must reserve atomically and settle/release idempotently by job ID. Unknown estimates must be explicitly handled. */
export interface BudgetPort { reserve(jobId: string, estimate: CostEstimate): Promise<void>; settle(jobId: string, actualUsd: number | null): Promise<void> }
