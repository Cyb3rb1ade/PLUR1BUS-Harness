import { it } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, type HarnessConfig } from '@plur1bus/config-schema';
import { validateParams, validateResult, type VoiceRealtimeProfileInput } from '@plur1bus/rpc-schema';
import { createVoiceV3, type VoiceV3Deps, VOICE_FEATURES } from '../../src/voice/v3.ts';
import { loadCatalog } from '../../../voice-providers/src/index.ts';
import type { Principal } from '../../src/rbac/types.ts';
import type { CallContext, NotifyOptions } from '../../src/rpc/server.ts';
import type { VoiceChannel } from '../../src/voice/v2.ts';

// Testwelle 5 (Voice V3). Same fixture shape as v3.test.ts, plus a `configure` hook so a test can change the
// installation before the catalogue is built (the language catalogue is fixed at service creation).
const RESEARCH_MODEL = 'piper-en-lessac-low';
const RESEARCH_LICENCE = 'Blizzard-2013-Lessac-research';

function fixture(configure: (c: HarnessConfig) => void = () => {}) {
  let config: HarnessConfig = defaults(); configure(config); config.agents.main = {}; config.agents.other = {};
  let principal: Principal | null = { userId: 'alice', kind: 'person', role: 'owner' };
  const controller = new AbortController(); let downloads = 0, writes = 0, closes = 0;
  const installed = new Set<string>(); const events: { name: string; params: any; options: NotifyOptions }[] = [];
  const channel = (): VoiceChannel => ({ send() {}, speech() {}, async idle() {}, async close() { closes++; }, async setLanguage() {}, route: { kind: 'local' }, engineFeatures: { reranker: 'engine-fixed', postTurnRefine: 'engine-fixed' } });
  const service = createVoiceV3({ config: () => config, resolve: () => principal, hasAgent: id => Object.hasOwn(config.agents, id), signal: controller.signal, clock: () => 0, modelsDir: '/unused-models',
    notify: (name, params, options) => events.push({ name, params, options }),
    set: async changes => { const next = structuredClone(config); for (const change of changes) { const keys = change.key.split('.'); let node = next as any; for (const key of keys.slice(0, -1)) node = node[key] ??= {}; node[keys.at(-1)!] = change.value; } const result = validate(next); if (!result.ok) throw new Error(result.errors.join(';')); config = result.config; writes++; },
    installed: async (_dir, m) => installed.has(m.id), install: async m => { downloads++; installed.add(m.id); return '/unused-models/' + m.id; },
    metrics: () => ({ speechEndToFirstAudio: { medianMs: 0, p95Ms: 0, samples: 0 }, featureCost: {}, windowSec: 300 }),
    session: id => id === 'chat-main' ? { agentId: 'main', owner: 'alice', archivedAt: null } : undefined,
    audio: { async receive() {}, stop() {} },
    openTalk: async () => channel() });
  const ctx: CallContext = { requestId: 'voice-test', connectionId: 'connection-alice', signal: controller.signal };
  const call = async (name: string, p: object = {}, context = ctx) => {
    const params = validateParams(name, p); assert.equal(params.ok, true, JSON.stringify(params));
    const result = await service.methods[name]!(p, context); const valid = validateResult(name, result); assert.equal(valid.ok, true, JSON.stringify(valid)); return result as any;
  };
  return { service, call, ctx, events, installed, config: () => config, principal: (p: Principal | null) => { principal = p; },
    get downloads() { return downloads; }, get writes() { return writes; }, get closes() { return closes; } };
}

// ---- Latency budget: exact switch, exact sums, boundary ----

it('names the exact overflowing switch and both sums, and saves nothing', async () => {
  const f = fixture();
  try {
    const rt: VoiceRealtimeProfileInput = structuredClone(f.config().voice.v3.realtime);
    rt.features.autoRecall = { mode: 'on', maxMs: 400 };
    rt.features.promptEnrichment = { mode: 'on', maxMs: 400 };
    rt.features.reranker = { mode: 'on', maxMs: 300 }; // 400 + 400 + 300 = 1100 > 1000, first overflow at reranker
    await assert.rejects(f.call('voice.realtime.profile.set', rt), (e: any) =>
      e.error === 'E_VOICE_BUDGET' && e.reason === 'latency-budget' && e.detail === 'reranker' &&
      e.ids?.feature === 'reranker' && e.ids?.totalMs === '1100' && e.ids?.budgetMs === '1000');
    assert.equal(f.writes, 0, 'a rejected budget must not change configuration');
  } finally { await f.service.close(); }
});

