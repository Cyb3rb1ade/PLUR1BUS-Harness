import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVoice, type VoiceRegistry } from '../../../voice-providers/src/index.ts';
import { FakeEngine, testFiles, testCatalogOverride } from '../../../voice-providers/test/helpers/fake-engine.ts';
import { createVoiceV2, type VoiceClient } from '../../src/voice/v2.ts';
import { SessionStore } from '../../src/session/store.ts';
import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { FakeChatProvider } from '../../src/session/provider.ts';
import type { SessionService } from '../../src/session/service.ts';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'voice-v2-')); const engine = new FakeEngine(); const files = testFiles();
  const local = new LocalVoice({ modelsDir: dir, engine, config: { language: 'de', catalogOverride: testCatalogOverride('https://models.invalid', files) }, fetch: async url => new Response(Buffer.from(files[new URL(url).pathname.slice(1)]!)) });
  await local.setLanguage('de', { download: true }); await local.setLanguage('en', { download: true });
  const store = new SessionStore({ path: ':memory:' }); const compactor = new Compactor(store, defaultCompaction());
  const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider(), memory: { async recall() { return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} } });
  const session = store.createSession({ kind: 'direct', agentId: 'a', owner: 'owner', memoryMode: 'remember' });
  const service = { store, compactor, runner } as SessionService;
  let registryCalls = 0, admitted = 0, released = 0; const events: unknown[] = []; const frames: unknown[] = [];
  const v2 = createVoiceV2({ config: () => ({ localRealtime: { enabled: true, endpointingMs: 1 } }), sessions: () => service, modelsDir: dir, signal: new AbortController().signal, clock: Date.now,
    local: () => local, registry() { registryCalls++; return { asr: {}, tts: {}, realtime: {}, status: [] }; }, allowed: async () => true,
    budget: { async reserve() { admitted++; return true; }, async record() { return true; }, async release() { released++; } } });
  const client: VoiceClient = { sessionId: session.id, principal: 'owner', caller: { channel: 'cli', accountId: 'a', userId: 'u' }, approver: { person: 'owner', surface: 2 }, receive: async f => { frames.push(f); }, stopPlayback() {}, event: e => events.push(e) };
  return { v2, local, engine, store, runner, session, client, events, frames, registryCalls: () => registryCalls, admitted: () => admitted, released: () => released,
    async close() { await v2.close(); await runner.idle(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('privacy pin performs no cloud construction; owner binding precedes admission', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.v2.openTalk({ sessionId: f.session.id }, { ...f.client, principal: 'stranger' }), /voice-denied/); assert.equal(f.admitted(), 0);
    const c = await f.v2.openTalk({ sessionId: f.session.id, privacyPin: true }, f.client); assert.equal(c.route.kind, 'local'); assert.equal(f.registryCalls(), 0);
    await Promise.all([c.close(), c.close(), f.v2.close()]); assert.equal(f.released(), 1); assert.ok(!JSON.stringify([f.events, f.frames, c.route]).includes('apiKeyRef'));
  } finally { await f.close(); }
});
test('runtime language switch closes the old ASR/VAD leases and loads the new language', async () => {
  const f = await fixture(); try {
    const c = await f.v2.openTalk({ sessionId: f.session.id, privacyPin: true }, f.client);
    const before = f.engine.events.length; await c.setLanguage('en'); assert.equal(f.local.current()?.language, 'en');
    assert.ok(f.engine.events.slice(before).includes('dispose:t-stt-de')); assert.ok(f.events.some(e => (e as { type: string }).type === 'voice.language_changed'));
    await c.close(); assert.equal(f.released(), 1);
  } finally { await f.close(); }
});
test('provider connect failure is sanitised; fallback preserves privacy and session ownership', async () => {
  const f = await fixture(); try {
    let calls = 0; const reg: VoiceRegistry = { asr: {}, tts: {}, realtime: { xai: { id: 'xai', kind: 'realtime', toolCalls: true, async connect() { calls++; throw new Error('private credential'); }, async listModels() { throw new Error('discovery must not run'); } } }, status: [] };
    const v2 = createVoiceV2({ config: () => ({}), sessions: () => ({ store: f.store, runner: f.runner } as SessionService), modelsDir: '', signal: new AbortController().signal, clock: Date.now, local: () => f.local, registry: () => reg, allowed: async () => true, budget: { reserve: async () => true, record: async () => true, release: async () => {} } });
    const c = await v2.openTalk({ sessionId: f.session.id }, f.client); assert.equal(c.route.kind, 'local'); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(f.events).includes('private credential')); await v2.close();
  } finally { await f.close(); }
});
test('admitted realtime route sends PCM, measures trusted speech boundary and closes once', async () => {
  const f = await fixture(); let now = 0, closes = 0, sent = 0; let end = false; let wake: (() => void) | undefined;
  const events: import('../../../voice-providers/src/index.ts').RealtimeEvent[] = [];
  const live = { sendAudio(pcm: Uint8Array) { sent += pcm.length; }, sendText() {}, interrupt() {}, submitToolResult() {}, async close() { closes++; end = true; wake?.(); },
    events: { async *[Symbol.asyncIterator]() { while (!end || events.length) { if (events.length) yield events.shift()!; else await new Promise<void>(resolve => { wake = resolve; }); } } } };
  const reg: VoiceRegistry = { asr: {}, tts: {}, realtime: { xai: { id: 'xai', kind: 'realtime', toolCalls: true, connect: async () => live, listModels: async () => [] } }, status: [] };
  const v2 = createVoiceV2({ config: () => ({}), sessions: () => ({ store: f.store, runner: f.runner } as SessionService), modelsDir: '', signal: new AbortController().signal, clock: () => now, registry: () => reg, allowed: async () => true, budget: { reserve: async () => true, record: async () => true, release: async () => {} } });
  try {
    const c = await v2.openTalk({ sessionId: f.session.id }, f.client); assert.equal(c.route.kind, 'realtime');
    c.send(new Uint8Array(8)); assert.equal(sent, 8); c.speech(true); c.speech(false); now = 20;
    events.push({ type: 'audio', chunk: { data: new Uint8Array(2), format: 'pcm16', sampleRate: 16000 } }); wake?.();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(v2.metrics().speechEndToFirstAudio.medianMs, 20);
    await Promise.all([c.close(), v2.close()]); assert.equal(closes, 1);
  } finally { await v2.close(); await f.close(); }
});
