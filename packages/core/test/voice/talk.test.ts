import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTalkSession } from '../../src/voice/talk.ts';
import { VoiceMetrics } from '../../src/voice/metrics.ts';
import { resolveProfile, type AsrEvent, type AudioChunk } from '../../../voice-providers/src/index.ts';
function queue<T>() { const items: T[] = []; let wake: (() => void) | undefined; let closed = false; return { push(v: T) { items.push(v); wake?.(); }, close() { closed = true; wake?.(); }, async *[Symbol.asyncIterator]() { while (!closed || items.length) { if (items.length) yield items.shift()!; else await new Promise<void>(r => { wake = r; }); } } }; }
function fixture(t: import('node:test').TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = queue<AsrEvent>(); const cancelled: string[] = []; const turns: string[] = []; const audio: AudioChunk[] = []; const spoken: string[] = [];
  let confirm: (() => void) | undefined; let n = 0; let asrClosed = 0;
  const session = createTalkSession({ asr: { id: 'local', kind: 'asr', openStream: async () => ({ events, sendAudio() {}, commit() {}, async close() { asrClosed++; events.close(); } }), transcribe: async () => { throw new Error('unused'); }, listModels: async () => [] },
    tts: { id: 'local', kind: 'tts', textInputStreaming: false, formats: ['pcm16'], async *synthesizeStream(text, opts) { spoken.push(String(text)); opts?.signal?.throwIfAborted(); yield { data: new Uint8Array(2), format: 'pcm16', sampleRate: 16000 }; }, synthesize: async () => { throw new Error('unused'); }, listModels: async () => [], listVoices: async () => [] },
    profile: resolveProfile({ enabled: true, endpointingMs: 10, speculativeTurnStart: true }), metrics: new VoiceMetrics(),
    agent: { start(text, profile) { const id = `turn${++n}`; turns.push(text); const done = (async () => { profile.onDelta?.('Hello. Second sentence.'); if (profile.confirmed) await profile.confirmed; profile.signal?.throwIfAborted(); return { state: 'completed' as const, reply: 'Hello. Second sentence.' }; })().catch(() => ({ state: 'failed' as const })); confirm = undefined; return { turnId: id, done }; }, cancel(id) { cancelled.push(id); } },
    receive: async chunk => { audio.push(chunk); }, event() {}, signal: new AbortController().signal });
  return { session, events, turns, cancelled, audio, spoken, confirm, closed: () => asrClosed };
}
test('endpointing, speculative cancellation and sentence audio delivery', async t => {
  const f = fixture(t); const s = await f.session;
  s.speech(true); f.events.push({ type: 'final', text: 'first' }); await new Promise(r => setImmediate(r)); s.speech(false);
  assert.deepEqual(f.turns, ['first']); assert.equal(f.audio.length, 0);
  f.events.push({ type: 'partial', text: 'first changed' }); await new Promise(r => setImmediate(r)); assert.equal(f.cancelled.length, 1);
  f.events.push({ type: 'final', text: 'first changed' }); await new Promise(r => setImmediate(r));
  t.mock.timers.tick(10); await s.idle(); assert.ok(f.audio.length > 0); assert.ok(f.spoken.length >= 2);
  await s.close(); assert.equal(f.closed(), 1);
});
test('barge-in cancels the active turn synchronously at speech start', async t => {
  const f = fixture(t); const s = await f.session;
  s.speech(true); f.events.push({ type: 'final', text: 'hello' }); await new Promise(r => setImmediate(r)); s.speech(false); t.mock.timers.tick(10);
  s.speech(true); assert.equal(f.cancelled.length, 1); await s.idle(); assert.equal(f.audio.length, 0); await s.close();
});
