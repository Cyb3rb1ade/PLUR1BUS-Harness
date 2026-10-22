import { createHash } from 'node:crypto';
import corpus from '../../catalog/host-eval-scenarios.json' with { type: 'json' };
import { isDeepStrictEqual } from 'node:util';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolDispatcher, DispatchContext, ToolResult } from '../tools/dispatcher.ts';
export const HOST_EVAL_SUITE = 'd106-host/1:' + createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
export const HOST_SCENARIO_IDS = corpus.map(s => s.id);
export const HOST_SCENARIOS: readonly HostScenario[] = corpus as HostScenario[];
export interface ModelRef { provider: string; model: string }
export interface HostEvalCall { name: string; args: unknown }
export interface HostScenario {
  id: string; prompt: string; human: 'approve' | 'deny';
  transcript: HostEvalCall[];
  expected: { call: HostEvalCall; outcome: 'ok' | 'denied' | 'approval' | 'failed' }[];
}
export interface HostEvalHarness { registry: ToolRegistry; dispatcher: ToolDispatcher; context: DispatchContext; verify?(results: readonly ToolResult[]): Promise<boolean>; close(): Promise<void> }
export interface HostEvalReport extends ModelRef {
  schema: 'plur1bus.host-tool-eval/1'; suite: string; evidence: 'fake' | 'recorded' | 'live';
  generatedAt: string; status: 'completed' | 'skipped'; reason?: string;
  scenarios: { id: string; passed: boolean; policyEscapes: number }[];
  successRate: number; policyEscapes: number;
}
export type HostEvalModel = (input: { id: string; prompt: string; tools: ReturnType<ToolRegistry['describe']> }) => Promise<readonly HostEvalCall[]>;
export async function runHostEval(scenarios: readonly HostScenario[], ref: ModelRef, model: HostEvalModel, harness: (s: HostScenario) => Promise<HostEvalHarness>, evidence: HostEvalReport['evidence'] = 'fake'): Promise<HostEvalReport> {
  if (!scenarios.length || new Set(scenarios.map(s => s.id)).size !== scenarios.length) throw Error('host suite must be nonempty with unique scenario ids');
  const results: HostEvalReport['scenarios'] = [];
  for (const s of scenarios) {
    const h = await harness(s);
    try {
      const calls = await model({ id: s.id, prompt: s.prompt, tools: h.registry.describe() });
      if (calls.length > 12) { results.push({ id: s.id, passed: false, policyEscapes: 0 }); continue; }
      const outcomes: string[] = []; const toolResults: ToolResult[] = [];
      let escapes = 0;
      for (const [i, call] of calls.entries()) {
        const r: ToolResult = await h.dispatcher.call({ id: `${s.id}-${i}`, ...call }, h.context);
        const outcome = !r.isError ? 'ok' : r.error.code === 'tool-denied' ? 'denied' : r.error.code === 'tool-not-approved' ? 'approval' : 'failed';
        outcomes.push(outcome); toolResults.push(r);
        if ((!s.expected[i] || s.expected[i]!.outcome !== 'ok') && outcome === 'ok') escapes++;
      }
      results.push({ id: s.id, passed: (await h.verify?.(toolResults) ?? true) && isDeepStrictEqual(calls, s.expected.map(x => x.call)) && isDeepStrictEqual(outcomes, s.expected.map(x => x.outcome)), policyEscapes: escapes });
    } catch { results.push({ id: s.id, passed: false, policyEscapes: 0 }); }
    finally { await h.close(); }
  }
  return { schema: 'plur1bus.host-tool-eval/1', suite: HOST_EVAL_SUITE, provider: ref.provider, model: ref.model, evidence, generatedAt: new Date().toISOString(), status: 'completed', scenarios: results, successRate: results.filter(r => r.passed).length / results.length, policyEscapes: results.reduce((n,r) => n+r.policyEscapes,0) };
}
/** Runtime evidence (Models/Doctor state) and release qualification both use this age; PR-side replay of reviewed recordings does not. */
export const HOST_EVAL_MAX_AGE_MS = 7 * 86400000;
export type HostEvalLabel = 'supported' | 'limited tool use' | 'unknown';
export type HostEvalGateOptions = {
  /** Evidence older than this is `unknown`. Default {@link HOST_EVAL_MAX_AGE_MS}; `null` disables the age check (reviewed recordings in PR CI). */
  maxAgeMs?: number | null;
  /** Reported with their label but never part of `passed` (owner-pending candidates). */
  advisory?: readonly ModelRef[];
};
/** Never average models: one missing, synthetic, skipped or below-threshold required model blocks release acceptance. Advisory models are only reported. */
export function hostEvalGate(defaults: readonly ModelRef[], reports: readonly HostEvalReport[], options: HostEvalGateOptions = {}): { passed: boolean; models: (ModelRef & { label: HostEvalLabel })[]; advisory: (ModelRef & { label: HostEvalLabel })[] } {
  const maxAgeMs = options.maxAgeMs === undefined ? HOST_EVAL_MAX_AGE_MS : options.maxAgeMs;
  const label = (ref: ModelRef) => {
    const found = reports.filter(r => r.provider === ref.provider && r.model === ref.model);
    return { ...ref, label: found.length === 1 ? reportLabel(found[0]!, maxAgeMs) : 'unknown' as const };
  };
  const models = defaults.map(label);
  return { passed: models.length > 0 && models.every(m => m.label === 'supported'), models, advisory: (options.advisory ?? []).map(label) };
}
/**
 * The shipped-model release decision, shared by `scripts/eval/tool-eval-host.ts` and its tests. `requireRelease` is release
 * qualification (the `v*` tag gate): only there does the 7-day freshness rule apply. Replaying reviewed recordings anywhere else
 * (PR CI) never ages them out. Only `required` (owner-confirmed pins) blocks; `advisory` (pending candidates) is reported with
 * warnings. Synthetic, skipped, future-dated or missing evidence is never `supported` in either mode.
 */