it('accepts a total exactly equal to the budget and rejects one millisecond more', async () => {
  const f = fixture();
  try {
    const rt: VoiceRealtimeProfileInput = structuredClone(f.config().voice.v3.realtime);
    rt.features.autoRecall = { mode: 'on', maxMs: 500 };
    rt.features.promptEnrichment = { mode: 'on', maxMs: 500 }; // exactly 1000
    await f.call('voice.realtime.profile.set', rt);
    assert.equal(f.writes, 1);
    rt.features.toolSchemas = { mode: 'on', maxMs: 1 }; // 1001
    await assert.rejects(f.call('voice.realtime.profile.set', rt), (e: any) =>
      e.error === 'E_VOICE_BUDGET' && e.ids?.feature === 'toolSchemas' && e.ids?.totalMs === '1001');
    assert.equal(f.writes, 1);
  } finally { await f.service.close(); }
});

// ---- Per-agent override: clearing falls back to the installation value ----

it('clearing an agent override falls back to the current global value, and only that agent changes', async () => {
  const f = fixture();
  try {
    await f.call('voice.agent.override.set', { agentId: 'main', override: { endpointingMs: 750 } });
    const global = structuredClone(f.config().voice.v3.realtime);
    await f.call('voice.realtime.profile.set', { ...global, endpointingMs: 600 });
    let main = await f.call('voice.agent.override.get', { agentId: 'main' });
    assert.equal(main.effective.endpointingMs, 750, 'the override still wins over the new global value');
    assert.equal((await f.call('voice.agent.override.get', { agentId: 'other' })).effective.endpointingMs, 600);
    await f.call('voice.agent.override.clear', { agentId: 'main' });
    main = await f.call('voice.agent.override.get', { agentId: 'main' });
    assert.equal(main.override, null);
    assert.equal(main.effective.endpointingMs, 600, 'after clear the global value applies, not the old override');
  } finally { await f.service.close(); }
});

it('an agent reads only its own override and gets no value of another agent back', async () => {
  const f = fixture();
  try {
    await f.call('voice.agent.override.set', { agentId: 'other', override: { endpointingMs: 912 } });
    f.principal({ userId: 'main', kind: 'agent', role: 'owner' });
    const own = await f.call('voice.agent.override.get', { agentId: 'main' });
    assert.equal(own.override, null);
    await assert.rejects(f.call('voice.agent.override.get', { agentId: 'other' }), (e: any) => {
      assert.equal(e.error, 'E_DENIED');
      assert.ok(!JSON.stringify(e).includes('912'), 'the refusal must not leak the other override');
      return true;
    });
  } finally { await f.service.close(); }
});

// ---- Licence paths: LICENSE (model install) and LICENCE (language selection) ----
// A gated speech-to-text model (unconfirmed CC-BY-SA) is put into the English catalogue through the owner's
// `voice.local.catalogOverride`, which is the supported route. The config schema does not let a research voice
// be stored as a profile, so that case is asserted separately below.
const GATED_STT = 'kroko-de';
const GATED_KEY = `${GATED_STT}@CC-BY-SA`;
// The override replaces a language entry as a whole, so the built-in English entry is the base.
const gatedStt = (c: HarnessConfig) => { const en = structuredClone(loadCatalog().languages.en!); en.stt = { fast: GATED_STT, quality: GATED_STT }; c.voice.local.catalogOverride = { languages: { en } }; };

it('model install refuses a research licence with E_VOICE_LICENSE and names the licence', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.call('voice.models.install', { modelId: RESEARCH_MODEL }), (e: any) =>
      e.error === 'E_VOICE_LICENSE' && e.reason === 'confirmation-required' && e.detail === RESEARCH_LICENCE && e.ids?.modelId === RESEARCH_MODEL);
    assert.equal(f.downloads, 0);
  } finally { await f.service.close(); }
});

