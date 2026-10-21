import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBroker, type VoicePorts, type VoiceEvent } from '../../src/voice/index.ts';
import { LiveService, type LiveClient } from '../../src/voice/live.ts';
import { Sensitive, OpenAIError } from '../../src/openai-auth/index.ts';
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

// --- billing without provider-reported final usage -------------------------------------------------------------------
test('a WebRTC session without final usage is billed its wall-clock seconds on close, once', async () => {
  const s = setup(); const usage: { eventId: string; seconds: number }[] = [];
  s.ports.budget.record = async r => { usage.push({ eventId: r.eventId, seconds: r.usage.seconds }); return true; };
  const { sessionId } = await s.broker.create({ ...s.request, provider: 'openai:realtime', model: 'gpt-realtime' });
  s.http.now += 90_500; await s.broker.close(sessionId);
  assert.deepEqual(usage, [{ eventId: 'session-duration', seconds: 91 }]);
  await s.broker.close(sessionId); assert.equal(usage.length, 1);
});

test('wall-clock billing subtracts seconds already recorded from usage events and is capped at the session lifetime', async () => {
  const s = setup(); const seconds: number[] = [];
  s.ports.budget.record = async r => { seconds.push(r.usage.seconds); return true; };
  const a = await s.broker.create(s.request); s.http.now += 30_000;
  await s.broker.event(a.sessionId, { type: 'session.usage.updated', eventId: 'u1', seconds: 30 }); s.http.now += 30_000; await s.broker.close(a.sessionId);
  assert.deepEqual(seconds, [30, 30]);
  seconds.length = 0; const b = await s.broker.create(s.request); s.http.now += 3 * 3600_000; await s.broker.close(b.sessionId);
  assert.deepEqual(seconds, [3600]);
});

test('response.done token usage of a Realtime session reaches the ledger as deltas', async () => {
  const s = setup(); const rows: { eventId: string; inputTokens: number; outputTokens: number }[] = [];
  s.ports.budget.record = async r => { rows.push({ eventId: r.eventId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }); return true; };
  const { sessionId } = await s.broker.create({ ...s.request, provider: 'openai:realtime', model: 'gpt-realtime' });
  await s.broker.event(sessionId, { type: 'response.done', eventId: 'r1', inputTokens: 100, outputTokens: 20 });
  await s.broker.event(sessionId, { type: 'response.done', eventId: 'r2', inputTokens: 50, outputTokens: 10 });
  await s.broker.event(sessionId, { type: 'response.done', eventId: 'r1', inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(rows, [{ eventId: 'r1', inputTokens: 100, outputTokens: 20 }, { eventId: 'r2', inputTokens: 50, outputTokens: 10 }]);
});

// --- hangup failures --------------------------------------------------------------------------------------------------
test('a hangup the provider reports as gone (session-unknown) ends the session, frees capacity and releases the reservation', async () => {
  const s = setup(1); const a = await s.broker.create(s.request);
  s.hooks.close = async () => { throw new OpenAIError('session-unknown'); };
  await s.broker.close(a.sessionId);
  assert.equal(s.released.length, 1);
  s.hooks.close = async () => {}; const b = await s.broker.create(s.request); assert.ok(b.sessionId);
  await s.broker.sweep(); assert.deepEqual(s.attempts, [a.sessionId]);
});

test('a transient hangup failure is retried a bounded number of times, then the session is written off', async () => {
  const s = setup(1); const a = await s.broker.create(s.request);
  s.hooks.close = async () => { throw new OpenAIError('transport-failed'); };
  for (let i = 0; i < 4; i++) await assert.rejects(s.broker.close(a.sessionId));
  await assert.rejects(s.broker.create(s.request), { code: 'capacity-exceeded' }); assert.equal(s.released.length, 0);
  await s.broker.close(a.sessionId); // fifth failed attempt: written off
  assert.equal(s.attempts.length, 5); assert.equal(s.released.length, 1);
  s.hooks.close = async () => {}; assert.ok((await s.broker.create(s.request)).sessionId);
});

test('a transient hangup failure followed by success keeps the normal close path', async () => {
  const s = setup(1); const a = await s.broker.create(s.request); let fail = true;
  s.hooks.close = async () => { if (fail) throw new OpenAIError('transport-failed'); };
  await assert.rejects(s.broker.close(a.sessionId)); fail = false; await s.broker.close(a.sessionId);
  assert.deepEqual(s.closed, [a.sessionId]); assert.equal(s.released.length, 1);
});

// --- attachEphemeral vs revoke/dispose ---------------------------------------------------------------------------------
function gatedAttach(s: ReturnType<typeof setup>, callId: string) {
  let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  s.hooks.attach = async url => { if (url.includes('call_id=' + callId)) await gate; };
  return open;
}

test('revokeEphemeral during attachEphemeral closes the session the attach produces and releases the reservation', async () => {
  const s = setup(1); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' });
  const open = gatedAttach(s, 'late'); const attaching = s.broker.attachEphemeral(secret.reservation, 'late'); await tick();
  const revoking = s.broker.revokeEphemeral(secret.reservation); await tick();
  open();
  await assert.rejects(attaching, { code: 'ephemeral-consumed' }); await revoking;
  assert.deepEqual(s.closed, ['late']); assert.equal(s.released.filter(id => id === secret.reservation).length, 1);
  assert.ok((await s.broker.create(s.request)).sessionId); // capacity is free again
});

test('revokeEphemeral during a failing attach releases the reservation and does not resurrect the pending secret', async () => {
  const s = setup(1); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' });
  let fail!: () => void; const gate = new Promise<void>((_, reject) => { fail = () => reject(new Error('attach failed')); });
  s.hooks.attach = async url => { if (url.includes('call_id=bad')) await gate; };
  const attaching = s.broker.attachEphemeral(secret.reservation, 'bad'); await tick();
  const revoking = s.broker.revokeEphemeral(secret.reservation); await tick(); fail();
  await assert.rejects(attaching); await revoking;
  assert.equal(s.released.filter(id => id === secret.reservation).length, 1);
  await assert.rejects(s.broker.attachEphemeral(secret.reservation, 'again'), { code: 'ephemeral-consumed' });
  assert.ok((await s.broker.create(s.request)).sessionId);
});

test('dispose during attachEphemeral waits for it and leaves no session or reservation behind', async () => {
  const s = setup(1); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' });
  const open = gatedAttach(s, 'late'); const attaching = s.broker.attachEphemeral(secret.reservation, 'late').catch(e => e); await tick();
  let disposed = false; const disposing = s.broker.dispose().then(() => { disposed = true; }); await tick(); await tick();
  assert.equal(disposed, false, 'dispose waits for the attach in progress');
  open(); await disposing; assert.equal(((await attaching) as { code?: string }).code, 'ephemeral-consumed');
  assert.deepEqual(s.closed, ['late']); assert.equal(s.released.filter(id => id === secret.reservation).length, 1);
  assert.ok((await s.broker.create(s.request)).sessionId); // the broker is usable again afterwards
});

test('dispose waits for a create in progress and then closes the session it registered', async () => {
  const s = setup(1); let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  s.hooks.attach = async () => { await gate; };
  const creating = s.broker.create(s.request); await tick();
  const disposing = s.broker.dispose(); await tick();
  await assert.rejects(s.broker.create(s.request), { code: 'transport-unavailable' }); // nothing new starts while disposing
  open(); const { sessionId } = await creating; await disposing;
  assert.deepEqual(s.closed, [sessionId]); assert.equal(s.released.length, 1);
});
