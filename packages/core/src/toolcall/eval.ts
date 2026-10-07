import { isDeepStrictEqual } from 'node:util';
import type { ToolCall, ToolDefinition } from '../../../providers/src/types.ts';
import { triage, type TriageTask, type ClassifierPort } from '../triage/index.ts';
import { MODEL_CLASSES, type ModelClass } from '../triage/classes.ts';
import { CapabilityIndex, type CapabilityEntry } from './capabilities.ts';
import { prepareCall, type ModelRepairPort } from './validation.ts';
import { compileDialect } from './dialects.ts';
import type { ProviderFamily } from './quirks.ts';
export interface EvalTool { entry: CapabilityEntry; definition: ToolDefinition; denied?: boolean; failure?: boolean }
export interface ExpectedCall { name: string; arguments?: unknown; outcome: 'ok' | 'tool-call-invalid' | 'tool-denied' | 'tool-failed' }
export interface EvalScenario {
  id: string; input: string; family: ProviderFamily; tools: EvalTool[];
  expected: { calls: ExpectedCall[]; tasks: { start: number; end: number; category: string; minimumClass: ModelClass }[]; needed: string[] };
  /** Fake model transcript is separate from expected outputs, including malformed arguments and retries. */
  transcript: { calls: ToolCall[]; repairs?: unknown[] }; tags: string[];
}
export interface EvalModelPort { calls(scenario: EvalScenario, offered: readonly string[]): Promise<ToolCall[]>; repair?: ModelRepairPort }
export interface ScenarioResult { id: string; passed: boolean; routingHits: number; routingTotal: number; segmentationMatches: number; predictedSegments: number; expectedSegments: number; underProvisioned: number; overProvisioned: number; classTotal: number; repairAttempts: number; repairSuccesses: number; errors: string[] }
export interface EvalReport { mode: 'fixture' | 'live'; status: 'completed' | 'skipped'; scenarios: ScenarioResult[]; metrics: { scenarioPassRate: number; routingRecall: number; repairSuccess: number; segmentationF1: number; underProvisioning: number; overProvisioning: number }; denominators: { scenarios: number; routing: number; repairs: number; tasks: number }; reason?: string }
export function fakeModel(scenario: EvalScenario): EvalModelPort {
  let retry = 0; return { async calls() { return structuredClone(scenario.transcript.calls); }, async repair() { return scenario.transcript.repairs?.[retry++]; } };
}
export async function runScenario(s: EvalScenario, model: EvalModelPort = fakeModel(s), classifier?: ClassifierPort): Promise<ScenarioResult> {
  const errors: string[] = []; const index = new CapabilityIndex();
  for (const tool of s.tools) { index.upsert(tool.entry); compileDialect(tool.definition, s.family); }
  const decision = triage(s.input, classifier ? { classifier } : {});
  const offered = new Set<string>();
  for (const task of decision.tasks) for (const hit of index.route(task.summary, task.categories, 12, task.confidence).items) offered.add(hit.entry.id);
  let matches = 0, under = 0, over = 0;
  for (const expected of s.expected.tasks) {
    const task = decision.tasks.find(t => t.start === expected.start && t.end === expected.end);
    if (task) { matches++; if (!Object.hasOwn(task.categories, expected.category)) errors.push('category mismatch'); const delta = MODEL_CLASSES.indexOf(task.chosenClass) - MODEL_CLASSES.indexOf(expected.minimumClass); if (delta < 0) under++; if (delta > 0) over++; }
    else under++;
  }
  const actual: ExpectedCall[] = []; let attempts = 0, successes = 0;
  for (const call of await model.calls(s, [...offered])) {
    const tool = s.tools.find(t => t.definition.name === call.name);
    if (!tool) { errors.push(`unknown tool:${call.name}`); continue; }
    const prepared = await prepareCall(call.name, tool.definition.parameters ?? {}, call.argumentsRaw, model.repair);
    attempts += prepared.repairRounds;
    if (prepared.ok && prepared.repairRounds) successes++;
    if (!prepared.ok) actual.push({ name: call.name, outcome: 'tool-call-invalid' });
    else actual.push({ name: call.name, arguments: prepared.arguments, outcome: tool.denied ? 'tool-denied' : tool.failure ? 'tool-failed' : 'ok' });
  }
  if (!isDeepStrictEqual(actual, s.expected.calls)) errors.push('calls or arguments mismatch');
  if (matches !== s.expected.tasks.length || decision.tasks.length !== s.expected.tasks.length) errors.push('segmentation mismatch');
  const routingHits = s.expected.needed.filter(id => offered.has(id)).length;
  if (routingHits !== s.expected.needed.length) errors.push('routing miss'); if (under) errors.push('under-provisioned');
  return { id: s.id, passed: !errors.length, routingHits, routingTotal: s.expected.needed.length, segmentationMatches: matches, predictedSegments: decision.tasks.length, expectedSegments: s.expected.tasks.length, underProvisioned: under, overProvisioned: over, classTotal: s.expected.tasks.length, repairAttempts: attempts, repairSuccesses: successes, errors };
}
export function report(results: ScenarioResult[], mode: EvalReport['mode'] = 'fixture'): EvalReport {
  const sum = (key: keyof ScenarioResult) => results.reduce((n, r) => n + Number(r[key]), 0);
  const routing = sum('routingTotal'), repairs = sum('repairAttempts'), tasks = sum('classTotal');
  const segments = sum('predictedSegments') + sum('expectedSegments');
  return { mode, status: 'completed', scenarios: results, metrics: {
    scenarioPassRate: results.length ? results.filter(r => r.passed).length / results.length : 0,
    routingRecall: routing ? sum('routingHits') / routing : 0,
    repairSuccess: repairs ? sum('repairSuccesses') / repairs : 0,
    segmentationF1: segments ? 2 * sum('segmentationMatches') / segments : 0,
    underProvisioning: tasks ? sum('underProvisioned') / tasks : 0,
    overProvisioning: tasks ? sum('overProvisioned') / tasks : 0,
  }, denominators: { scenarios: results.length, routing, repairs, tasks } };
}
export async function runEval(scenarios: readonly EvalScenario[], options: { mode?: 'fixture' | 'live'; env?: Readonly<Record<string, string | undefined>>; model?: (s: EvalScenario) => EvalModelPort; classifier?: ClassifierPort } = {}): Promise<EvalReport> {
  const mode = options.mode ?? 'fixture';
  if (mode === 'live' && (options.env ?? process.env)['PLUR1BUS_LIVE_EVAL'] !== '1') return { ...report([], mode), status: 'skipped', reason: 'PLUR1BUS_LIVE_EVAL=1 required' };
  if (mode === 'live' && !options.model) throw Error('live eval requires an explicit model port');
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    try { results.push(await runScenario(s, options.model?.(s) ?? fakeModel(s), options.classifier)); }
    catch { results.push({ id: s.id, passed: false, routingHits: 0, routingTotal: s.expected.needed.length, segmentationMatches: 0, predictedSegments: 0, expectedSegments: s.expected.tasks.length, underProvisioned: s.expected.tasks.length, overProvisioned: 0, classTotal: s.expected.tasks.length, repairAttempts: 0, repairSuccesses: 0, errors: ['scenario raised an error'] }); }
  }
  return report(results, mode);
}
export function markdownReport(r: EvalReport): string {
  return `# Tool eval (${r.mode}, ${r.status})\n\n${r.reason ?? ''}\n\n| Metric | Value |\n|---|---:|\n${Object.entries(r.metrics).map(([k, v]) => `| ${k} | ${(100 * v).toFixed(2)}% |`).join('\n')}\n\nScenarios: ${r.denominators.scenarios}; routing targets: ${r.denominators.routing}; repair attempts: ${r.denominators.repairs}; tasks: ${r.denominators.tasks}.\n`;
}
