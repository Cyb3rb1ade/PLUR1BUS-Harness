import table from './prices.json' with { type: 'json' };
import { validateRequest } from './types.ts';
import type { ImageRequest } from './types.ts';
export interface CostEstimate { usd: number | null; asOf: string; currency: 'USD'; disclaimer: string; unit?: 'image' | 'videoSecond'; quantity?: number }
export function estimateCost(req: ImageRequest, adapter: { id: string; model?: string; capabilities?: () => {video?: {model?: string}} }): CostEstimate {
  validateRequest(req);
  const video = req.kind === 'video';
  const prices: Record<string, number> = video ? table.perVideoSecond : table.perImage;
  const model = video ? adapter.capabilities?.().video?.model ?? adapter.model : adapter.model;
  const price = ['draw-things', 'coreml-local'].includes(adapter.id) ? 0 : (video ? prices[`${adapter.id}:${model}:${req.resolution ?? 'default'}`] : prices[`${adapter.id}:${model}`]);
  return { usd: price === undefined ? null : price * (video ? req.durationSeconds ?? 8 : req.n ?? 1), asOf: table.asOf, currency: 'USD', disclaimer: table.disclaimer, ...(video ? { unit: 'videoSecond' as const, quantity: req.durationSeconds ?? 8 } : {}) };
}
/** Implementations must reserve atomically and settle/release idempotently by job ID. Unknown estimates must be explicitly handled. */
export interface BudgetPort { reserve(jobId: string, estimate: CostEstimate): Promise<void>; settle(jobId: string, actualUsd: number | null): Promise<void> }
