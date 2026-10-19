// Reproducible recorded-fixture wiring/token comparison. This is not a live-model quality claim.
import { join } from 'node:path';
import { createCallBudget } from '../budget/index.ts';
import { createTurnProvider } from '../composition/provider.ts';
import type { StreamingAdapter, ChatRequest as WireRequest, ChatResult } from '../../../providers/src/index.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { collaborationTools } from '../tools/collaboration.ts';
import { createCollab } from './service.ts';
import { composedAgentRunner } from '../composition/collaboration.ts';
import { alsAgentScopePort } from './scope.ts';
export interface EvalCase { id: string; left: number; right: number; expected: string }
export interface EvalRow { id: string; mode: 'single' | 'peer'; correct: boolean; tokenBudget: number; settledTokens: number; modelCalls: number }
export const FANOUT_CASES: EvalCase[] = Array.from({ length: 24 }, (_, i) => ({ id: `arithmetic-${i + 1}`, left: i + 3, right: i % 7 + 2, expected: String((i + 3) * (i % 7 + 2)) }));
export async function runFanoutEval(home: string, cases: readonly EvalCase[] = FANOUT_CASES): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const fixture of cases) for (const mode of ['single', 'peer'] as const) {
    let settledTokens = 0, modelCalls = 0, rootCalls = 0;
    const budget = createCallBudget({ path: join(home, `${fixture.id}-${mode}.sqlite`), clock: { now: Date.now }, emitter: { emit(e) { if (e.type === 'settle') settledTokens += e.tokens; } } });
    const owner = { kind: 'person' as const, userId: 'owner', role: 'owner' as const };
    const makeAdapter = (answer: (req: WireRequest) => { text: string; consult: boolean }): StreamingAdapter => ({ async *stream(req) {
      modelCalls++; const a = answer(req);
      yield { type: 'done', result: { text: a.text, toolCalls: a.consult ? [{ id: 'eval_consult', name: 'consult_agent', arguments: { projectId: project.id, toAgent: 'peer', objective: `Compute ${fixture.left} * ${fixture.right}` }, argumentsRaw: JSON.stringify({ projectId: project.id, toAgent: 'peer', objective: `Compute ${fixture.left} * ${fixture.right}` }) }] : [], finishReason: a.consult ? 'tool_calls' : 'stop', rawFinishReason: 'stop', usage: { inputTokens: 16, outputTokens: 8 }, meta: {} } as ChatResult };
    } });
    const leaf = createTurnProvider({ registry: new ToolRegistry(), budget, profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: makeAdapter(() => ({ text: String(fixture.left * fixture.right), consult: false })) }] }, grants: { get: () => undefined, list: () => [] }, approval: { async request() { throw Error('unexpected approval'); } }, log() {}, resultStore: { async put() { throw Error('unexpected oversized result'); } }, maxTokens: 128 });
    const collab = createCollab({ path: ':memory:', runner: composedAgentRunner(leaf, alsAgentScopePort(), home), budget: { check(e) { const r = budget.checkBeforeCall({ principal: owner.userId, agent: e.agentId, project: e.projectId, model: 'gpt-4.1', provider: 'fixture', estimatedInputTokens: e.tokens, maxOutputTokens: 128 }); if (r.kind === 'refuse') return { allowed: false, reason: 'token-budget' }; budget.releaseUnused(r.reservationId); return { allowed: true }; }, record() {} } });
    const project = collab.createProject(owner, { name: fixture.id }); for (const id of ['lead','peer']) collab.addAgent(owner, project.id, id);
    const tokenBudget = 8192; budget.setLimit({ scope: 'project', id: project.id, period: 'day', metric: 'tokens', hard: tokenBudget });
    const root = createTurnProvider({ registry: new ToolRegistry(), budget, profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: makeAdapter(req => {
      rootCalls++;
      if (mode === 'peer' && rootCalls === 1) return { text: '', consult: true };
      const result = req.messages.findLast(m => m.role === 'tool');
      return { text: mode === 'single' ? String(fixture.left * fixture.right) : result ? String(JSON.parse(String(result.content)).value.result.output) : '', consult: false };
    }) }] }, toolsForTurn: async req => { const reg = new ToolRegistry(); if (mode === 'peer') for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => owner, authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, now: Date.now, audit() {} } }, req)) reg.register(tool); return reg; }, grants: { get: () => undefined, list: () => [] }, approval: { async request() { throw Error('unexpected approval'); } }, log() {}, resultStore: { async put() { throw Error('unexpected oversized result'); } }, maxTokens: 128, topK: 100 });
    try {
      let text = ''; for await (const c of root.stream({ agentId: 'lead', principal: owner.userId, approver: { person: owner.userId, surface: 1 }, projectId: project.id, sessionId: `eval-${fixture.id}`, turnId: 'eval-turn', summaries: [], memory: '', messages: [{ role: 'user', text: `Compute ${fixture.left} * ${fixture.right}` }], signal: new AbortController().signal })) if (c.type === 'delta') text += c.text;
      rows.push({ id: fixture.id, mode, correct: text === fixture.expected, tokenBudget, settledTokens, modelCalls });
    } finally { await collab.shutdown(); budget.close(); }
  }
  return rows;
}
