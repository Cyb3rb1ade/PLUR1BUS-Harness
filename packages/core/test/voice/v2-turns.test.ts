// Voice V2 at the turn boundary: what a privacy-pinned turn never reaches, what a channel honestly reports about the engine,
// and how two turns that overlap behave with and without a voice turn profile. Overlap is held open with a latch the test
// releases itself, so nothing here waits on a clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVoice, resolveProfile } from '../../../voice-providers/src/index.ts';
import { FakeEngine, testFiles, testCatalogOverride } from '../../../voice-providers/test/helpers/fake-engine.ts';
import { createVoiceV2, type VoiceClient } from '../../src/voice/v2.ts';
import { createVoiceTurnProfile, type TurnProfile } from '../../src/voice/turn-profile.ts';
import { VoiceMetrics } from '../../src/voice/metrics.ts';
import { SessionStore } from '../../src/session/store.ts';
import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { FakeChatProvider } from '../../src/session/provider.ts';
import { SessionError } from '../../src/session/types.ts';
import type { SessionService } from '../../src/session/service.ts';

const caller = { channel: 'cli', accountId: 'a', userId: 'u' } as const;
const lastUser = (req: { messages: { role: string; text: string }[] }) => [...req.messages].reverse().find(m => m.role === 'user')?.text ?? '';
function latch() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
function turnProfile(turnId: string, privacyPin = false): TurnProfile {
  return createVoiceTurnProfile({ profile: resolveProfile({ enabled: true }), turnId, metrics: new VoiceMetrics(() => 0), privacyPin });
}
function runnerFixture() {
  const store = new SessionStore({ path: ':memory:' });
  const compactor = new Compactor(store, defaultCompaction());
  const recalls: { query: string; profiled: boolean }[] = [];
  const captures: { text: string; profiled: boolean }[] = [];
  const memory = {
    async recall(a: { query: string; turnProfile?: TurnProfile }) { recalls.push({ query: a.query, profiled: a.turnProfile !== undefined }); return { text: '', degraded: null }; },
    async capture(a: { messages: { content: string }[]; turnProfile?: TurnProfile }) { captures.push({ text: a.messages[0]!.content, profiled: a.turnProfile !== undefined }); },
    async checkpoint() {},
  };
  // Only a user message that starts with "voice" waits on the latch; typed turns complete straight away.
  const release = latch();
  const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider({ gate: async req => { if (lastUser(req).startsWith('voice')) await release.promise; } }), memory });
  const session = () => store.createSession({ kind: 'direct', agentId: 'a', owner: 'owner', memoryMode: 'remember' });
  return { store, runner, memory, recalls, captures, release, session, close: async () => { await runner.idle(); store.close(); } };
}
const refusedWhileRunning = (e: unknown) => e instanceof SessionError && e.code === 'conflict' && e.reason === 'turn-in-progress';

test('a second turn on a session with a running voice turn is refused, with or without a profile, and stores nothing', async () => {
  const f = runnerFixture(); try {
    const session = f.session();
    const first = f.runner.submit({ session, caller, text: 'voice one', turnProfile: turnProfile('t1') });
    assert.throws(() => f.runner.submit({ session, caller, text: 'typed two' }), refusedWhileRunning);
    assert.throws(() => f.runner.submit({ session, caller, text: 'voice two', turnProfile: turnProfile('t2') }), refusedWhileRunning);
    assert.deepEqual(f.store.listMessages(session.id).map(m => m.text), ['voice one']);
    f.release.open();
    assert.equal((await first.done).state, 'completed');
    assert.equal((await f.runner.submit({ session, caller, text: 'typed three' }).done).state, 'completed');
    assert.deepEqual(f.store.listMessages(session.id).map(m => m.text), ['voice one', 'echo[a]: voice one', 'typed three', 'echo[a]: typed three']);
  } finally { await f.close(); }
});

test('a typed turn holding the session refuses a voice turn the same way, and the typed turn still completes', async () => {
  const f = runnerFixture(); try {
    const session = f.session();
    const typed = f.runner.submit({ session, caller, text: 'typed one' });
    assert.throws(() => f.runner.submit({ session, caller, text: 'voice two', turnProfile: turnProfile('t2') }), refusedWhileRunning);
    assert.equal((await typed.done).state, 'completed');
    assert.equal(f.store.listMessages(session.id).some(m => m.text === 'voice two'), false);
  } finally { await f.close(); }
});

