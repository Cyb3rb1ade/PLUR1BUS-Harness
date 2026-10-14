import { it } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, type HarnessConfig } from '@plur1bus/config-schema';
import { validateParams } from '@plur1bus/rpc-schema';
import { licenceKey } from '../../../voice-providers/src/index.ts';
import { createVoiceV3 } from '../../src/voice/v3.ts';
import { voiceV3Catalog } from '../../src/voice/v3-catalog.ts';
import { modelsFor } from '../../../voice-providers/src/index.ts';
import type { CallContext } from '../../src/rpc/server.ts';

function fixture() {
  let config: HarnessConfig = defaults(); config.agents.main = {};
  const controller = new AbortController(); let writes = 0; const installed = new Set<string>();
  const service = createVoiceV3({ config: () => config, resolve: () => ({ userId: 'alice', kind: 'person', role: 'owner' }), hasAgent: id => Object.hasOwn(config.agents, id), signal: controller.signal, clock: () => 0, modelsDir: '/unused',
    notify: () => {}, set: async changes => { const next = structuredClone(config); for (const c of changes) { const keys = c.key.split('.'); let node = next as any; for (const k of keys.slice(0, -1)) node = node[k] ??= {}; node[keys.at(-1)!] = c.value; } const r = validate(next); if (!r.ok) throw new Error(r.errors.join(';')); config = r.config; writes++; },
    installed: async (_d, m) => installed.has(m.id), install: async m => { installed.add(m.id); return '/unused/' + m.id; },
    metrics: () => ({ speechEndToFirstAudio: { medianMs: 0, p95Ms: 0, samples: 0 }, featureCost: {}, windowSec: 300 }), session: () => undefined, openTalk: async () => { throw new Error('unused'); } });
  const ctx: CallContext = { requestId: 'r', connectionId: 'c', signal: controller.signal };
  const call = async (name: string, p: object = {}) => { assert.equal(validateParams(name, p).ok, true); return await service.methods[name]!(p, ctx) as any; };
  return { service, call, config: () => config, get writes() { return writes; } };
}
// In the shipped V3 catalog only German/fast needs a confirmation (its speech recogniser carries a non-commercial licence).
const germanFastRecogniser = () => modelsFor(voiceV3Catalog(), 'de', 'fast').stt;
const licenceError = (e: any) => e.error === 'E_VOICE_LICENCE';

it('a per-agent language or profile override cannot select models whose licence is unconfirmed', async () => {
  const f = fixture(); try {
    for (const override of [{ language: 'de' }, { profile: 'fast' as const }, { language: 'de', profile: 'fast' as const }, { language: 'de', profile: 'fast' as const, endpointingMs: 500 }])
      await assert.rejects(f.call('voice.agent.override.set', { agentId: 'main', override }), licenceError);
    assert.equal(f.writes, 0); assert.equal((await f.call('voice.agent.override.get', { agentId: 'main' })).override, null);
    await f.call('voice.agent.override.set', { agentId: 'main', override: { language: 'en', profile: 'fast' } });
    await f.call('voice.agent.override.set', { agentId: 'main', override: { language: 'de', profile: 'quality' } });
    await f.call('voice.agent.override.set', { agentId: 'main', override: { endpointingMs: 600 } }); assert.equal(f.writes, 3);
  } finally { await f.service.close(); }
});

it('a stored licence confirmation from the language dialog lets the agent override use that selection', async () => {
  const f = fixture(); try {
    const key = licenceKey(germanFastRecogniser());
    await assert.rejects(f.call('voice.language.set', { agentId: 'main', language: 'de', profile: 'fast' }), licenceError);
    await f.call('voice.language.set', { agentId: 'main', language: 'de', profile: 'fast', acceptLicences: [key] });
    assert.ok(f.config().voice.local.acceptedLicences[key]);
    await f.call('voice.agent.override.clear', { agentId: 'main' });
    await f.call('voice.agent.override.set', { agentId: 'main', override: { language: 'de', profile: 'fast' } });
    assert.equal((await f.call('voice.agent.override.get', { agentId: 'main' })).override.profile, 'fast');
  } finally { await f.service.close(); }
});
