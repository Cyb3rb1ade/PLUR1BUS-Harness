import type { Principal } from '../../rbac/types.ts';
import type { SessionRecord, MessageRecord, EventRecord } from '../../session/types.ts';

export type LearnScope = 'agent' | 'project' | 'installation';
export type Tier = 'A' | 'B' | 'C';
export type Change = 'add' | 'correct' | 'duplicate' | 'stale' | 'retire';
export type Verdict = 'holds' | 'refuted' | 'insufficient' | 'not-required';
export type Trust = 'person' | 'verified' | 'agent' | 'untrusted';
export interface Target { scope: LearnScope; owner: string; agentId: string; projectId?: string }
export interface Window { from: number; to: number }
export interface LearnConfig { enabled: boolean; windowDays: number; maxSessions: number; maxTokens: number; focus: string }
export const DEFAULT_LEARN_CONFIG: Readonly<LearnConfig> = Object.freeze({ enabled: false, windowDays: 7, maxSessions: 50, maxTokens: 100_000, focus: '' });
export const LIMITS = Object.freeze({ sessions: 50, messages: 2000, events: 4000, bytes: 262_144, findings: 100, text: 4000, evidence: 100, failures: 3 });
export const PROMPT_VERSION = 'learn-1';
export interface Transcript { session: SessionRecord; messages: MessageRecord[]; events: EventRecord[]; days: string[] }
export interface Evidence { sessionId: string; turnId: string; sourceId: string; source: 'message' | 'event'; trust: Trust; day: string; agentId: string; owner: string }
export interface VerificationRequest { path: string; contains: string }
export interface RawFinding { kind: 'knowledge' | 'procedural'; change: Change; text: string; memoryId?: string; evidence: Evidence[]; checks?: VerificationRequest[] }
export interface Finding extends RawFinding {
  id: string; runId: string; target: Target; prevalence: { sessions: number; total: number; days: number; agents: number; persons: number };
  verify: 'supported' | 'contradicted' | 'unknown' | 'not-applicable'; agreement: 'agrees' | 'contradicts' | 'unknown';
  score: number; desiredTier: Tier; effectiveTier: 'C'; skeptic: Verdict;
  models: string[]; promptVersion: string; status: 'pending' | 'accepted' | 'rejected' | 'waiting-h3';
}
export type Reason = 'disabled' | 'no-sessions' | 'budget' | 'breaker-open' | 'no-model' | 'local-only' | 'source-unavailable' | 'invalid-output' | 'provider-failed' | 'rights-changed' | 'interrupted';
export interface LearnRun { id: string; target: Target; window: Window; sessionIds: string[]; digest: string; startedAt: number; finishedAt: number | null; outcome: 'completed' | 'skipped' | 'failed' | null; reason: Reason | null; tokens: number; findings: number }
export interface SelectionSource {
  sessions(target: Target, window: Window, limit: number): SessionRecord[];
  transcript(session: SessionRecord, window: Window): Transcript;
  mayRead(target: Target, session: SessionRecord, principal: Principal): boolean;
}
export class LearnError extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) { super(reason); this.name = 'LearnError'; this.reason = reason; }
}
