import type { Principal } from '../../rbac/types.ts';
import { digest, targetHash } from './selection.ts';
import { LearnError, PROMPT_VERSION, type Evidence, type Finding, type SelectionSource, type Target, type Window } from './types.ts';

/** Installation scope never invokes transcript(), evidence(), a model, or MemoryOps. */
export function installationFindings(source: SelectionSource, target: Target, principal: Principal, window: Window, runId: string, maxSessions: number) {
  if (principal.kind !== 'person' || principal.role !== 'owner' || principal.userId !== target.owner) throw new LearnError('rights-changed');
  if (!source.toolErrors) throw new LearnError('source-unavailable');
  const rows = source.toolErrors(target, window);
  if (rows.length > 4000) throw new LearnError('transcript-cap');
  const allowed = rows.filter(r => { const s = source.session?.(r.sessionId); return !!s && source.mayRead(target, s, principal); });
  const allSessions = [...new Set(allowed.map(r => r.sessionId))], sessionIds = allSessions.slice(0, maxSessions);
  const selected = allowed.filter(r => sessionIds.includes(r.sessionId));
  const groups = new Map<string, typeof selected>();
  for (const row of selected) {
    const key = digest(row.metadata); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const findings: Finding[] = [...groups].sort(([a], [b]) => a.localeCompare(b)).slice(0, 100).map(([key, group]) => {
    const evidence: Evidence[] = group.map(r => { const s = source.session!(r.sessionId)!; return {
      sessionId: s.id, turnId: r.turnId, sourceId: String(r.seq), source: 'event', trust: 'untrusted',
      agentId: s.agentId, owner: s.owner, day: new Date(r.at).toISOString().slice(0, 10),
    }; });
    return { id: digest([targetHash(target), key]), runId, target, kind: 'procedural', change: 'add', contentKey: key,
      text: 'Tool failure pattern', evidence, toolPattern: { ...group[0]!.metadata, count: group.length, affectedAgents: [...new Set(evidence.map(e => e.agentId))].sort() },
      prevalence: { sessions: new Set(evidence.map(e => e.sessionId)).size, total: sessionIds.length, days: new Set(evidence.map(e => e.day)).size,
        agents: new Set(evidence.map(e => e.agentId)).size, persons: 1 }, verify: 'not-applicable', agreement: 'unknown',
      score: 0, desiredTier: 'C', effectiveTier: 'C', skeptic: 'not-required', models: [], modelClasses: [], promptVersion: PROMPT_VERSION, status: 'waiting-h3' };
  });
  return { findings, sessionIds, digest: digest(selected), truncated: allSessions.length > sessionIds.length || groups.size > 100, omittedSessions: allSessions.length - sessionIds.length };
}
