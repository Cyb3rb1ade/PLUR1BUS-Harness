// Batch planning (G2): split inputs by item count and an estimated token budget, never reorder, refuse an input that
// can never fit before any request is sent. The estimate is a guard against obviously oversized input; the provider's
// own 413/400 (mapped to too_large) remains the authority for borderline cases.
import { AdapterError } from "./errors.ts";

/** About four ASCII characters or 1.5 other characters per token, counted per code point. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

export interface BatchLimits {
  maxBatch: number;
  maxInputTokens: number;
  /** Optional ceiling on the summed estimate of one batch. */
  maxBatchTokens?: number;
  provider?: string;
}

/** Index groups in input order; concatenated they are exactly 0..n-1. */
export function planBatches(texts: readonly string[], limits: BatchLimits): number[][] {
  const { maxBatch, maxInputTokens, maxBatchTokens } = limits;
  const ctx = limits.provider !== undefined ? { provider: limits.provider } : {};
  if (!Number.isInteger(maxBatch) || maxBatch < 1) throw new AdapterError("invalid_request", `maxBatch must be a positive integer, got ${String(maxBatch)}`, ctx);

  const batches: number[][] = [];
  let current: number[] = [];
  let currentTokens = 0;
  texts.forEach((text, i) => {
    const tokens = estimateTokens(text);
    if (tokens > maxInputTokens) {
      throw new AdapterError("too_large", `input ${i} is about ${tokens} tokens, over the limit of ${maxInputTokens}`, ctx);
    }
    const countFull = current.length >= maxBatch;
    const tokensFull = maxBatchTokens !== undefined && current.length > 0 && currentTokens + tokens > maxBatchTokens;
    if (countFull || tokensFull) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(i);
    currentTokens += tokens;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}
