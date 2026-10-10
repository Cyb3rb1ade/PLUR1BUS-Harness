import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectVoiceRoute } from '../../src/voice/routing.ts';
import { createVoiceTurnProfile } from '../../src/voice/turn-profile.ts';
import { VoiceMetrics } from '../../src/voice/metrics.ts';
import { resolveProfile } from '../../../voice-providers/src/index.ts';

const available = { realtime: ['xai'], asr: ['elevenlabs'], tts: ['polly'], local: true };
for (const live of [true, false]) for (const cascade of [true, false]) for (const pin of [true, false]) {
  test(`route live=${live} cascade=${cascade} privacy=${pin}`, async () => {
    const checked: string[] = [];
    const route = await selectVoiceRoute({ available, privacyPin: pin, preferences: { realtime: 'xai', asr: 'elevenlabs', tts: 'polly' }, allowed: async (id, kind) => { checked.push(id); return kind === 'realtime' ? live : cascade; } });
    assert.equal(route.kind, pin ? 'local' : live ? 'realtime' : cascade ? 'cascade' : 'local');
    if (pin) assert.deepEqual(checked, []);
  });
}
test('unavailable realtime falls through; deny local fails closed', async () => {
  assert.equal((await selectVoiceRoute({ available: { ...available, realtime: [] }, allowed: async () => true })).kind, 'cascade');
  await assert.rejects(selectVoiceRoute({ available: { ...available, local: false }, privacyPin: true, allowed: async () => true }), /voice-unavailable/);
});
test('feature switches apply only in local realtime mode', async () => {
  for (const enabled of [true, false]) {
    let calls = 0;
    const p = createVoiceTurnProfile({ profile: resolveProfile({ enabled, features: { autoRecall: 'off' } }), turnId: 'a', metrics: new VoiceMetrics(() => 0) });
    const result = await p.run('autoRecall', async () => ++calls, 0, new AbortController().signal);
    assert.equal(calls, enabled ? 0 : 1); assert.equal(result, enabled ? 0 : 1);
  }
});
test('budget exhaustion emits an event and returns fallback without aborting the turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events: string[] = []; const metrics = new VoiceMetrics(() => 31);
  const p = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics, emit: e => events.push(e.type) });
  const run = p.run('autoRecall', async () => new Promise<number>(() => {}), 0, new AbortController().signal);
  t.mock.timers.tick(31);
  assert.equal(await run, 0); assert.ok(events.includes('feature.budget_exceeded'));
  assert.equal(metrics.report().features.autoRecall?.budgetExceeded, 1);
});
test('deferred writes run after the answer and are drained; off writes never run', async () => {
  const p = createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId: 'a', metrics: new VoiceMetrics(() => 0) });
  let writes = 0; await p.after('memoryWrite', async () => { writes++; }, new AbortController().signal);
  assert.equal(writes, 0); await p.drain(); assert.equal(writes, 1);
});
test('metrics use closed feature sets, report median/p95 and costs, and cap retained turns', () => {
  let now = 0; const m = new VoiceMetrics(() => now, 2);
  for (const [id, ms] of [['a', 10], ['b', 30], ['c', 50]] as const) { m.speechEnd(id); now += ms; m.firstAudio(id); m.feature(id, 'asr', ms); }
  m.cost('tts', 5); m.cost('arbitrary-client-label', 100);
  const report = m.report(); assert.equal(report.turns, 2);
  assert.equal(report.speechEndToFirstAudio.medianMs, 40); assert.equal(report.speechEndToFirstAudio.p95Ms, 50);
  assert.deepEqual(report.costMicros, { tts: 5 });
  assert.ok(!m.render().includes('arbitrary-client-label'));
});
