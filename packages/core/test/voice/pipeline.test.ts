import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/session/store.ts';
import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { FakeChatProvider } from '../../src/session/provider.ts';
import { createVoiceTurnProfile, voiceTurnContext, voiceEngineConfig } from '../../src/voice/turn-profile.ts';
import { VoiceMetrics } from '../../src/voice/metrics.ts';
import { resolveProfile } from '../../../voice-providers/src/index.ts';
const caller = { channel: 'cli' as const, accountId: 'a', userId: 'u' };
function rig() {
  const calls: string[] = []; const store = new SessionStore({ path: ':memory:' });
  const compactor = new Compactor(store, defaultCompaction());
  const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider({ onRequest: () => { calls.push('provider'); } }), memory: { async recall() { calls.push('recall'); return { text: 'memory', degraded: null }; }, async capture() { calls.push('capture'); }, async checkpoint() {} } });
  return { calls, store, runner, session: () => store.createSession({ kind: 'direct', owner: 'u', agentId: 'a', memoryMode: 'remember' }) };
}
test('profile-free turn retains recall/provider/capture order and original reply', async () => {
  const r = rig(); try { const result = await r.runner.submit({ session: r.session(), caller, text: 'hello' }).done;
    assert.equal(result.reply, 'echo[a]: hello'); assert.deepEqual(r.calls, ['recall', 'provider', 'capture']);
    await r.runner.idle();
  } finally { r.store.close(); }
});
test('local realtime returns before write-behind, then idle drains capture', async () => {
  const r = rig(); try {
    const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics() });
    await r.runner.submit({ session: r.session(), caller, text: 'hello', turnProfile: profile }).done;
    assert.deepEqual(r.calls, ['recall', 'provider']); await r.runner.idle(); assert.deepEqual(r.calls, ['recall', 'provider', 'capture']);
  } finally { r.store.close(); }
});
test('simultaneous ALS contexts keep host config isolated; no profile returns exact object', async () => {
  const base = { reranker: { enabled: true }, runtime: { deferPostTurnLlm: false } };
  const p = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics() });
  const values = await Promise.all([voiceTurnContext.run(p, async () => { await Promise.resolve(); return voiceEngineConfig(base); }), (async () => { await Promise.resolve(); return voiceEngineConfig(base); })()]);
  assert.equal(values[0], base); assert.equal(p.engineOptions.recall.state, 'engine-fixed'); assert.equal(p.engineOptions.recall.reranker, false); assert.equal(p.engineOptions.capture.runtime.deferPostTurnLlm, true);
  assert.equal(values[1], base); assert.equal(base.reranker.enabled, true);
  const on = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true, features: { reranker: 'on' } }), turnId: 'b', metrics: new VoiceMetrics() });
  assert.equal(voiceTurnContext.run(on, () => voiceEngineConfig(base)).reranker.enabled, true);
});
test('cancelled speculative turn cannot complete or capture', async () => {
  const r = rig(); try {
    const ctl = new AbortController(); const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics(), signal: ctl.signal, confirmed: new Promise<void>(() => {}) });
    const session = r.session(); const h = r.runner.submit({ session, caller, text: 'hello', turnProfile: profile });
    await new Promise(resolve => setImmediate(resolve)); ctl.abort();
    assert.equal((await h.done).state, 'failed'); await r.runner.idle(); assert.ok(!r.calls.includes('capture'));
  } finally { r.store.close(); }
});

test('engine-fixed is explicit in voice metrics and cannot be mistaken for applied per-turn switches', () => {
  const metrics = new VoiceMetrics();
  assert.deepEqual(metrics.report().engineFeatures, { reranker: 'engine-fixed', postTurnRefine: 'engine-fixed' });
});

