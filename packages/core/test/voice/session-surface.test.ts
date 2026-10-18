import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { buildVoiceSessionMethods } from '../../src/rpc/voice-session-surface.ts';
import { guardMethods } from '../../src/rbac/guard.ts';
import { memoryAuditSink } from '../../src/rbac/audit.ts';
import type { Principal } from '../../src/rbac/types.ts';
import { OpenAIError } from '../../src/openai-auth/ports.ts';
import type { VoiceRequest } from '../../src/voice/ports.ts';
function fixture() {
  const config = defaults();
  config.providers.openaiVoice = { kind: 'api_key', billing_path: 'api_key', region: 'eu', licenceAccepted: true };
  let principal: Principal = { kind: 'person', role: 'member', userId: 'alice', agentRights: { main: 'use' } };
  let trust: 0 | 1 | 2 | 3 = 2;
  const requests: VoiceRequest[] = [], closed: string[] = [], audit = memoryAuditSink();
  let fail: unknown;
  const ac = new AbortController();
  const methods = guardMethods(buildVoiceSessionMethods({ config: () => config, clock: () => 10, audit,
    hasAgent: id => id === 'main', surface: () => trust,
    broker: () => ({ create: async r => { requests.push(r); if (fail) throw fail; return { sessionId: 'call', sdpAnswer: 'v=0', credential: 'redaction-marker' }; }, close: async id => { closed.push(id); } }),
  }), { now: () => 10, resolve: () => principal });
  const params = { agentId: 'main', provider: 'openai:realtime', model: 'fixture-model', transport: 'webrtc', sdp: 'v=0' };
  return { config, params, requests, closed, audit, ac, setPrincipal: (p: Principal) => { principal = p; }, setTrust: (t: typeof trust) => { trust = t; }, fail: (e: unknown) => { fail = e; },
    call: (p = params) => methods['voice.session.create']!(p, { requestId: 'r', connectionId: 'c', signal: ac.signal }) };
}
test('broker RPC projects credential-free output and derives identity, region and client delegation from authority', async () => {
  const f = fixture(); assert.deepEqual(await f.call(), { sessionId: 'call', sdpAnswer: 'v=0' });
  assert.equal(f.requests[0]!.user, 'alice'); assert.equal(f.requests[0]!.delegation, 'client');
  assert.deepEqual(f.requests[0]!.parent, { kind: 'api_key', region: 'eu' });
  assert.equal(f.audit.events[0]!.action, 'voice.session.created');
  assert.ok(!JSON.stringify(f.audit.events).includes('redaction-marker'));
});
for (const kind of ['agent', 'token-agent'] as const) test(`refuses ${kind} even with owner role`, async () => {
  const f = fixture(); f.setPrincipal({ kind: 'agent', role: 'owner', userId: 'bot', ...(kind === 'token-agent' ? { tokenScopes: ['*'] } : {}) });
  await assert.rejects(f.call(), (e: any) => e.error === 'E_DENIED'); assert.equal(f.requests.length, 0);
});
test('requires agent use right', async () => {
  const f = fixture(); f.setPrincipal({ kind: 'person', role: 'member', userId: 'alice' });
  await assert.rejects(f.call(), (e: any) => e.error === 'E_DENIED'); assert.equal(f.requests.length, 0);
});
for (const trust of [0, 1] as const) test(`refuses T${trust} before calling broker`, async () => {
  const f = fixture(); f.setTrust(trust); await assert.rejects(f.call(), (e: any) => e.reason === 'surface-denied'); assert.equal(f.requests.length, 0);
});
for (const billing of ['chatgpt_plan', 'cli_login', 'workload', undefined]) test(`no API-key fallback from ${billing}`, async () => {
  const f = fixture(); (f.config.providers.openaiVoice as any).billing_path = billing;
  await assert.rejects(f.call(), (e: any) => e.reason === 'voice-billing-path'); assert.equal(f.requests.length, 0);
});
for (const region of ['global', 'us', 'eu']) test(`supports configured ${region} region`, async () => {
  const f = fixture(); (f.config.providers.openaiVoice as any).region = region; await f.call(); assert.equal(f.requests[0]!.parent.region, region);
});
test('requires explicit provider licence confirmation', async () => {
  const f = fixture(); (f.config.providers.openaiVoice as any).licenceAccepted = false;
  await assert.rejects(f.call(), (e: any) => e.error === 'E_VOICE_LICENSE'); assert.equal(f.requests.length, 0);
});
test('empty budget is exposed without upstream details', async () => {
  const f = fixture(); f.fail(new OpenAIError('budget-exceeded')); await assert.rejects(f.call(), (e: any) => e.error === 'E_VOICE_BUDGET');
});
test('foreign error contents never escape the surface', async () => {
  const f = fixture(); f.fail(new Error('redaction-marker')); await assert.rejects(f.call(), (e: any) => e.error === 'E_VOICE_UNAVAILABLE' && !String(e).includes('redaction-marker'));
});
test('audit failure closes the created session', async () => {
  const f = fixture(); f.audit.append = () => { throw new Error('disk full'); };
  await assert.rejects(f.call()); assert.deepEqual(f.closed, ['call']);
});
test('cancelled request cannot start spending', async () => {
  const f = fixture(); f.ac.abort(); await assert.rejects(f.call()); assert.equal(f.requests.length, 0);
});
test('closed RPC schema rejects client-supplied authority and ephemeral requests', async () => {
  const { validateParams, validateResult } = await import('@plur1bus/rpc-schema');
  const f = fixture();
  assert.equal(validateParams('voice.session.create', f.params).ok, true);
  for (const extra of [{ parent: { kind: 'api_key' } }, { surface: { trust: 3 } }, { user: 'owner' }, { billing_path: 'api_key' }, { mode: 'minted_ephemeral' }]) {
    assert.equal(validateParams('voice.session.create', { ...f.params, ...extra }).ok, false);
  }
  assert.equal(validateResult('voice.session.create', { sessionId: 's', credential: 'redaction-marker' }).ok, false);
});
