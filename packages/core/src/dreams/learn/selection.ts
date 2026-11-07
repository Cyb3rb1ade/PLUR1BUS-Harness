import { createHash } from 'node:crypto';
import { deriveUserPrincipal } from '../../identity/principals.ts';
import type { Principal } from '../../rbac/types.ts';
import { LIMITS, LearnError, type SelectionSource, type Target, type Transcript, type Window } from './types.ts';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const targetHash = (target: Target): string => digest([target.scope, target.owner, target.agentId, target.projectId ?? null]);
export function validateTarget(target: Target): void {
  if (!['agent', 'project', 'installation'].includes(target.scope) || !target.owner || !target.agentId ||
    [target.owner, target.agentId, target.projectId ?? ''].some(x => x.length > 128 || /[\x00-\x1f]/.test(x)) ||
    (target.scope === 'project') !== !!target.projectId) throw new LearnError('rights-changed');
}
/** The store query is bounded before content is loaded; every returned identity is independently rechecked. */
export function selectTranscripts(source: SelectionSource, target: Target, principal: Principal, window: Window, cap: number): Transcript[] {
  validateTarget(target);
  if (principal.kind !== 'person' || principal.userId !== target.owner || !Number.isSafeInteger(cap) || cap < 1 || cap > LIMITS.sessions ||
    !Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to) || window.from < 0 || window.to <= window.from) throw new LearnError('rights-changed');
  const owner = deriveUserPrincipal(target.owner);
  const sessions = source.sessions(target, window, cap + 1).filter(s => s.owner === owner && s.memoryMode === 'remember' &&
    (target.scope !== 'agent' || s.agentId === target.agentId) && (target.scope !== 'project' || s.scope === target.projectId) && source.mayRead(target, s, principal));
  // A deterministic cap is explicit in the selection; it does not cut a session's content.
  return [...sessions].sort((a, b) => a.id.localeCompare(b.id)).slice(0, cap).map(session => {
    const transcript = source.transcript(session, window);
    if (transcript.session.id !== session.id || transcript.session.owner !== owner ||
      transcript.messages.some(m => m.sessionId !== session.id) || transcript.events.some(e => e.sessionId !== session.id)) throw new LearnError('source-unavailable');
    if (transcript.messages.length > LIMITS.messages || transcript.events.length > LIMITS.events || Buffer.byteLength(JSON.stringify(transcript)) > LIMITS.bytes) throw new LearnError('transcript-cap');
    return transcript;
  }).filter(t => t.messages.length > 0 || t.events.length > 0);
}
export function selectionDigest(transcripts: readonly Transcript[]): string {
  return digest(transcripts.map(t => [t.session.id, t.messages, t.events]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
