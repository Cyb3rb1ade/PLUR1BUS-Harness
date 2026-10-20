import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { DecisionClient } from '../../src/decision/client.ts';
const context = () => ({ agentId: 'a', sessionId: 's', turnId: 't', principal: 'owner', signal: new AbortController().signal });
const input = { useCase: 'routing' as const, state: 'private-input', question: 'choose', options: [{ id: 'a', description: 'first' }, { id: 'b', description: 'second' }] };
function fixture(run: (request: any, signal: AbortSignal) => Promise<unknown>, local = true) {
  const cfg = defaults(); const events: unknown[] = [];
  const client = new DecisionClient({ config: () => cfg, backends: { role: { local: () => local, run } }, emit: (_ctx, event) => events.push(event) });
  return { client, cfg, events };
}
test('normalizes noul, choice and score without inventing calibrated role confidence', async () => {
  const f = fixture(async r => r.primitive === 'noul' ? { probability: .1 } : r.primitive === 'score' ? { probabilities: [.2, .3, .5], confidence: .8 } : { id: 'b', probabilities: { a: .2, b: .8 }, confidence: .8 });
  const n = await f.client.noul({ useCase: 'skills', state: '', question: 'yes?' }, context());
  assert.equal(n.ok && n.value.probability, .1); assert.equal(n.ok && n.confidence, .9); assert.equal(n.ok && n.confidenceSource, 'derived');
  const c = await f.client.choice(input, context()); assert.equal(c.ok && c.value.id, 'b'); assert.equal(c.ok && c.confidenceSource, 'uncalibrated');
  const s = await f.client.score({ useCase: 'routing', state: '', question: 'rate', levels: ['low', 'middle', 'high'] }, context()); assert.equal(s.ok && s.value.score, 1.3);
  assert.equal(f.events.length, 3); assert(!JSON.stringify(f.events).includes('private-input'));
  assert.equal(f.client.status().requests, 3); assert.equal(f.client.status().failures, 0);
});
test('rejects malformed output, unknown choices and low confidence conservatively', async () => {
  for (const raw of [{ id: 'alien', probabilities: { a: 0, b: 1 }, confidence: 1 }, { id: 'a', probabilities: { a: .7, b: .7 }, confidence: 1 }, { id: 'b', probabilities: { a: .8, b: .2 }, confidence: 1 }, { id: 'a', probabilities: { a: .8, b: .2 }, confidence: .3 }, { id: 'a', probabilities: { a: NaN, b: 1 }, confidence: 1 }]) {
    const f = fixture(async () => raw); const result = await f.client.choice(input, context()); assert.equal(result.ok, false); assert.equal(f.client.status().failures, 1);
  }
});
test('a backend ignoring abort cannot hold the caller or later emit success', async () => {
  let finish!: (value: unknown) => void; const f = fixture(() => new Promise(resolve => finish = resolve)); f.cfg.decision.timeoutMs = 15;
  const result = await f.client.choice(input, context()); assert.equal(result.ok, false); assert.equal(!result.ok && result.reason, 'timeout');
  finish({ id: 'b', probabilities: { a: 0, b: 1 }, confidence: 1 }); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.events.length, 1);
});
test('caller abort is cancellation and never tries a fallback', async () => {
  const f = fixture(() => new Promise(() => {})); const abort = new AbortController(); const pending = f.client.choice(input, { ...context(), signal: abort.signal }); abort.abort();
  const result = await pending; assert.equal(!result.ok && result.reason, 'cancelled');
});
test('fallback shares the original deadline rather than resetting it', async () => {
  const cfg = defaults(); cfg.decision.backend = 'laya'; cfg.decision.timeoutMs = 30;
  let remaining = Infinity;
  const client = new DecisionClient({ config: () => cfg, backends: {
    laya: { local: () => true, async run() { await new Promise(resolve => setTimeout(resolve, 20)); throw Error('invalid'); } },
    role: { local: () => true, async run(r) { remaining = r.deadline - performance.now(); return new Promise(() => {}); } },
  } });
  const result = await client.choice(input, context()); assert.equal(!result.ok && result.reason, 'timeout'); assert(remaining < 25);
});
test('live privacy refuses explicit cloud role before invocation and unavailable stays tagged', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return {}; }, false); f.cfg.privacy.localOnly = true;
  const result = await f.client.choice(input, context()); assert.equal(!result.ok && result.reason, 'privacy'); assert.equal(calls, 0);
  f.cfg.privacy.localOnly = false; await f.client.choice(input, context()); assert.equal(calls, 1);
  const absent = new DecisionClient({ config: () => defaults(), backends: {} }); assert.equal((await absent.choice(input, context())).ok, false);
});
test('the internal D105 bridge keeps the existing 200000-character message admission while portable primitives stay bounded', async () => {
  let received = ''; const f = fixture(async r => { received = r.state; return { schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] }; });
  const message = 'x'.repeat(200_000); const contextValue = context();
  const result = await f.client.triage(message, contextValue); assert.equal(result.ok, true); assert.equal(received.length, 200_000);
  assert.equal((await f.client.noul({ useCase: 'skills', state: 'x'.repeat(16_385), question: 'yes?' }, context())).ok, false);
  assert.equal((await f.client.triage(message + 'x', context())).ok, false);
});
test('auto requires affirmative native eligibility evidence and filters privacy before fallback', async () => {
  const f = fixture(async () => ({ id: 'b', probabilities: { a: 0, b: 1 }, confidence: 1 })); f.cfg.decision.backend = 'auto';
  let native = 0;
  const client = new DecisionClient({ config: () => f.cfg, backends: { laya: { local: () => true, async run() { native++; return {}; } }, role: { local: () => true, async run() { return { id: 'b', probabilities: { a: 0, b: 1 }, confidence: 1 }; } } } });
  const result = await client.choice(input, context()); assert.equal(result.ok && result.backend, 'role'); assert.equal(native, 0);
});
for (const broken of ['eligible', 'local'] as const) test(`a throwing ${broken} predicate stays conservative, records completion and checks fallback privacy`, async () => {
  const f = fixture(async () => ({})); f.cfg.decision.backend = 'laya';
  const events: unknown[] = []; let calls = 0;
  const client = new DecisionClient({ config: () => f.cfg, emit: (_ctx, event) => events.push(event), backends: {
    laya: { eligible: () => { if (broken === 'eligible') throw Error('private-module-status'); return true; }, local: () => { if (broken === 'local') throw Error('private-module-status'); return true; }, async run() { throw Error('unreachable'); } },
    role: { local: () => false, async run() { calls++; return { id: 'b', probabilities: { a: 0, b: 1 }, confidence: 1 }; } },
  } });
  assert.equal((await client.choice(input, context())).ok, true); assert.equal(calls, 1);
  f.cfg.privacy.localOnly = true;
  const result = await client.choice(input, context()); assert.equal(!result.ok && result.reason, 'privacy'); assert.equal(calls, 1);
  assert.equal(client.status().requests, 2); assert.equal(client.status().failures, 1); assert.equal(events.length, 2); assert(!JSON.stringify(events).includes('private-module-status'));
});