import { createTurnProvider } from '../../src/composition/provider.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES } from '../../src/budget/index.ts';
test('privacy model admission denies every cloud adapter before invocation, including fallbacks', async () => {
  let calls = 0;
  const dir = mkdtempSync(join(tmpdir(), 'voice-v2-budget-'));
  const budget = createCallBudget({ path: join(dir, 'usage.sqlite'), clock: { now: Date.now }, prices: new PriceBook(SHIPPED_PRICE_TABLES) });
  const adapter = { async *stream() { calls++; throw new Error('cloud invoked'); yield { type: 'text_delta' as const, text: '' }; } };
  const provider = createTurnProvider({ registry: new ToolRegistry(), budget, profiles: { default: [{ provider: 'cloud', model: 'gpt-4.1', adapter }, { provider: 'fallback', model: 'gpt-4.1', adapter }] }, approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] }, log() {}, resultStore: { put: async () => '' } });
  const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics(), allowModel: () => false });
  try { await assert.rejects(async () => { for await (const _ of provider.stream({ sessionId: 's', agentId: 'a', principal: 'u', summaries: [], memory: '', messages: [{ role: 'user', text: 'hello' }], signal: new AbortController().signal, turnProfile: profile })) {} }); assert.equal(calls, 0); }
  finally { budget.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('cancel after completion preserves committed write-behind; cancel before completion discards it', async () => {
  const r = rig(); try {
    const controller = new AbortController(); const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics(), signal: controller.signal });
    await r.runner.submit({ session: r.session(), caller, text: 'hello', turnProfile: profile }).done; controller.abort();
    await r.runner.idle(); assert.equal(r.calls.filter(x => x === 'capture').length, 1);
  } finally { r.store.close(); }
});

test('privacy pin skips engine memory calls even outside local realtime mode', async () => {
  const r = rig(); try {
    const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: false }), turnId: 'a', metrics: new VoiceMetrics(), privacyPin: true });
    const result = await r.runner.submit({ session: r.session(), caller, text: 'hello', turnProfile: profile }).done;
    assert.equal(result.state, 'completed'); await r.runner.idle(); assert.deepEqual(r.calls, ['provider']);
  } finally { r.store.close(); }
});

test('concurrent ordinary and realtime turns retain separate profile contexts', async () => {
  const store = new SessionStore({ path: ':memory:' }); const compactor = new Compactor(store, defaultCompaction());
  const contexts: boolean[] = [];
  const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider({ onRequest: () => { contexts.push(voiceTurnContext.getStore()?.localRealtime.enabled ?? false); } }), memory: { async recall() { await new Promise(resolve => setImmediate(resolve)); return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} } });
  const session = () => store.createSession({ kind: 'direct', owner: 'u', agentId: 'a', memoryMode: 'incognito' });
  const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'p', metrics: new VoiceMetrics() });
  try { const results = await Promise.all([runner.submit({ session: session(), caller, text: 'hello', turnProfile: profile }).done, runner.submit({ session: session(), caller, text: 'hello' }).done]);
    assert.ok(results.every(result => result.state === 'completed')); assert.deepEqual(contexts.sort(), [false, true]); await runner.idle();
  } finally { store.close(); }
});
test('speculative tool call remains gated until transcript confirmation', async () => {
  const store = new SessionStore({ path: ':memory:' }); const compactor = new Compactor(store, defaultCompaction()); const events: string[] = [];
  const runner = new TurnRunner({ store, compactor, provider: () => ({ id: 'test', async *stream() { yield { type: 'tool.call' as const, id: 'call', name: 'example', args: {} }; } }), notify: event => { events.push(event.type); }, memory: { async recall() { return { text: '', degraded: null }; }, async capture() { throw new Error('cancelled speculation captured'); }, async checkpoint() {} } });
  const controller = new AbortController(); const profile = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics(), signal: controller.signal, confirmed: new Promise<void>(() => {}) });
  try {
    const session = store.createSession({ kind: 'direct', owner: 'u', agentId: 'a', memoryMode: 'remember' });
    const handle = runner.submit({ session, caller, text: 'hello', turnProfile: profile }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes('tool.call'), false); controller.abort(); assert.equal((await handle.done).state, 'failed'); await runner.idle();
  } finally { controller.abort(); await runner.idle(); store.close(); }
});
