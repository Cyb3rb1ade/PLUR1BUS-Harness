import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VoiceRegistry } from '../../../voice-providers/src/index.ts';
import { createVoiceV2, type VoiceClient } from '../../src/voice/v2.ts';
import { SessionStore } from '../../src/session/store.ts';
import { Compactor, defaultCompaction } from '../../src/session/compaction.ts';
import { TurnRunner } from '../../src/session/turn-loop.ts';
import { FakeChatProvider } from '../../src/session/provider.ts';
import type { SessionService } from '../../src/session/service.ts';

test('a session aborted while it opens is closed and its reservation released exactly once', async () => {
  const store = new SessionStore({ path: ':memory:' }); const runner = new TurnRunner({ store, compactor: new Compactor(store, defaultCompaction()), provider: () => new FakeChatProvider(), memory: { async recall() { return { text: '', degraded: null }; }, async capture() {}, async checkpoint() {} } });
  const session = store.createSession({ kind: 'direct', agentId: 'a', owner: 'owner', memoryMode: 'remember' });
  const lifetime = new AbortController(); let closes = 0, released = 0, end = false, wake: (() => void) | undefined;
  const live = { sendAudio() {}, sendText() {}, interrupt() {}, submitToolResult() {}, async close() { closes++; end = true; wake?.(); },
    events: { async *[Symbol.asyncIterator]() { while (!end) await new Promise<void>(resolve => { wake = resolve; }); } } };
  const reg: VoiceRegistry = { asr: {}, tts: {}, realtime: { xai: { id: 'xai', kind: 'realtime', toolCalls: true, connect: async () => { lifetime.abort(); return live; }, listModels: async () => [] } }, status: [] };
  const v2 = createVoiceV2({ config: () => ({}), sessions: () => ({ store, runner } as unknown as SessionService), modelsDir: '', signal: new AbortController().signal, clock: Date.now, registry: () => reg, allowed: async () => true,
    budget: { reserve: async () => true, record: async () => true, release: async () => { released++; } } });
  const client: VoiceClient = { sessionId: session.id, principal: 'owner', caller: { channel: 'cli', accountId: 'a', userId: 'u' }, approver: { person: 'owner', surface: 2 }, receive: async () => {}, stopPlayback() {}, event: () => {} };
  try {
    await assert.rejects(v2.openTalk({ sessionId: session.id, signal: lifetime.signal }, client), /unavailable/);
    assert.equal(closes, 1); assert.equal(released, 1);
  } finally { await v2.close(); await runner.idle(); store.close(); }
});
