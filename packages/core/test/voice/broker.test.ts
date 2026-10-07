import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import type { VoicePorts } from '../../src/voice/index.ts';
import { VoiceBroker } from '../../src/voice/index.ts';
import { Sensitive } from '../../src/openai-auth/index.ts';
import { FakeOpenAI } from '../fixtures/openai/server.ts';
function setup() {
  const http = new FakeOpenAI(), events: unknown[] = [], notices: unknown[] = [], closed: string[] = [], sends: unknown[] = [];
  let exceeded = false, toolCalls = 0;
  const ports: VoicePorts = { http, clock: { now: () => http.now }, credentials: { lease: async () => new Sensitive(http.secret()) }, models: { allowed: async () => true }, budget: { reserve: async () => !exceeded, record: async () => { exceeded = true; return false; }, release: async () => {} }, policy: { authorize: async () => true, tool: async () => { toolCalls++; return { ok: true }; }, spend: async () => { events.push('money.spend'); } }, sideband: { attach: async () => ({ send: async (v: unknown) => { sends.push(v); }, close: async () => {} }) }, sessions: { close: async (id: string) => { closed.push(id); } }, audit: e => { events.push(e); }, notice: async (v) => { notices.push(v); }, capacity: 2 };
  const broker = new VoiceBroker(ports);
  const request = { agent: 'agent-a', user: 'owner', provider: 'openai:gpt-live' as const, parent: { kind: 'api_key' as const, region: 'eu' as const }, surface: { authenticated: true, trust: 2 as const, kind: 'desktop' as const }, transport: 'webrtc' as const, model: 'gpt-live-1', sdp: 'v=0\r\nsynthetic-offer' };
  return { http, broker, ports, request, events, notices, closed, sends, toolCalls: () => toolCalls };
}
test('Acceptance 16: broker SDP, policy tools, budget closure and redaction', async () => {
  const s = setup(), result = await s.broker.create(s.request);
  assert.equal(result.sdpAnswer, 'v=0\r\nsynthetic-answer'); assert.deepEqual(Object.keys(result).sort(), ['sdpAnswer','sessionId']);
  const req = s.http.requests[0]!; assert.equal(req.json?.store, false); assert.deepEqual(req.json?.delegation, { type: 'client' }); assert.match(req.url, /eu\.api/);
  await s.broker.event(result.sessionId, { type: 'tool.call', callId: 'call-test', name: 'fixture', arguments: {} }); assert.equal(s.toolCalls(), 1);
  await s.broker.event(result.sessionId, { type: 'session.usage.updated', eventId: 'usage-1', seconds: 60, costMicros: 50000 }); assert.deepEqual(s.closed, [result.sessionId]); assert.equal(s.notices.length, 1);
  await assert.rejects(s.broker.create(s.request), { code: 'budget-exceeded' }); assert.ok(s.events.includes('money.spend'));
  for (const secret of s.http.secrets) assert.equal(JSON.stringify([result,s.events,s.notices]).includes(secret), false);
});
test('ephemeral TTL default/cap, trust, desktop only, single consumption, redaction', async () => {
  const s = setup(), request = { ...s.request, provider: 'openai:realtime' as const };
  const secret = await s.broker.mint(request); const value = secret.consume().value(); assert.equal(secret.ttlSeconds, 60); assert.equal(JSON.stringify(secret).includes(value), false); assert.equal(inspect(secret).includes(value), false);
  assert.ok(value); assert.throws(() => secret.consume(), { code: 'ephemeral-consumed' });
  for (const ttlSeconds of [0,9,601,7200,NaN]) await assert.rejects(s.broker.mint({ ...request, ttlSeconds }), { code: 'invalid-request' });
  await assert.rejects(s.broker.mint({ ...request, surface: { ...request.surface, trust: 1 } }), { code: 'surface-denied' });
  await assert.rejects(s.broker.mint({ ...request, surface: { ...request.surface, kind: 'group' } }), { code: 'surface-denied' });
  await assert.rejects(s.broker.mint(s.request));
});
test('Realtime broker uses unified interface and never returns a secret', async () => { const s = setup(); const result = await s.broker.create({ ...s.request, provider: 'openai:realtime', model: 'fixture-realtime' }); assert.equal(result.sdpAnswer, 'v=0\r\nsynthetic-answer'); assert.match(s.http.requests[0]!.url, /realtime\/calls$/); });
test('invalid surface/parent, SIP follow-up, capacity and session expiry', async () => { const s = setup(); await assert.rejects(s.broker.create({ ...s.request, surface: { ...s.request.surface, authenticated: false } })); await assert.rejects(s.broker.create({ ...s.request, transport: 'sip' }), { code: 'transport-unavailable' }); const a = await s.broker.create(s.request); await s.broker.create(s.request); await assert.rejects(s.broker.create(s.request), { code: 'capacity-exceeded' }); s.http.now += 3600000; await s.broker.sweep(); assert.ok(s.closed.includes(a.sessionId)); });
test('ephemeral reservation attaches one sideband and releases on expiration', async () => { const s = setup(); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' }); await s.broker.attachEphemeral(secret.reservation, 'synthetic-call'); await assert.rejects(s.broker.attachEphemeral(secret.reservation, 'second-call'), { code: 'ephemeral-consumed' }); await s.broker.event('synthetic-call', { type: 'tool.call', callId: 't', name: 'fixture', arguments: {} }); assert.equal(s.toolCalls(), 1); await s.broker.dispose(); assert.deepEqual(s.closed, ['synthetic-call']); });
test('sideband policy denial and duplicate usage do not run twice', async () => { const s = setup(); const result = await s.broker.create(s.request); await Promise.all([s.broker.event(result.sessionId, { type: 'tool.call', callId: 'same', name: 'fixture', arguments: {} }), s.broker.event(result.sessionId, { type: 'tool.call', callId: 'same', name: 'fixture', arguments: {} })]); assert.equal(s.toolCalls(), 1); });
test('denied sideband tool never executes and client delegation goes through agent port', async () => { const s = setup(); s.ports.policy.authorize = async () => false; let delegated = 0; s.ports.policy.delegate = async () => { delegated++; return 'agent-response'; }; const r = await s.broker.create(s.request); await s.broker.event(r.sessionId, { type: 'tool.call', callId: 'denied', name: 'fixture', arguments: {} }); assert.equal(s.toolCalls(), 0); assert.deepEqual(s.sends[0], { type: 'tool.result', callId: 'denied', error: 'policy-denied' }); await s.broker.event(r.sessionId, { type: 'delegation.request', requestId: 'delegate-1', payload: 'voice-input' }); assert.equal(delegated, 1); });
test('WebSocket GPT-Live sends session.start first, exposes no credential', async () => { const s = setup(); let first: unknown; s.ports.websocket = { start: async r => { first = r.firstMessage; assert.match(r.url, /^wss:\/\/eu\.api\.openai\.com\/v1\/live\/sessions$/); return { id: 'socket-test' }; } }; const result = await s.broker.create({ ...s.request, transport: 'websocket' }); assert.deepEqual(result, { sessionId: 'socket-test' }); assert.equal((first as { type: string }).type, 'session.start'); });
test('voice usage sums backend deltas and final Live cumulative totals once', async () => { const s = setup(); const usage: unknown[] = []; s.ports.budget.record = async r => { usage.push(r.usage); return true; }; const r = await s.broker.create(s.request); await s.broker.event(r.sessionId, { type: 'session.usage.updated', eventId: 'one', seconds: 30, costMicros: 25000 }); await s.broker.event(r.sessionId, { type: 'backend.usage', eventId: 'two', costMicros: 2000, inputTokens: 10, outputTokens: 5 }); await s.broker.event(r.sessionId, { type: 'session.closed', seconds: 60, costMicros: 50000 }); assert.deepEqual(usage, [{ seconds: 30, costMicros: 25000, inputTokens: 0, outputTokens: 0 }, { seconds: 0, costMicros: 2000, inputTokens: 10, outputTokens: 5 }, { seconds: 30, costMicros: 25000, inputTokens: 0, outputTokens: 0 }]); assert.deepEqual(s.closed, [r.sessionId]); });
test('budget accounting failure closes provider session to stop unmetered spend', async () => { const s = setup(); const r = await s.broker.create(s.request); s.ports.budget.record = async () => { throw Error(s.http.secret()); }; await assert.rejects(s.broker.event(r.sessionId, { type: 'response.done', eventId: 'broken', costMicros: 1 })); assert.deepEqual(s.closed, [r.sessionId]); });
test('agent budgets stay isolated and a ceiling prevents another session for that agent', async () => {
  const s = setup(), used = new Map<string, number>(), reservations = new Set<string>();
  s.ports.budget = { reserve: async r => { if ((used.get(r.agent) ?? 0) >= 60) return false; reservations.add(r.reservation); return true; }, record: async r => { const seconds = (used.get(r.agent) ?? 0) + r.usage.seconds; used.set(r.agent, seconds); return seconds < 60; }, release: async id => { reservations.delete(id); } };
  const a = await s.broker.create(s.request);
  await s.broker.event(a.sessionId, { type: 'session.usage.updated', eventId: 'agent-a-limit', seconds: 60 });
  await assert.rejects(s.broker.create(s.request), { code: 'budget-exceeded' });
  const b = await s.broker.create({ ...s.request, agent: 'agent-b' }); assert.ok(b.sessionId); assert.equal(reservations.size, 1); await s.broker.dispose(); assert.equal(reservations.size, 0);
});
test('concurrent ephemeral sideband claims allow exactly one call', async () => { const s = setup(); const secret = await s.broker.mint({ ...s.request, provider: 'openai:realtime' }); const result = await Promise.allSettled([s.broker.attachEphemeral(secret.reservation, 'first'), s.broker.attachEphemeral(secret.reservation, 'second')]); assert.equal(result.filter(r => r.status === 'fulfilled').length, 1); await s.broker.dispose(); });
test('sideband events arriving during attach are buffered until session registration', async () => { const s = setup(); s.ports.sideband.attach = async r => { await r.onEvent({ type: 'tool.call', callId: 'early', name: 'fixture', arguments: {} }); return { send: async () => {}, close: async () => {} }; }; await s.broker.create(s.request); assert.equal(s.toolCalls(), 1); await s.broker.dispose(); });
