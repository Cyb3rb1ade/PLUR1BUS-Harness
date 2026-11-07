import { SensitivityScanner } from '../../memory-sensitivity/scanner.ts';
import { digest } from './selection.ts';
import type { LearnStore } from './store.ts';
import { PROMPT_VERSION, type Finding, type Target, type Tier } from './types.ts';

export const CALIBRATION_POLICY = Object.freeze({ version: 1, minimumDecisions: 50, precisionGate: 0.95, scoreA: 0.8, scoreB: 0.9 });
const scanner = new SensitivityScanner();
export function instructionLike(text: string): boolean {
  return /\b(always|never|must|ignore|remember|instructions?|system prompt|immer|niemals|nie|musst|muss|ignoriere|speichere|anweisungen?|merke)\b/iu.test(text);
}
export interface FindingSafety { personAuthored: boolean; sensitive: boolean; targetVerified: boolean }
/** Counterfactual tier, not permission. The shadow executor always retains effectiveTier C. */
export function scoreFinding(finding: Finding, safety: FindingSafety): Finding {
  const p = finding.prevalence, trusted = finding.evidence.some(e => e.trust === 'person' || e.trust === 'verified') || finding.verify === 'supported';
  const person = finding.evidence.some(e => e.trust === 'person');
  let score = trusted ? Math.min(1, (person ? 0.35 : 0.25) + 0.3 * Math.min(p.sessions / 3, 1) + 0.2 * Math.min(p.days / 2, 1) +
    (Math.max(p.agents, p.persons) >= 2 ? 0.05 : 0) + (finding.verify === 'supported' ? 0.05 : 0) + (finding.agreement === 'agrees' ? 0.05 : 0) +
    (['add', 'duplicate', 'stale'].includes(finding.change) ? 0.05 : 0)) : 0;
  if ((finding.verify === 'contradicted' && finding.change !== 'stale') || finding.agreement === 'contradicts') score = Math.min(score, 0.2);
  score = Math.round(score * 1000) / 1000;
  const manual = !safety.targetVerified || safety.personAuthored || safety.sensitive || scanner.scan(finding.text).length > 0 ||
    instructionLike(finding.text) || finding.kind === 'procedural' || finding.change === 'retire' ||
    (finding.change === 'duplicate' && finding.agreement !== 'agrees') || (finding.change === 'stale' && finding.verify !== 'contradicted');
  let desiredTier: Tier = 'C';
  if (!manual && trusted) {
    if (finding.target.scope === 'agent' && ['add', 'duplicate', 'stale'].includes(finding.change) && score >= CALIBRATION_POLICY.scoreA && p.sessions >= 3 && p.days >= 2) desiredTier = 'A';
    if (finding.target.scope === 'project' && score >= CALIBRATION_POLICY.scoreB && Math.max(p.agents, p.persons) >= 2) desiredTier = 'B';
  }
  return { ...finding, score, desiredTier, effectiveTier: 'C' };
}
export type GateReason = 'shadow-incomplete' | 'precision-below-gate' | 'revert-unavailable';
export interface Precision { accepted: number; decided: number; precision: number | null; allowed: false; reason: GateReason }
export function precisionGate(accepted: number, decided: number): Precision {
  const precision = decided ? accepted / decided : null;
  return { accepted, decided, precision, allowed: false, reason: decided < CALIBRATION_POLICY.minimumDecisions ? 'shadow-incomplete' : precision! < CALIBRATION_POLICY.precisionGate ? 'precision-below-gate' : 'revert-unavailable' };
}
export function calibration(store: LearnStore, target: Target, models: readonly string[]) {
  const modelIds = [...new Set(models)].sort();
  const revision = digest([PROMPT_VERSION, modelIds, CALIBRATION_POLICY]);
  const counts = { A: { accepted: 0, decided: 0 }, B: { accepted: 0, decided: 0 } };
  for (const run of store.runs(target.owner).filter(r => digest(r.target) === digest(target) && r.outcome === 'completed')) {
    for (const decision of store.decisions(run.id)) {
      const finding = store.finding(decision.findingId);
      if (!finding || finding.kind !== 'knowledge' || finding.desiredTier === 'C' || finding.promptVersion !== PROMPT_VERSION || JSON.stringify([...finding.models].sort()) !== JSON.stringify(modelIds)) continue;
      const count = counts[finding.desiredTier]; count.decided++; if (decision.outcome === 'accepted') count.accepted++;
    }
  }
  return { version: 1, revision, promptVersion: PROMPT_VERSION, models: modelIds, thresholds: CALIBRATION_POLICY,
    A: precisionGate(counts.A.accepted, counts.A.decided), B: precisionGate(counts.B.accepted, counts.B.decided) };
}
