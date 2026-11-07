import { readFileSync } from 'node:fs';
import { LearnError, type Target } from './types.ts';

export type Stage = 'extract' | 'skeptic' | 'wording';
export interface LearnModelRequest { target: Target; stage: Stage; modelClass: 'small' | 'medium' | 'large'; instructions: string; data: string; maxOutputTokens: number; signal: AbortSignal }
export interface LearnModelResult { text: string; model: string; inputTokens: number; outputTokens: number }
export interface LearnModel { complete(request: LearnModelRequest): Promise<LearnModelResult> }
export function prompt(stage: Stage): string { return readFileSync(new URL(`./prompts/${stage}.md`, import.meta.url), 'utf8'); }
export function usage(result: LearnModelResult): number {
  if (!result.model || !Number.isSafeInteger(result.inputTokens) || !Number.isSafeInteger(result.outputTokens) || result.inputTokens < 0 || result.outputTokens < 0) throw new LearnError('provider-failed');
  return result.inputTokens + result.outputTokens;
}
