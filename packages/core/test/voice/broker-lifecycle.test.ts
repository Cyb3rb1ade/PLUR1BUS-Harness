import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBroker, type VoicePorts, type VoiceEvent } from '../../src/voice/index.ts';
import { LiveService, type LiveClient } from '../../src/voice/live.ts';
import { Sensitive } from '../../src/openai-auth/index.ts';
import { FakeOpenAI } from '../fixtures/openai/server.ts';

function setup(capacity = 2) {
  const http = new FakeOpenAI(), attempts: string[] = [], closed: string[] = [], notices: unknown[] = [], released: string[] = [];
  const hooks = { close: async (_id: string): Promise<void> => {}, attach: async (_url: string, _onEvent: (e: VoiceEvent) => Promise<void>): Promise<void> => {} };
  const ports: VoicePorts = { http, clock: { now: () => http.now }, credentials: { lease: async () => new Sensitive(http.secret()) }, models: { allowed: async () => true },
    budget: { reserve: async () => true, record: async () => true, release: async id => { released.push(id); } },
    policy: { authorize: async () => true, tool: async () => ({}), spend: async () => {} },
    sideband: { attach: async r => { await hooks.attach(r.url, r.onEvent); return { send: async () => {}, close: async () => {} }; } },
    sessions: { close: async id => { attempts.push(id); await hooks.close(id); closed.push(id); } },
    audit: () => {}, notice: async v => { notices.push(v); }, capacity };
  const request = { agent: 'agent-a', user: 'owner', provider: 'openai:gpt-live' as const, parent: { kind: 'api_key' as const, region: 'eu' as const }, surface: { authenticated: true, trust: 2 as const, kind: 'desktop' as const }, transport: 'webrtc' as const, model: 'gpt-live-1', sdp: 'v=0\r\nsynthetic-offer' };
  return { http, ports, request, attempts, closed, notices, released, hooks, broker: new VoiceBroker(ports) };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('concurrent close of one session reaches the provider and the notice once', async () => {
  const s = setup(); const { sessionId } = await s.broker.create(s.request);
  const releases: (() => void)[] = []; s.hooks.close = () => new Promise<void>(resolve => { releases.push(resolve); });
  const a = s.broker.close(sessionId, 'budget'), b = s.broker.close(sessionId, 'budget');
  await tick(); await tick(); releases.forEach(r => r()); await Promise.all([a, b]);
  assert.deepEqual(s.attempts, [sessionId]); assert.equal(s.notices.length, 1); assert.equal(s.released.length, 1);
});

test('a budget event that arrives during attach closes the provider session and releases once', async () => {
  const s = setup(); s.ports.budget.record = async () => false;
  s.hooks.attach = async (_url, onEvent) => { await onEvent({ type: 'response.done', eventId: 'early', seconds: 1 }); };
  await assert.rejects(s.broker.create(s.request), { code: 'budget-exceeded' });
  assert.equal(s.attempts.length, 1); assert.equal(s.released.length, 1);
});

test('capacity stays occupied while an ephemeral reservation is attaching', async () => {
  const s = setup(1); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' });
  let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  s.hooks.attach = async url => { if (url.includes('call_id=late-call')) await gate; };
  const attaching = s.broker.attachEphemeral(secret.reservation, 'late-call'); await tick();
  await assert.rejects(s.broker.create(s.request), { code: 'capacity-exceeded' });
  await assert.rejects(s.broker.mint({ ...s.request, provider: 'openai:realtime' }), { code: 'capacity-exceeded' });
  open(); await attaching; await s.broker.dispose();
});

test('dispose closes every session even when one close fails, then reports the failure', async () => {
  const s = setup(); const a = await s.broker.create(s.request), b = await s.broker.create(s.request);
  s.hooks.close = async id => { if (id === a.sessionId) throw new Error('provider down'); };
  await assert.rejects(s.broker.dispose());
  assert.deepEqual([...s.attempts].sort(), [a.sessionId, b.sessionId].sort()); assert.deepEqual(s.closed, [b.sessionId]);
});

test('dispose revokes pending ephemeral secrets even when a session close fails', async () => {
  const s = setup(); const a = await s.broker.create(s.request); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' });
  s.hooks.close = async id => { if (id === a.sessionId) throw new Error('provider down'); };
  await assert.rejects(s.broker.dispose());
  assert.throws(() => secret.consume(), { code: 'ephemeral-consumed' }); assert.ok(s.released.includes(secret.reservation));
});

test('sweep keeps closing expired sessions after one close fails', async () => {
  const s = setup(); const a = await s.broker.create(s.request), b = await s.broker.create(s.request);
  s.hooks.close = async id => { if (id === a.sessionId) throw new Error('provider down'); };
  s.http.now += 3600000; await assert.rejects(s.broker.sweep());
  assert.deepEqual(s.closed, [b.sessionId]);
});

test('LiveService.close still disposes broker sessions when a handle channel fails to close', async () => {
  const s = setup(); s.ports.websocket = { start: async () => ({ id: 'ws-1' }) };
  const client: LiveClient = { authenticated: true, person: 'owner', session: 'chat', model: 'gpt-live-1', surface: 'desktop:paired', trust: 2, receive: async () => {}, closed: async () => {} };
  const service = new LiveService({ broker: s.broker, clock: () => s.http.now, ttlSeconds: 60, audit: () => {}, relay: { connect: async () => ({ send: async () => {}, close: async () => {} }) } });
  const direct = await s.broker.create(s.request);
  const issued = service.issue({ ...s.request, transport: 'websocket', model: 'gpt-live-1' }, client); await service.redeem(issued.handle, client);
  s.hooks.close = async id => { if (id === 'ws-1') throw new Error('provider down'); };
  await assert.rejects(service.close());
  assert.ok(s.closed.includes(direct.sessionId));
});