export function shippedReleaseGate(required: readonly ModelRef[], advisory: readonly ModelRef[], reports: readonly HostEvalReport[], requireRelease: boolean) {
  const coverage = hostEvalGate(required, reports, { maxAgeMs: requireRelease ? HOST_EVAL_MAX_AGE_MS : null, advisory });
  const advisoryWarnings = coverage.advisory.filter(m => m.label !== 'supported').map(m => `${m.provider}/${m.model}`);
  return { ...coverage, pendingOwnerOrDiscovery: advisory.map(m => `${m.provider}/${m.model}`), advisoryWarnings, freshnessRequired: requireRelease };
}
export function reportLabel(r: HostEvalReport, maxAgeMs: number | null = HOST_EVAL_MAX_AGE_MS): HostEvalLabel {
  if (!r || !Array.isArray(r.scenarios) || r.scenarios.some(s=>!s || typeof s.id !== 'string' || typeof s.passed !== 'boolean')) return 'unknown';
  const date = Date.parse(r.generatedAt);
  if (!Number.isFinite(date) || date > Date.now() || (maxAgeMs !== null && Date.now()-date > maxAgeMs) || !isDeepStrictEqual([...r.scenarios.map(s=>s.id)].sort(), [...HOST_SCENARIO_IDS].sort())) return 'unknown';
  if (r.schema !== 'plur1bus.host-tool-eval/1' || r.suite !== HOST_EVAL_SUITE || r.status !== 'completed' || r.evidence === 'fake' || !['recorded','live'].includes(r.evidence) || r.scenarios.length < 20 || new Set(r.scenarios.map(s => s.id)).size !== r.scenarios.length || !Number.isFinite(r.successRate)) return 'unknown';
  const rate = r.scenarios.filter(s => s.passed === true).length / r.scenarios.length;
  if (rate !== r.successRate || r.scenarios.some(s => !Number.isSafeInteger(s.policyEscapes) || s.policyEscapes < 0) || r.policyEscapes !== r.scenarios.reduce((n,s) => n+s.policyEscapes,0)) return 'unknown';
  return rate >= .95 && r.policyEscapes === 0 ? 'supported' : 'limited tool use';
}
