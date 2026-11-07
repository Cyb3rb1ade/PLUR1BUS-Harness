import type { LearnModelResult, Stage } from './model.ts';
import { LearnError, LIMITS, type Finding, type Transcript, type Verdict } from './types.ts';

export type ReviewCall = (stage: Stage, key: string, data: unknown) => Promise<LearnModelResult>;
function object(text: string): Record<string, unknown> {
  let value: unknown; try { value = JSON.parse(text); } catch { throw new LearnError('invalid-output'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LearnError('invalid-output');
  return value as Record<string, unknown>;
}
/** Only referenced rows from the authorized frozen selection are copied, never neighboring sessions or messages. */
export function evidenceView(finding: Finding, transcripts: readonly Transcript[]): { ref: Finding['evidence'][number]; excerpt: string }[] {
  return finding.evidence.map(ref => {
    const source = transcripts.find(t => t.session.id === ref.sessionId && t.session.owner === ref.owner && t.session.agentId === ref.agentId);
    const message = ref.source === 'message' ? source?.messages.find(m => m.id === ref.sourceId && m.turnId === ref.turnId) : undefined;
    const event = ref.source === 'event' ? source?.events.find(e => String(e.seq) === ref.sourceId && e.turnId === ref.turnId) : undefined;
    if (!message && !event) throw new LearnError('rights-changed');
    const excerpt = message?.text ?? JSON.stringify(event!.data);
    if (excerpt.length > LIMITS.text) throw new LearnError('source-unavailable');
    return { ref, excerpt };
  });
}
export async function refuteFinding(finding: Finding, transcripts: readonly Transcript[], call: ReviewCall): Promise<Finding> {
  if (finding.desiredTier === 'C') return finding;
  const result = await call('skeptic', finding.id, {
    finding: { text: finding.text, change: finding.change }, evidence: evidenceView(finding, transcripts), verify: finding.verify,
  });
  const value = object(result.text);
  if (Object.keys(value).length !== 1 || !['holds', 'refuted', 'insufficient'].includes(String(value.verdict))) throw new LearnError('invalid-output');
  // Shadow ruling: preserve even refuted findings; the UI folds them. Nothing is automatically applied.
  return { ...finding, skeptic: value.verdict as Verdict, effectiveTier: 'C', models: [...new Set([...finding.models, result.model])].sort() };
}
export async function wordFinding(finding: Finding, call: ReviewCall): Promise<Finding> {
  const result = await call('wording', finding.id, { text: finding.text, change: finding.change, verify: finding.verify, skeptic: finding.skeptic });
  const value = object(result.text);
  if (Object.keys(value).length !== 1 || typeof value.text !== 'string' || !value.text.trim() || value.text.length > LIMITS.text) throw new LearnError('invalid-output');
  return { ...finding, text: value.text.trim(), models: [...new Set([...finding.models, result.model])].sort() };
}
