import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { SessionModelRouting, type ModelRoutingEvent } from '../../src/composition/model-routing.ts';
import { sessionRoleFactory } from '../../src/session/maintenance.ts';
import { createTurnProvider, type TurnProviderOptions } from '../../src/composition/provider.ts';
import type { DecisionClient } from '../../src/decision/client.ts';
import { ProviderError } from '../../../providers/src/index.ts';
import { scriptedAdapter, turnFixture, useTempDirs, collect, turnRequest } from '../composition/helpers.ts';
const tmp = useTempDirs('f5-model-provider-');
const triage = { text: JSON.stringify({ schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] }) };
const choice = (id: string) => ({ text: JSON.stringify({ id, probabilities: { cheap: id === 'cheap' ? 1 : 0, quality: id === 'quality' ? 1 : 0 }, confidence: 1 }) });
function fixture(rounds = [triage, choice('cheap'), triage, choice('quality'), triage], settings: Pick<TurnProviderOptions, 'billing' | 'allowCrossBilling'> = {}) {
  const cfg = defaults(); cfg.modelRoles.decision = 'classifier'; cfg.agents.a1 = { model: 'cheap', modelPolicy: { mode: 'auto', tiers: ['cheap', 'quality'], perTurn: false } };
  const cheap = scriptedAdapter([{ text: 'cheap response' }]), quality = scriptedAdapter([{ text: 'quality response' }]), alien = scriptedAdapter([{ text: 'unauthorized response' }]), classifier = scriptedAdapter(rounds);
  const f = turnFixture(alien.adapter, {}, tmp.make()); const events: ModelRoutingEvent[] = []; let client!: DecisionClient; let failCheap = false, cheapAttempts = 0;
  const profiles = { default: [{ provider: 'alien', model: 'gpt-4.1', adapter: alien.adapter }], cheap: [{ provider: 'local', model: 'gpt-4.1-mini', adapter: { async *stream(...args: Parameters<typeof cheap.adapter.stream>) { cheapAttempts++; if (failCheap) throw new ProviderError('network', 'offline'); yield* cheap.adapter.stream(...args); } } }], quality: [{ provider: 'cloud', model: 'gpt-4.1', adapter: quality.adapter }], classifier: [{ provider: 'local', model: 'gpt-4.1-mini', adapter: classifier.adapter }] };
  const routing = new SessionModelRouting({ decision: () => client, agent: id => cfg.agents[id], localOnly: () => cfg.privacy.localOnly, isLocal: p => p === 'local' });
  const create = sessionRoleFactory(createTurnProvider, () => cfg, { onClient: c => client = c });
  const provider = create({ ...settings, profiles, modelRouting: routing, onModelRouting: event => events.push(event), budget: f.budget, registry: f.registry, maxTokens: 64, router: { retry: { maxRetries: 0 } }, profileForAgent: id => cfg.agents[id]?.model, localOnly: () => cfg.privacy.localOnly, isLocalProvider: p => p === 'local', grants: { get: () => undefined, list: () => [] }, approval: { async request() { return { approved: false }; } }, log: () => {}, resultStore: { async put() { throw Error('no tools'); } } });
  return { cfg, provider, client: () => client, events, cheap, quality, alien, classifier, cheapAttempts: () => cheapAttempts, failCheap: (value: boolean) => { failCheap = value; }, close: f.close };
}
test('the existing production router follows only configured tier order and pins the actual failover model', async () => {
  const f = fixture(); f.failCheap(true);
  try {
    const first = await collect(f.provider); assert.equal(first.filter(c => c.type === 'delta').map(c => c.text).join(''), 'quality response'); assert.equal(f.cheapAttempts(), 1); assert.equal(f.quality.requests.length, 1); assert.equal(f.alien.requests.length, 0);
    f.failCheap(false); await collect(f.provider, { ...turnRequest(), turnId: 'second', messages: [{ role: 'user', text: 'entirely different simple question' }] });
    assert.equal(f.cheapAttempts(), 1); assert.equal(f.quality.requests.length, 2); assert.equal(f.classifier.requests.length, 3); assert.equal(f.client().status().requests, 3);
    assert.equal(f.events[0]!.profile, 'quality'); assert.equal(f.events[1]!.reasonCode, 'session-cache'); assert(!JSON.stringify(f.events).includes('entirely different'));
  } finally { f.close(); }
});
test('per-turn opt-in changes models and explicit modelProfile consumes no routing choice', async () => {
  const f = fixture(); f.cfg.agents.a1!.modelPolicy!.perTurn = true;
  try {
    await collect(f.provider); await collect(f.provider); assert.equal(f.cheap.requests.length, 1); assert.equal(f.quality.requests.length, 1); assert.equal(f.classifier.requests.length, 4);
    await collect(f.provider, { ...turnRequest(), modelProfile: 'cheap' }); assert.equal(f.classifier.requests.length, 5); assert.equal(f.cheap.requests.length, 2); assert.equal(f.events.at(-1)!.reasonCode, 'explicit');
  } finally { f.close(); }
});
test('live local-only filters auto tiers while an explicit cloud override remains a terminal refusal', async () => {
  const f = fixture([triage]); f.cfg.privacy.localOnly = true;
  try {
    await collect(f.provider); assert.equal(f.cheap.requests.length, 1); assert.equal(f.quality.requests.length, 0); assert.equal(f.classifier.requests.length, 1);
    await assert.rejects(() => collect(f.provider, { ...turnRequest(), modelProfile: 'quality' }), (e: any) => e.code === 'local-only'); assert.equal(f.quality.requests.length, 0); assert.equal(f.alien.requests.length, 0);
  } finally { f.close(); }
});
for (const permit of [false, true]) test(`tier failover preserves existing plan/paid billing admission (opt-in ${permit})`, async () => {
  const f = fixture([triage, choice('cheap')], { billing: { local: 'plan', cloud: 'paid' }, allowCrossBilling: profile => permit && profile === 'cheap' }); f.failCheap(true);
  try {
    if (permit) await collect(f.provider); else await assert.rejects(() => collect(f.provider));
    assert.equal(f.quality.requests.length, permit ? 1 : 0); assert.equal(f.alien.requests.length, 0);
  } finally { f.close(); }
});
test('context reservation includes the current agent auto tiers without adding another agent policy', async () => {
  const { runWithAgentScope, scopeFor } = await import('../../src/agents/scope.ts'); const f = fixture();
  try {
    const models = runWithAgentScope(scopeFor('a1', '/tmp'), () => f.provider.contextModels?.('task'))!;
    assert(models.some(m => m.provider === 'local' && m.model === 'gpt-4.1-mini')); assert(models.some(m => m.provider === 'cloud' && m.model === 'gpt-4.1'));
    const other = runWithAgentScope(scopeFor('another', '/tmp'), () => f.provider.contextModels?.('task'))!; assert(!other.some(m => m.provider === 'cloud'));
  } finally { f.close(); }
});
test('an unavailable tier list refuses the turn rather than opening an unrelated configured default', async () => {
  const f = fixture([triage]); f.cfg.agents.a1!.modelPolicy!.tiers = ['missing'];
  try { await assert.rejects(() => collect(f.provider), /model-policy-unavailable/); assert.equal(f.cheap.requests.length, 0); assert.equal(f.quality.requests.length, 0); assert.equal(f.alien.requests.length, 0); } finally { f.close(); }
});
test('fixed mode retains its existing profile fallback and does not activate a stored auto tier list', async () => {
  const f = fixture([triage]); f.cfg.agents.a1!.modelPolicy!.mode = 'fixed'; f.failCheap(true);
  try { await assert.rejects(() => collect(f.provider)); assert.equal(f.classifier.requests.length, 1); assert.equal(f.cheapAttempts(), 1); assert.equal(f.quality.requests.length, 0); assert.equal(f.alien.requests.length, 0); } finally { f.close(); }
});
