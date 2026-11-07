import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { learningModel } from '../../src/dreams/learn/provider.ts';
import { createTurnProvider, type TurnProviderOptions } from '../../src/composition/provider.ts';
import { createCallBudget, type CallRequest } from '../../src/budget/calls.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { scriptedAdapter, useTempDirs } from '../composition/helpers.ts';
import type { LearnModelRequest } from '../../src/dreams/learn/model.ts';
const tmp = useTempDirs('learn-route-');
const request = (): LearnModelRequest => ({ target: { scope: 'project', projectId: 'project', agentId: 'agent', owner: 'person' },
  modelClass: 'small', stage: 'extract', instructions: 'Extract fixtures only.', data: 'UNTRUSTED_DATA', maxOutputTokens: 100, signal: new AbortController().signal });
function rig() {
  const budget = createCallBudget({ path: join(tmp.make(), 'budget.sqlite'), clock: { now: Date.now } }); tmp.onCleanup(() => budget.close());
  const scripted = scriptedAdapter([{ text: '[]', usage: { inputTokens: 7, outputTokens: 3 } }]);
  const admissions: CallRequest[] = [], before = budget.checkBeforeCall.bind(budget);
  budget.checkBeforeCall = r => { admissions.push({ ...r }); return before(r); };
  const options: TurnProviderOptions = { registry: new ToolRegistry(), budget,
    profiles: { extraction: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: scripted.adapter }] }, profileForClass: c => c === 'small' ? 'extraction' : undefined,
    approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] },
    log: () => {}, resultStore: { put: async () => { throw Error('no-tools'); } }, router: { retry: { maxRetries: 0 } },
    classifyMessage: async () => { throw Error('triage-must-not-run'); }, requireTriage: true,
  };
  return { budget, scripted, options, admissions };
}
test('LP6/L3: learn uses the real router budget with human, agent and project attribution and no triage', async () => {
  const r = rig(); let role = '';
  const create: typeof createTurnProvider = options => {
    assert.equal(options.requireTriage, false); assert.equal(options.classifyMessage, undefined);
    const provider = createTurnProvider(options);
    return { ...provider, stream(req) { role = req.role ?? ''; assert.equal(req.approver?.person, null); return provider.stream(req); } };
  };
  const model = learningModel(r.options, () => false, create);
  assert.equal((await model.complete(request())).model, 'fixture/gpt-4.1-mini');
  assert.equal(role, 'engine'); assert.equal(r.admissions[0]!.principal, deriveUserPrincipal('person'));
  assert.equal(r.admissions[0]!.agent, 'agent'); assert.equal(r.admissions[0]!.project, 'project');
  assert.deepEqual(r.scripted.requests[0]!.tools, []);
});
test('LP6: project local-only and exhausted project budgets refuse before provider access', async () => {
  const r = rig(); r.options.isLocalProvider = () => false;
  await assert.rejects(() => learningModel(r.options, () => true).complete(request()), /local-only/);
  assert.equal(r.scripted.requests.length, 0);
  r.budget.setLimit({ scope: 'project', id: 'project', period: 'day', metric: 'tokens', hard: 0 });
  await assert.rejects(() => learningModel(r.options, () => false).complete(request()), /budget/);
  assert.equal(r.scripted.requests.length, 0);
});
test('LP6: absent class routes never fall back to the default model or Jev', async () => {
  const r = rig(); const model = learningModel(r.options, () => false);
  await assert.rejects(() => model.complete({ ...request(), modelClass: 'large', stage: 'skeptic' }), /no-model/);
  assert.equal(r.scripted.requests.length, 0);
});
