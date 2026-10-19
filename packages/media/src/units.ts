import { validateRequest } from './types.ts';
import type { ImageRequest } from './types.ts';
import type { Manifest } from './store.ts';
/** A generation's usage in its native unit: images, or seconds of video. There is no money dimension (owner decision 2026-10-19). */
export interface MediaUnits { unit: 'image' | 'videoSecond'; quantity: number }
/** What a request asks for: `n` images (default 1) or `durationSeconds` of video (default 8). */
export function requestedUnits(req: ImageRequest): MediaUnits {
  validateRequest(req);
  return req.kind === 'video' ? { unit: 'videoSecond', quantity: req.durationSeconds ?? 8 } : { unit: 'image', quantity: req.n ?? 1 };
}
/** What a stored output holds: its image count, or the summed video seconds (the requested duration where a file has none). */
export function deliveredUnits(req: ImageRequest, output: Pick<Manifest, 'files'>): MediaUnits {
  return req.kind === 'video'
    ? { unit: 'videoSecond', quantity: output.files.reduce((n, f) => n + (f.durationSeconds ?? req.durationSeconds ?? 8), 0) }
    : { unit: 'image', quantity: output.files.length };
}
/** Implementations must reserve atomically and settle idempotently by job ID; `null` settles a job that delivered nothing. */
export interface BudgetPort { reserve(jobId: string, units: MediaUnits): Promise<void>; settle(jobId: string, delivered: MediaUnits | null): Promise<void> }
