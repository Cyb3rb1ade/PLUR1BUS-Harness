import { digest } from './selection.ts';
import { LearnError, LIMITS, PROMPT_VERSION, type Evidence, type Finding, type RawFinding, type Target, type Transcript } from './types.ts';

const normalized = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const evidenceKey = (e: Evidence) => JSON.stringify([e.sessionId, e.source, e.sourceId]);
export function parseExtraction(text: string, transcript: Transcript): RawFinding[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new LearnError('invalid-output'); }
  if (!Array.isArray(value) || value.length > 10) throw new LearnError('invalid-output');
  return value.map((input: unknown): RawFinding => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LearnError('invalid-output');
    const f = input as Record<string, unknown>;
    if (Object.keys(f).some(k => !['kind', 'change', 'text', 'memoryId', 'evidence', 'checks'].includes(k)) ||
      !['knowledge', 'procedural'].includes(String(f.kind)) || !['add', 'correct', 'duplicate', 'stale', 'retire'].includes(String(f.change)) ||
      typeof f.text !== 'string' || !f.text.trim() || f.text.length > LIMITS.text ||
      (f.memoryId !== undefined && (typeof f.memoryId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(f.memoryId))) ||
      !Array.isArray(f.evidence) || !f.evidence.length || f.evidence.length > LIMITS.evidence) throw new LearnError('invalid-output');
    const evidence = f.evidence.map((ref: unknown): Evidence => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new LearnError('invalid-output');
      const r = ref as Record<string, unknown>;
      if (Object.keys(r).some(k => !['source', 'id'].includes(k)) || !['message', 'event'].includes(String(r.source)) || typeof r.id !== 'string') throw new LearnError('invalid-output');
      const message = r.source === 'message' ? transcript.messages.find(m => m.id === r.id) : undefined;
      const event = r.source === 'event' ? transcript.events.find(e => String(e.seq) === r.id) : undefined;
      const turnId = message?.turnId ?? event?.turnId;
      if (!turnId || (!message && !event)) throw new LearnError('invalid-output');
      // Model output never supplies trust. Channel/peer text and all tool output are untrusted.
      const trust = message?.role === 'user' && !transcript.session.origin && transcript.session.kind !== 'channel' ? 'person' : message?.role === 'assistant' ? 'agent' : 'untrusted';
      return { sessionId: transcript.session.id, turnId, sourceId: r.id, source: r.source as Evidence['source'], trust,
        day: new Date(message?.createdAt ?? event!.at).toISOString().slice(0, 10), agentId: transcript.session.agentId, owner: transcript.session.owner };
    });
    if (f.checks !== undefined && (!Array.isArray(f.checks) || f.checks.length > 8 || f.checks.some(c => !c || typeof c !== 'object' || Object.keys(c).some(k => !['path', 'contains'].includes(k)) || typeof c.path !== 'string' || c.path.length > 256 || typeof c.contains !== 'string' || !c.contains || c.contains.length > 1000))) throw new LearnError('invalid-output');
    return { kind: f.kind as RawFinding['kind'], change: f.change as RawFinding['change'], text: f.text.trim(), ...(typeof f.memoryId === 'string' ? { memoryId: f.memoryId } : {}), evidence, ...(f.checks ? { checks: f.checks as RawFinding['checks'] } : {}) };
  });
}
/** Exact normalized-key clustering: deterministic and inspectable; no model confidence or fuzzy judge. */
export function aggregate(raw: readonly RawFinding[], target: Target, runId: string, total: number): Finding[] {
  const groups = new Map<string, RawFinding[]>();
  for (const f of raw) { const key = JSON.stringify([f.kind, f.change, f.memoryId ?? null, normalized(f.text)]); const group = groups.get(key) ?? []; group.push(f); groups.set(key, group); }
  if (groups.size > LIMITS.findings) throw new LearnError('invalid-output');
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const first = [...group].sort((a, b) => a.text.localeCompare(b.text))[0]!;
    const evidence = [...new Map(group.flatMap(f => f.evidence).sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b))).map(e => [evidenceKey(e), e])).values()];
    const checks = [...new Map(group.flatMap(f => f.checks ?? []).map(c => [JSON.stringify([c.path, c.contains]), c])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
    return { ...first, ...(checks.length ? { checks } : {}), evidence, id: digest([runId, key]), runId, target,
      prevalence: { sessions: new Set(evidence.map(e => e.sessionId)).size, total, days: new Set(evidence.map(e => e.day)).size, agents: new Set(evidence.map(e => e.agentId)).size, persons: new Set(evidence.map(e => e.owner)).size },
      verify: target.scope === 'project' ? 'unknown' : 'not-applicable', agreement: 'unknown', score: 0, desiredTier: 'C', effectiveTier: 'C', skeptic: 'not-required',
      models: [], promptVersion: PROMPT_VERSION, status: first.kind === 'procedural' ? 'waiting-h3' : 'pending' } satisfies Finding;
  }).sort((a, b) => b.prevalence.sessions - a.prevalence.sessions || a.id.localeCompare(b.id));
}