it('language selection with a gated model needs E_VOICE_LICENCE, not E_VOICE_LICENSE, and downloads nothing', async () => {
  const f = fixture(gatedStt);
  try {
    await assert.rejects(f.call('voice.language.set', { language: 'en', profile: 'fast' }), (e: any) =>
      e.error === 'E_VOICE_LICENCE' && e.detail === 'CC-BY-SA' && e.ids?.modelId === GATED_STT);
    assert.equal(f.downloads, 0, 'nothing is downloaded before every licence is accepted');
    assert.deepEqual(await f.call('voice.language.get'), { language: 'de', profile: 'fast' });
  } finally { await f.service.close(); }
});

it('language selection does not accept a bare model id, only the exact modelId@licenceId key', async () => {
  const f = fixture(gatedStt);
  try {
    await assert.rejects(f.call('voice.language.set', { language: 'en', profile: 'fast', acceptLicences: [GATED_STT] }), (e: any) => e.error === 'E_VOICE_LICENCE');
    await assert.rejects(f.call('voice.language.set', { language: 'en', profile: 'fast', acceptLicences: [`${GATED_STT}@Other-Licence`] }), (e: any) => e.error === 'E_VOICE_LICENCE');
    assert.equal(f.downloads, 0);
    assert.equal(f.config().voice.local.acceptedLicences[GATED_KEY], undefined);
  } finally { await f.service.close(); }
});

it('the exact key records the acceptance and selects the language', async () => {
  const f = fixture(gatedStt);
  try {
    const result = await f.call('voice.language.set', { language: 'en', profile: 'fast', acceptLicences: [GATED_KEY] });
    assert.equal(result.ok, true);
    assert.deepEqual(await f.call('voice.language.get'), { language: 'en', profile: 'fast' });
    assert.ok(f.config().voice.local.acceptedLicences[GATED_KEY], 'the acceptance is stored under the exact key');
    assert.ok(f.installed.has(GATED_STT), 'the accepted model is installed');
  } finally { await f.service.close(); }
});

it('the config schema refuses a research voice as a profile, so it cannot be preselected', () => {
  const config = defaults();
  config.voice.v3.profiles.en.fast = RESEARCH_MODEL;
  assert.equal(validate(config).ok, false);
});

// ---- Realtime lifecycle: start, stop, double start, stop without start, audience ----

it('stop without a start, and a second stop, are E_NOT_FOUND', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.call('voice.realtime.stop', { sessionId: '00000000-0000-4000-8000-000000000000' }), (e: any) => e.error === 'E_NOT_FOUND');
    const started = await f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-main' });
    await f.call('voice.realtime.stop', { sessionId: started.sessionId });
    assert.equal(f.closes, 1);
    await assert.rejects(f.call('voice.realtime.stop', { sessionId: started.sessionId }), (e: any) => e.error === 'E_NOT_FOUND');
    assert.equal(f.closes, 1, 'a second stop must not close the channel again');
  } finally { await f.service.close(); }
});

it('a second start on the same chat opens its own session, and stopping one leaves the other running', async () => {
  const f = fixture();
  try {
    const first = await f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-main' });
    const second = await f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-main' });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.ok(f.service.channel(second.sessionId, f.ctx.connectionId));
    await f.call('voice.realtime.stop', { sessionId: first.sessionId });
    assert.equal(f.service.channel(first.sessionId, f.ctx.connectionId), undefined);
    assert.ok(f.service.channel(second.sessionId, f.ctx.connectionId), 'the other session keeps its channel');
    assert.equal(f.closes, 1);
  } finally { await f.service.close(); }
});

it('state and transcript events stay with the originating connection, and a second connection cannot stop the session', async () => {
  const f = fixture();
  try {
    const result = await f.call('voice.realtime.start', { agentId: 'main', chatSessionId: 'chat-main' });
    const other = { ...f.ctx, connectionId: 'connection-alice-2' };
    await assert.rejects(f.call('voice.realtime.stop', { sessionId: result.sessionId }, other), (e: any) => e.error === 'E_NOT_FOUND');
    assert.equal(f.service.channel(result.sessionId, 'connection-alice-2'), undefined);
    const before = f.events.length;
    assert.ok(f.events.length > 0, 'the start emitted state events');
    for (const event of f.events) assert.deepEqual(event.options.audience, [{ connectionId: 'connection-alice' }]);
    await f.service.connectionClosed('connection-alice-2');
    assert.equal(f.closes, 0, 'closing an unrelated connection does not stop the session');
    assert.equal(f.events.length, before);
    await f.service.connectionClosed('connection-alice');
    assert.equal(f.closes, 1);
  } finally { await f.service.close(); }
});
