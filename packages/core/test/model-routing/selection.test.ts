import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { DecisionClient } from '../../src/decision/client.ts';
import { SessionModelRouting } from '../../src/composition/model-routing.ts';
import { turnRequest } from '../composition/helpers.ts';
const neverAdapter = { async *stream(): AsyncGenerator<never> { throw Error('not an inference test'); } };
const profiles = { cheap: [{ provider: 'local', model: 'small', adapter: neverAdapter }], quality: [{ provider: 'cloud', model: 'large', adapter: neverAdapter }], excluded: [{ provider: 'other', model: 'alien', adapter: neverAdapter }] };
function fixture() {
  const cfg = defaults(); cfg.agents.a1 = { model: 'cheap', modelPolicy: { mode: 'auto', tiers: ['cheap', 'quality'], perTurn: false } }; let calls = 0;
  let selected = 'cheap';
  const decision = new DecisionClient({ config: () => cfg, backends: { role: { local: () => true, async run() { calls++; return { id: selected, probabilities: { cheap: selected === 'cheap' ? 1 : 0, quality: selected === 'quality' ? 1 : 0 }, confidence: 1 }; } } } });
  const routing = new SessionModelRouting({ decision: () => decision, agent: id => cfg.agents[id], localOnly: () => cfg.privacy.localOnly, isLocal: p => p === 'local' });
  return { cfg, routing, calls: () => calls, select: (id: string) => { selected = id; } };
}
test('auto pins the served session model despite complexity changes and never adds excluded profiles', async () => {
  const f = fixture(); const first = await f.routing.select(turnRequest(), profiles, 'cheap'); assert(first); assert.equal(first.profile, 'cheap'); assert.deepEqual(first.candidates.map(c => c.model), ['small', 'large']);
  first.served('local', 'small'); first.finish(true); f.select('quality');
  const next = await f.routing.select({ ...turnRequest(), messages: [{ role: 'user', text: 'architecture security distributed proof' }] }, profiles, 'cheap'); assert(next); assert.equal(next.profile, 'cheap'); assert.equal(next.reasonCode, 'session-cache'); assert.equal(f.calls(), 1);
});
test('perTurn opt-in reselects while an explicit modelProfile bypasses the decision and leaves auto cache intact', async () => {
  const f = fixture(); const first = await f.routing.select(turnRequest(), profiles, 'cheap'); first!.served('local', 'small'); first!.finish(true);
  f.cfg.agents.a1!.modelPolicy!.perTurn = true; f.select('quality'); const next = await f.routing.select(turnRequest(), profiles, 'cheap'); assert.equal(next!.profile, 'quality'); assert.equal(f.calls(), 2); next!.served('cloud', 'large'); next!.finish(true);
  const explicit = await f.routing.select({ ...turnRequest(), modelProfile: 'excluded' }, profiles, 'cheap'); assert.equal(explicit!.profile, 'excluded'); assert.equal(explicit!.reasonCode, 'explicit'); assert.equal(f.calls(), 2); explicit!.served('other', 'alien'); explicit!.finish(true);
  f.cfg.agents.a1!.modelPolicy!.perTurn = false; const cached = await f.routing.select(turnRequest(), profiles, 'cheap'); assert.equal(cached!.profile, 'quality'); assert.equal(f.calls(), 2);
});
test('cancelled or unsuccessful responses never populate the session cache', async () => {
  const f = fixture(); const abort = new AbortController(); const first = await f.routing.select({ ...turnRequest(), signal: abort.signal }, profiles, 'cheap'); first!.served('local', 'small'); abort.abort(); first!.finish(true);
  f.select('quality'); const next = await f.routing.select(turnRequest(), profiles, 'cheap'); assert.equal(next!.profile, 'quality'); assert.equal(f.calls(), 2);
  next!.served('cloud', 'large'); next!.finish(false); f.select('cheap'); const third = await f.routing.select(turnRequest(), profiles, 'cheap'); assert.equal(third!.profile, 'cheap'); assert.equal(f.calls(), 3);
});
test('a served failover model is pinned at its position in the declared list on the next turn', async () => {
  const f = fixture(); const first = await f.routing.select(turnRequest(), profiles, 'cheap'); first!.served('cloud', 'large'); first!.finish(true);
  const next = await f.routing.select(turnRequest(), profiles, 'cheap'); assert.equal(next!.profile, 'quality'); assert.deepEqual(next!.candidates.map(c => c.model), ['large']); assert.equal(f.calls(), 1);
});
test('live privacy invalidates forbidden cached models; fixed and absent policy perform no routing choice', async () => {
  const f = fixture(); f.select('quality'); const first = await f.routing.select(turnRequest(), profiles, 'cheap'); first!.served('cloud', 'large'); first!.finish(true);
  f.cfg.privacy.localOnly = true; const local = await f.routing.select(turnRequest(), profiles, 'cheap'); assert.equal(local!.profile, 'cheap'); assert.deepEqual(local!.candidates.map(c => c.model), ['small']);
  const count = f.calls(); f.cfg.agents.a1!.modelPolicy!.mode = 'fixed'; const fixed = await f.routing.select(turnRequest(), profiles, 'quality'); assert.equal(fixed!.profile, 'cheap'); assert.equal(f.calls(), count);
  delete f.cfg.agents.a1!.modelPolicy; assert.equal(await f.routing.select(turnRequest(), profiles, 'quality'), undefined); assert.equal(f.calls(), count);
});
test('unavailable or deadline-exceeded decision conservatively retains an eligible model and cancellation rejects', async () => {
  const cfg = defaults(); cfg.decision.timeoutMs = 10;
  const decision = new DecisionClient({ config: () => cfg, backends: { role: { local: () => true, async run() { return new Promise(() => {}); } } } });
  const routing = new SessionModelRouting({ decision: () => decision, agent: () => ({ model: 'cheap', modelPolicy: { mode: 'auto', tiers: ['cheap', 'quality'], perTurn: false } }), localOnly: () => false, isLocal: () => true });
  const selected = await routing.select(turnRequest(), profiles, 'cheap'); assert.equal(selected!.profile, 'cheap'); assert.equal(selected!.reasonCode, 'fallback-timeout');
  const abort = new AbortController(); const pending = routing.select({ ...turnRequest(), signal: abort.signal }, profiles, 'cheap'); abort.abort(); await assert.rejects(pending);
});
test('the real voice feature budget bounds routing and a late backend answer cannot populate the cache', async () => {
  const { createVoiceTurnProfile } = await import('../../src/voice/turn-profile.ts');
  const { VoiceMetrics } = await import('../../src/voice/metrics.ts');
  const { resolveProfile } = await import('../../../voice-providers/src/index.ts');
  const cfg = defaults(); cfg.decision.timeoutMs = 1000; (cfg.decision.budgets as Record<string, number>).routing = 1000;
  let finish!: (value: unknown) => void, calls = 0; let backendSignal: AbortSignal | undefined;
  const decision = new DecisionClient({ config: () => cfg, backends: { role: { local: () => true, async run(_request, signal) { calls++; backendSignal = signal; return new Promise(resolve => finish = resolve); } } } });
  const routing = new SessionModelRouting({ decision: () => decision, agent: () => ({ model: 'cheap', modelPolicy: { mode: 'auto', tiers: ['cheap', 'quality'], perTurn: false } }), localOnly: () => false, isLocal: () => true });
  const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true, features: { decisionService: { mode: 'on', maxMs: 10 } } }), turnId: 'voice', metrics: new VoiceMetrics() });
  const selected = await routing.select({ ...turnRequest(), turnProfile: profile }, profiles, 'cheap'); assert.equal(selected!.profile, 'cheap'); assert.equal(backendSignal!.aborted, true);
  selected!.served('local', 'small'); selected!.finish(true); finish({ id: 'quality', probabilities: { cheap: 0, quality: 1 }, confidence: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await routing.select(turnRequest(), profiles, 'cheap'))!.profile, 'cheap'); assert.equal(calls, 1);
});
test('session routing cache never crosses an authenticated principal boundary', async () => {
  const f = fixture(); const first = await f.routing.select(turnRequest(), profiles, 'cheap'); first!.served('local', 'small'); first!.finish(true); f.select('quality');
  const other = await f.routing.select({ ...turnRequest(), principal: 'another-authenticated-owner' }, profiles, 'cheap'); assert.equal(other!.profile, 'quality'); assert.equal(f.calls(), 2);
});
test('a broken durable cache read refuses routing instead of silently selecting a different session model', async () => {
  const cfg = defaults(); let calls = 0;
  const decision = new DecisionClient({ config: () => cfg, backends: { role: { local: () => true, async run() { calls++; return { id: 'quality', probabilities: { cheap: 0, quality: 1 }, confidence: 1 }; } } } });
  const routing = new SessionModelRouting({ decision: () => decision, agent: () => ({ modelPolicy: { mode: 'auto', tiers: ['cheap', 'quality'], perTurn: false } }), localOnly: () => false, isLocal: () => true, restore() { throw Error('private-store-error'); } });
  await assert.rejects(() => routing.select(turnRequest(), profiles, 'cheap'), /model-policy-state-unavailable/); assert.equal(calls, 0);
});
