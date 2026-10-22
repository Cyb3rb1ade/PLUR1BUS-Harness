import type { HarnessConfig } from '@plur1bus/config-schema';
import type { ChatRequest } from '../session/provider.ts';
export type DecisionBackendName = 'role' | 'laya' | 'kev' | 'jev';
export type DecisionUseCase = 'triage' | 'routing' | 'pruning' | 'skills' | 'placement' | 'zoom' | 'compaction';
export type DecisionPrimitive = 'noul' | 'choice' | 'score' | 'triage-compat';
export type DecisionFailure = 'unavailable' | 'timeout' | 'invalid' | 'low-confidence' | 'privacy' | 'cancelled';
export interface DecisionContext {
  agentId: string; sessionId?: string; turnId?: string; principal?: string; signal: AbortSignal;
  locale?: string; deadline?: number; forceLocal?: boolean;
  /** Trusted content admission, never read from RPC/tool params. Cloud System One defaults to denied. */
  cloudEligible?: boolean;
  /** Trusted caller context for the existing router, never serialized to a backend. */
  chat?: ChatRequest;
}
export interface DecisionInput { useCase: DecisionUseCase; state: string; question: string; features?: Record<string, string | number | boolean> }
export interface ChoiceInput extends DecisionInput { options: readonly { id: string; description: string }[] }
export interface ScoreInput extends DecisionInput { levels: readonly string[] }
export interface DecisionRequest extends DecisionInput {
  requestId: string; primitive: DecisionPrimitive; deadline: number; context: DecisionContext;
  options?: ChoiceInput['options']; levels?: ScoreInput['levels'];
}
/** Backend port: store independent, one shared monotonic deadline, finite normalized JSON answers.
 * A native backend must independently prove hardware/locale eligibility before auto selection. */
export interface DecisionBackend {
  local(context: DecisionContext): boolean | undefined;
  eligible?(context: DecisionContext): boolean;
  run(request: DecisionRequest, signal: AbortSignal): Promise<unknown>;
}
export interface DecisionSuccess<T> { ok: true; requestId: string; backend: DecisionBackendName; elapsedMs: number; modelRevision?: string; value: T; confidence: number; confidenceSource: 'derived' | 'backend' | 'uncalibrated'; reasonCode: 'accepted' }
export interface DecisionError { ok: false; requestId: string; elapsedMs: number; reason: DecisionFailure; attempted: DecisionBackendName[] }
export type DecisionResult<T> = DecisionSuccess<T> | DecisionError;
export interface DecisionEvent { requestId: string; primitive: DecisionPrimitive; useCase: DecisionUseCase; backend?: DecisionBackendName; modelRevision?: string; attempted: DecisionBackendName[]; elapsedMs: number; outcome: 'accepted' | DecisionFailure; confidence?: number; confidenceSource?: 'derived' | 'backend' | 'uncalibrated'; reasonCode: string }
export interface DecisionOptions { config(): HarnessConfig; backends: Partial<Record<DecisionBackendName, DecisionBackend>>; emit?(context: DecisionContext, event: DecisionEvent): void }
export class DecisionBackendError extends Error { readonly reason: DecisionFailure; constructor(reason: DecisionFailure) { super(reason); this.reason = reason; } }
