import { it } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, type HarnessConfig } from '@plur1bus/config-schema';
import { validateParams } from '@plur1bus/rpc-schema';
import { licenceKey, modelsFor } from '../../../voice-providers/src/index.ts';
import { createVoiceV3 } from '../../src/voice/v3.ts';
import { voiceV3Catalog } from '../../src/voice/v3-catalog.ts';
import type { CallContext } from '../../src/rpc/server.ts';
import type { VoiceChannel } from '../../src/voice/v2.ts';

function fixture(options: { openTalk?: () => Promise<VoiceChannel> } = {}) {
  let config: HarnessConfig = defaults(); config.agents.main = {};
  const controller = new AbortController(); let writes = 0, downloads = 0, opened = 0, closed = 0; const installed = new Set<string>(); const events: { name: string; params: any }[] = [];
  const channel: VoiceChannel = { send() {}, speech() {}, async idle() {}, async close() { closed++; }, async setLanguage() {}, route: { kind: 'local' }, engineFeatures: { reranker: 'engine-fixed', postTurnRefine: 'engine-fixed' } };
  const service = createVoiceV3({ config: () => config, resolve: () => ({ userId: 'alice', kind: 'person', role: 'owner' }), hasAgent: id => Object.hasOwn(config.agents, id), signal: controller.signal, clock: () => 0, modelsDir: '/unused',
    notify: (name, params) => { events.push({ name, params }); },
    set: async changes => { const next = structuredClone(config); for (const c of changes) { const keys = c.key.split('.'); let node = next as any; for (const k of keys.slice(0, -1)) node = node[k] ??= {}; node[keys.at(-1)!] = c.value; } const r = validate(next); if (!r.ok) throw new Error(r.errors.join(';')); config = r.config; writes++; },
    installed: async (_d, m) => installed.has(m.id), install: async m => { downloads++; installed.add(m.id); return '/unused/' + m.id; },
    metrics: () => ({ speechEndToFirstAudio: { medianMs: 0, p95Ms: 0, samples: 0 }, featureCost: {}, windowSec: 300 }),
    session: id => id.startsWith('chat') ? { agentId: 'main', owner: 'alice', archivedAt: null } : undefined,
    audio: { async receive() {}, stop() {} }, openTalk: options.openTalk ?? (async () => { opened++; return channel; }) });
  const call = async (name: string, p: object = {}, connectionId = 'conn-1') => { assert.equal(validateParams(name, p).ok, true); return await service.methods[name]!(p, { requestId: 'r', connectionId, signal: controller.signal } as CallContext) as any; };
  return { service, call, events, get writes() { return writes; }, get downloads() { return downloads; }, get opened() { return opened; }, get closed() { return closed; }, installed, config: () => config };
}
const germanFast = () => modelsFor(voiceV3Catalog(), 'de', 'fast');

it('language selection needs the exact E_VOICE_LICENCE confirmation before any download, even for installed models', async () => {
  const f = fixture(); try {
    const { stt } = germanFast(); const key = licenceKey(stt);
    for (const acceptLicences of [undefined, [], ['kroko-de'], [key.toUpperCase()]])
      await assert.rejects(f.call('voice.language.set', { language: 'de', profile: 'fast', ...(acceptLicences ? { acceptLicences } : {}) }), (e: any) => e.error === 'E_VOICE_LICENCE' && e.detail === stt.licence.id);
    assert.equal(f.downloads, 0); assert.equal(f.writes, 0);
    f.installed.add(stt.id);
    await assert.rejects(f.call('voice.language.set', { language: 'de', profile: 'fast' }), (e: any) => e.error === 'E_VOICE_LICENCE'); assert.equal(f.writes, 0);
    await f.call('voice.language.set', { language: 'de', profile: 'fast', acceptLicences: [key] });
    assert.ok(f.config().voice.local.acceptedLicences[key]);
  } finally { await f.service.close(); }
});

it('E_VOICE_LICENSE (single model install) and E_VOICE_LICENCE (language dialog) are never swapped', async () => {
  const f = fixture(); try {
    const { stt } = germanFast();
    await assert.rejects(f.call('voice.models.install', { modelId: stt.id }), (e: any) => e.error === 'E_VOICE_LICENSE' && e.reason === 'confirmation-required');
    await assert.rejects(f.call('voice.language.set', { language: 'de', profile: 'fast' }), (e: any) => e.error === 'E_VOICE_LICENCE' && e.reason === undefined);
    assert.equal(f.downloads, 0);
  } finally { await f.service.close(); }
});

it('at most 16 realtime sessions run at once and a disconnect releases all of its sessions', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 16; i++) (await f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-' + i }, 'conn-' + (i % 2)));
    await assert.rejects(f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-x' }), (e: any) => e.error === 'E_VOICE_UNAVAILABLE');
    assert.equal(f.opened, 16); assert.equal((await f.call('voice.status')).activeSessions, 16);
    await f.service.connectionClosed('conn-0'); assert.equal(f.closed, 8); assert.equal((await f.call('voice.status')).activeSessions, 8);
    await f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-y' }, 'conn-0');
    await f.service.close(); assert.equal(f.closed, 8 + 9);
  } finally { await f.service.close(); }
});

it('a failing start frees its slot and reports a generic error', async () => {
  const f = fixture({ openTalk: async () => { throw new Error('provider key sk-secret rejected'); } }); try {
    for (let i = 0; i < 20; i++) await assert.rejects(f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-1' }), (e: any) => e.error === 'E_VOICE_UNAVAILABLE' && !JSON.stringify(e).includes('sk-secret'));
    assert.equal((await f.call('voice.status')).activeSessions, 0);
    assert.ok(f.events.some(e => e.name === 'voice.realtime.state' && e.params.state === 'failed'));
  } finally { await f.service.close(); }
});
