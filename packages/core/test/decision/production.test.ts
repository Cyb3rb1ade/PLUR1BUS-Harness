import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { sessionRoleFactory } from '../../src/session/maintenance.ts';
import { createTurnProvider } from '../../src/composition/provider.ts';
import { scriptedAdapter, turnFixture, turnRequest, collect, useTempDirs } from '../composition/helpers.ts';
import type { DecisionClient } from '../../src/decision/client.ts';
const tmp = useTempDirs('decision-production-');
test('production role factory shares triage client, keeps D105 payload and charges router budget', async () => {
  const cfg = defaults(); cfg.modelRoles.decision = 'triage';
  const classification = { schema: 'plur1bus.triage/1', shape: 'single', tasks: [{ id: 'task', summary: 'Search', start: 0, end: 6, categories: { 'web.research': 1 }, modelClass: { small: 1, medium: 0, large: 0, frontier: 0 }, chosenClass: 'small', effort: 'low', dependsOn: [], confidence: 1, reason: 'fixture' }] };
  const wire = scriptedAdapter([{ text: 'done' }]); const classifier = scriptedAdapter([{ text: JSON.stringify(classification) }]);
  const f = turnFixture(wire.adapter, {}, tmp.make()); let client!: DecisionClient; let admits = 0;
  const before = f.budget.checkBeforeCall.bind(f.budget); f.budget.checkBeforeCall = req => { admits++; return before(req); };
  const factory = sessionRoleFactory(createTurnProvider, () => cfg, { onClient: value => client = value });
  const provider = factory({ profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: wire.adapter }], triage: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: classifier.adapter }] }, budget: f.budget, registry: f.registry, grants: { get: () => undefined, list: () => [] }, approval: { async request() { return { approved: false }; } }, log: () => {}, resultStore: { async put() { throw Error('no tools'); } } });
  try {
    await collect(provider, { ...turnRequest(), messages: [{ role: 'user', text: 'Search' }] });
    assert.equal(client.status().requests, 1); assert.equal(client.status().failures, 0); assert.equal(admits, 2);
    assert.equal(classifier.requests.length, 1); assert.deepEqual(classifier.requests[0]!.tools, []); assert.equal(wire.requests.length, 1);
    cfg.decision.backend = 'jev'; await collect(provider, { ...turnRequest(), messages: [{ role: 'user', text: 'Search' }] });
    assert.equal(client.status().requests, 2); assert.equal(client.status().failures, 0);
  } finally { f.close(); }
});
test('local-only pruning cannot cross to a cloud role fallback through the existing router', async () => {
  const { createRoleBackend } = await import('../../src/decision/role.ts');
  const { DecisionClient } = await import('../../src/decision/client.ts');
  const { ProviderError } = await import('../../../providers/src/index.ts');
  const cfg = defaults(); cfg.modelRoles.decision = 'decision'; cfg.decision.timeoutMs = 1000; (cfg.decision.budgets as Record<string, number>).pruning = 1000;
  const cloud = scriptedAdapter([{ text: JSON.stringify({ id: 'drop', probabilities: { keep: 0, drop: 1 }, confidence: 1 }) }]);
  const f = turnFixture(cloud.adapter, {}, tmp.make());
  const backend = createRoleBackend(createTurnProvider, { profiles: { decision: [{ provider: 'local', model: 'gpt-4.1-mini', adapter: { async *stream() { throw new ProviderError('network', 'offline'); } } }, { provider: 'cloud', model: 'gpt-4.1', adapter: cloud.adapter }] }, budget: f.budget, registry: f.registry, isLocalProvider: p => p === 'local', router: { retry: { maxRetries: 0 } }, grants: { get: () => undefined, list: () => [] }, approval: { async request() { return { approved: false }; } }, log: () => {}, resultStore: { async put() { throw Error('no tools'); } } }, () => cfg);
  const client = new DecisionClient({ config: () => cfg, backends: { role: backend } });
  try {
    const result = await client.choice({ useCase: 'pruning', state: 'raw private tool output', question: 'Keep?', options: [{ id: 'keep', description: 'keep' }, { id: 'drop', description: 'drop' }] }, { agentId: 'a1', principal: 'owner', forceLocal: true, signal: new AbortController().signal });
    assert.equal(result.ok, false); assert.equal(cloud.requests.length, 0);
  } finally { f.close(); }
});