test('two sessions overlap: the voice profile reaches only the voice turn, never the typed turn running beside it', async () => {
  const f = runnerFixture(); try {
    const voiceSession = f.session(), typedSession = f.session();
    const voice = f.runner.submit({ session: voiceSession, caller, text: 'voice A', turnProfile: turnProfile('tA') });
    const typed = f.runner.submit({ session: typedSession, caller, text: 'typed B' });
    assert.equal((await typed.done).state, 'completed');
    assert.equal(f.recalls.find(r => r.query === 'typed B')!.profiled, false);
    f.release.open();
    assert.equal((await voice.done).state, 'completed');
    await f.runner.idle();
    assert.equal(f.recalls.find(r => r.query === 'voice A')!.profiled, true);
    assert.equal(f.captures.find(c => c.text === 'typed B')!.profiled, false);
    assert.equal(f.captures.find(c => c.text === 'voice A')!.profiled, true);
  } finally { await f.close(); }
});

test('a privacy-pinned voice turn sends nothing to recall or capture', async () => {
  const f = runnerFixture(); try {
    const session = f.session();
    f.release.open();
    assert.equal((await f.runner.submit({ session, caller, text: 'voice pinned', turnProfile: turnProfile('tp', true) }).done).state, 'completed');
    await f.runner.idle();
    assert.equal(f.recalls.some(r => r.query === 'voice pinned'), false);
    assert.equal(f.captures.some(c => c.text === 'voice pinned'), false);
  } finally { await f.close(); }
});

// The channel-level half of V2: a privacy-pinned channel never asks the policy about a cloud provider and reports the
// engine features as engine-fixed, not as applied.
async function channelFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'voice-turns-')); const engine = new FakeEngine(); const files = testFiles();
  const local = new LocalVoice({ modelsDir: dir, engine, config: { language: 'de', catalogOverride: testCatalogOverride('https://models.invalid', files) }, fetch: async url => new Response(Buffer.from(files[new URL(url).pathname.slice(1)]!)) });
  await local.setLanguage('de', { download: true });
  const store = new SessionStore({ path: ':memory:' }); const compactor = new Compactor(store, defaultCompaction());
  const runner = new TurnRunner({ store, compactor, provider: () => new FakeChatProvider(), memory: { async recall() { return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} } });
  const session = store.createSession({ kind: 'direct', agentId: 'a', owner: 'owner', memoryMode: 'remember' });
  const service = { store, compactor, runner } as SessionService;
  const counts = { allowed: 0, registry: 0 };
  const v2 = createVoiceV2({ config: () => ({ localRealtime: { enabled: true, endpointingMs: 1 } }), sessions: () => service, modelsDir: dir, signal: new AbortController().signal, clock: Date.now,
    local: () => local,
    registry() { counts.registry++; return { asr: {}, tts: {}, realtime: {}, status: [] }; },
    allowed: async () => { counts.allowed++; return true; },
    budget: { async reserve() { return true; }, async record() { return true; }, async release() {} } });
  const client: VoiceClient = { sessionId: session.id, principal: 'owner', caller: { channel: 'cli', accountId: 'a', userId: 'u' } as VoiceClient['caller'], approver: { person: 'owner', surface: 2 } as VoiceClient['approver'], receive: async () => {}, stopPlayback() {}, event() {} };
  return { v2, client, session, counts, async close() { await v2.close(); await runner.idle(); store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('a privacy-pinned channel never asks policy about a cloud provider and reports engine features as engine-fixed', async () => {
  const f = await channelFixture(); try {
    const channel = await f.v2.openTalk({ sessionId: f.session.id, privacyPin: true }, f.client);
    assert.equal(channel.route.kind, 'local');
    assert.deepEqual(channel.engineFeatures, { reranker: 'engine-fixed', postTurnRefine: 'engine-fixed' });
    assert.equal(f.counts.allowed, 0);
    assert.equal(f.counts.registry, 0);
    await channel.close();
  } finally { await f.close(); }
});
