import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createSystemOneBackend } from '../../src/decision/system-one.ts';
import { DecisionClient } from '../../src/decision/client.ts';
import type { DecisionRequest } from '../../src/decision/types.ts';
import { createEgress } from '../../src/egress/service.ts';
import { createCallBudget, type CallBudgetEvent } from '../../src/budget/calls.ts';
import { createSecretStore } from '../../src/secrets/store.ts';
import { createMemoryBackend } from '../../src/secrets/memory-backend.ts';
import { tempDir } from '../helpers/temp-dir.ts';
const key = 'system-one-secret-probe-123456';
const signal = () => new AbortController().signal;
const input = { useCase: 'routing' as const, state: '2', question: 'Even?', options: [{ id: 'even', description: 'Even' }, { id: 'odd', description: 'Odd' }] };
async function rig(t: import('node:test').TestContext) {
  const cfg = defaults(); cfg.decision.backend = 'jev'; cfg.decision.timeoutMs = 1000; cfg.decision.budgets = { routing: 1000, skills: 1000 };
  cfg.decision.systemOne = { jev: { enabled: true, model: 'jev-1.13.0', secretRef: 'typesafe-key' }, kev: { enabled: true, model: 'kev-test' } };
  const calls: { headers: http.IncomingHttpHeaders; body: any }[] = []; let reply: (req: any, res: http.ServerResponse) => void = (req, res) => {
    const q = req.questions.decision;
    const answer = q.type === 'noul' ? { type: 'noul', noul: .9 } : q.type === 'score' ? { type: 'score', score: 1.6, confidence: .9, legend: { 0: 'low', 1: 'mid', 2: 'high' }, probabilities: { 0: .1, 1: .2, 2: .7 } } : { type: 'choice', choice: 'even', confidence: .9, probabilities: { even: .9, odd: .1 } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: req.model, answers: { decision: answer }, usage: { input_tokens: 20, output_tokens: 10 } }));
  };
  const server = http.createServer(async (req, res) => { let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); calls.push({ headers: req.headers, body }); reply(body, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  (cfg.decision.systemOne as any).kev.endpoint = `${origin}/v1/systemone`;
  const events: CallBudgetEvent[] = [];
  const budget = createCallBudget({ path: join(tempDir('system-one-'), 'budget.sqlite'), clock: { now: Date.now }, emitter: { emit: e => events.push(e) } });
  const audit: unknown[] = [];
  const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: { record: e => audit.push(e) } });
  await secrets.set({ kind: 'owner', id: 'tester' }, 'typesafe-key', key);
  const egress = createEgress({ config: () => ({ allowHosts: ['127.0.0.1'], allowPorts: [(server.address() as import('node:net').AddressInfo).port], allowLoopback: true }) });
  const options = { config: () => cfg, egress, secrets, budget, testOrigin: origin };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); budget.close(); });
  return { cfg, calls, events, audit, secrets, budget, options, reply: (f: typeof reply) => { reply = f; } };
}
const ctx = () => ({ agentId: 'bernd', principal: 'user:alice', cloudEligible: true, signal: signal() });

test('real loopback Egress maps all three primitives, charges actual usage and revokes fresh core leases', async t => {
  const r = await rig(t); const client = new DecisionClient({ config: () => r.cfg, backends: { jev: createSystemOneBackend('jev', r.options) } });
  assert.equal((await client.choice(input, ctx())).ok, true);
  const n = await client.noul({ useCase: 'skills', state: 'hi', question: 'Greeting?' }, ctx()); assert.equal(n.ok && n.value.probability, .9);
  const s = await client.score({ useCase: 'routing', state: 'urgent', question: 'Rate', levels: ['low', 'mid', 'high'] }, ctx()); assert.ok(s.ok && Math.abs(s.value.score - 1.6) < 1e-12);
  assert.equal(r.calls.length, 3); assert.equal(r.calls[0]!.headers.authorization, `Bearer ${key}`);
  assert.deepEqual(r.calls[0]!.body.questions.decision.criteria, { even: 'Even', odd: 'Odd' });
  assert.equal(r.events.filter(e => e.type === 'reserve').length, 3); assert.deepEqual(r.events.filter(e => e.type === 'settle').map(e => e.tokens), [30, 30, 30]);
  assert.equal(r.secrets.activeLeases({ kind: 'core' }).length, 0);
  assert.equal(r.audit.filter((e: any) => e.action === 'secret.lease').length, 3); assert(!JSON.stringify(r.audit).includes(key));
});

test('cloud admission defaults closed; localOnly denies explicit Jev, auto falls back, triage uses role only', async t => {
  const r = await rig(t); let roleCalls = 0;
  const client = new DecisionClient({ config: () => r.cfg, backends: { jev: createSystemOneBackend('jev', r.options), role: { local: () => true, async run() { roleCalls++; return { id: 'even', probabilities: { even: 1, odd: 0 }, confidence: 1 }; } } } });
  const denied = await client.choice(input, { agentId: 'bernd', principal: 'user:alice', signal: signal() }); assert.equal(!denied.ok && denied.reason, 'privacy');
  r.cfg.decision.backend = 'auto'; assert.equal((await client.choice(input, { agentId: 'bernd', signal: signal() })).ok, true); assert.equal(roleCalls, 1);
  r.cfg.decision.backend = 'jev'; r.cfg.privacy.localOnly = true; const local = await client.choice(input, ctx()); assert.equal(!local.ok && local.reason, 'privacy');
  r.cfg.privacy.localOnly = false; await client.triage('private arbitrary raw triage text', ctx()); assert.equal(roleCalls, 2); assert.equal(r.calls.length, 0);
});

test('real SQLite budget refuses before HTTP and missing trusted principal cannot send', async t => {
  const r = await rig(t); r.budget.setLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens', hard: 1 });
  const backend = createSystemOneBackend('jev', r.options);
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() } as DecisionRequest;
  await assert.rejects(backend.run(request, signal()), /unavailable/); assert.equal(r.calls.length, 0);
  r.budget.clearLimit({ scope: 'global', id: '', period: 'day', metric: 'tokens' });
  const { principal: _principal, ...without } = ctx(); await assert.rejects(backend.run({ ...request, context: without }, signal()), /unavailable/); assert.equal(r.calls.length, 0);
});

test('redirect and reflected-key errors are sanitized, never redirect credentials, and consume conservative estimates', async t => {
  const r = await rig(t); const backend = createSystemOneBackend('jev', r.options);
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() } as DecisionRequest;
  r.reply((_req, res) => { res.writeHead(302, { location: `${r.options.testOrigin}/leak` }); res.end(key); });
  const error = await backend.run(request, signal()).catch(e => e); assert.equal(String(error).includes(key), false); assert.equal(r.calls.length, 1);
  r.reply((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: key })); });
  await assert.rejects(backend.run({ ...request, deadline: performance.now() + 1000 }, signal()), e => !String(e).includes(key));
  assert.equal(r.events.filter(e => e.type === 'settle').length, 2); assert.equal(r.events.some(e => e.type === 'release'), false); assert.equal(r.secrets.activeLeases({ kind: 'core' }).length, 0);
});

test('Kev stays ineligible without gate proof; bounded four-decimal correction does not relax Jev', async t => {
  const r = await rig(t); r.cfg.decision.backend = 'kev';
  assert.equal(createSystemOneBackend('kev', r.options).eligible?.(ctx()), false);
  const kev = createSystemOneBackend('kev', { ...r.options, kevEligible: () => true });
  r.reply((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: req.model, answers: { decision: { type: 'choice', choice: 'even', confidence: .9, probabilities: { even: .9000, odd: .0999 } } }, usage: { input_tokens: 3, output_tokens: 2 }, latency_ms: 1 })); });
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() } as DecisionRequest;
  const value = await kev.run(request, signal()) as { probabilities: Record<string, number> }; assert.ok(Math.abs(value.probabilities.even! + value.probabilities.odd! - 1) < 1e-12);
  assert.equal(r.calls[0]!.headers.authorization, undefined);
  await assert.rejects(createSystemOneBackend('jev', r.options).run(request, signal()), /invalid/);
});

test('malformed success JSON is invalid without leaking its reflected key text', async t => {
  const r = await rig(t); r.reply((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(`{"secret":"${key}`); });
  const backend = createSystemOneBackend('jev', r.options);
  await assert.rejects(backend.run({ ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() }, signal()), e => String(e) === 'Error: invalid');
  assert.equal(r.events.some(e => e.type === 'settle'), true);
});

test('changing the live secret reference while leasing blocks the stale credential before send', async t => {
  const r = await rig(t); const original = r.secrets.lease.bind(r.secrets);
  const secrets = { ...r.secrets, async lease(...args: Parameters<typeof original>) { const lease = await original(...args); (r.cfg.decision.systemOne as any).jev.secretRef = 'different-key'; return lease; } };
  const backend = createSystemOneBackend('jev', { ...r.options, secrets });
  await assert.rejects(backend.run({ ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() }, signal()));
  assert.equal(r.calls.length, 0); assert.equal(r.secrets.activeLeases({ kind: 'core' }).length, 0);
  assert.equal(r.events.some(e => e.type === 'release'), true); assert.equal(r.events.some(e => e.type === 'settle'), false);
});

test('revoked fresh lease and a caller abort during leasing cannot issue HTTP', async t => {
  const r = await rig(t); const original = r.secrets.lease.bind(r.secrets);
  const secrets = { ...r.secrets, readLease(p: Parameters<typeof r.secrets.readLease>[0], id: string) { r.secrets.revokeLease(p, id); return r.secrets.readLease(p, id); } };
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() } as DecisionRequest;
  await assert.rejects(createSystemOneBackend('jev', { ...r.options, secrets }).run(request, signal()), /unavailable/);
  const controller = new AbortController();
  const aborting = { ...r.secrets, async lease(...args: Parameters<typeof original>) { const value = await original(...args); controller.abort(); return value; } };
  await assert.rejects(createSystemOneBackend('jev', { ...r.options, secrets: aborting }).run(request, controller.signal), /cancelled/);
  assert.equal(r.calls.length, 0); assert.equal(r.secrets.activeLeases({ kind: 'core' }).length, 0);
  assert.equal(r.events.filter(e => e.type === 'release').length, 2);
});

test('deadline and in-flight abort close the real HTTP request, revoke the lease and settle estimates', async t => {
  const r = await rig(t); r.reply(() => {});
  const backend = createSystemOneBackend('jev', r.options);
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 25, context: ctx() } as DecisionRequest;
  await assert.rejects(backend.run(request, signal()), /timeout/);
  const controller = new AbortController(); const pending = backend.run({ ...request, deadline: performance.now() + 1000 }, controller.signal);
  while (r.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(r.events.filter(e => e.type === 'settle').length, 2); assert.equal(r.secrets.activeLeases({ kind: 'core' }).length, 0);
});

test('a deadline timer that fires before performance.now() reaches the deadline still reports timeout', async t => {
  // Node runs timers on a whole-millisecond loop clock, so the deadline timer can fire a little early; here it fires a minute early.
  const r = await rig(t); r.reply(() => {}); const early = new AbortController(); t.mock.method(AbortSignal, 'timeout', () => early.signal);
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 60_000, context: ctx() } as DecisionRequest;
  const pending = createSystemOneBackend('jev', r.options).run(request, signal());
  while (r.calls.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
  early.abort(); await assert.rejects(pending, /timeout/); assert.ok(performance.now() < request.deadline);
  assert.equal(r.events.filter(e => e.type === 'settle').length, 1); assert.equal(r.secrets.activeLeases({ kind: 'core' }).length, 0);
});

test('invalid distributions, extra fields, out-of-range answers and response-model injection fail closed', async t => {
  const r = await rig(t); const backend = createSystemOneBackend('jev', r.options);
  const choice = { type: 'choice', choice: 'even', confidence: .9, probabilities: { even: .9, odd: .1 } };
  const cases: { answer: unknown; model?: string; primitive?: 'choice' | 'noul' | 'score' }[] = [
    { answer: { ...choice, probabilities: { even: .9 } } }, { answer: { ...choice, probabilities: { even: .9, odd: .1, extra: 0 } } },
    { answer: { ...choice, probabilities: { even: .9, odd: .2 } } }, { answer: { ...choice, probabilities: { even: -1, odd: 2 } } },
    { answer: { ...choice, choice: 'odd' } }, { answer: { ...choice, confidence: 2 } },
    { answer: { ...choice, message: key } }, { answer: choice, model: key },
    { answer: { type: 'noul', noul: 2 }, primitive: 'noul' },
    { answer: { type: 'score', score: 2, confidence: .9, legend: { 0: 'low', 1: 'high' }, probabilities: { 0: .5, 1: .5 } }, primitive: 'score' },
  ];
  for (const c of cases) {
    r.reply((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: c.model ?? req.model, answers: { decision: c.answer }, usage: { input_tokens: 5, output_tokens: 1 } })); });
    await assert.rejects(backend.run({ ...input, levels: ['low', 'high'], requestId: 'r', primitive: c.primitive ?? 'choice', deadline: performance.now() + 1000, context: ctx() }, signal()), e => String(e) === 'Error: invalid');
  }
  assert.equal(r.events.filter(e => e.type === 'settle').length, cases.length);
});

test('HTTP byte caps and endpoint boundaries hold without a global fetch path', async t => {
  const r = await rig(t); const backend = createSystemOneBackend('jev', r.options);
  const request = { ...input, requestId: 'r', primitive: 'choice', deadline: performance.now() + 1000, context: ctx() } as DecisionRequest;
  await assert.rejects(backend.run({ ...request, state: 'x'.repeat(70_000) }, signal()), /invalid/); assert.equal(r.events.length, 0); assert.equal(r.calls.length, 0);
  r.reply((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('x'.repeat(70_000)); });
  await assert.rejects(backend.run(request, signal())); assert.equal(r.events.filter(e => e.type === 'settle').length, 1);
  for (const testOrigin of ['https://remote.test', 'http://localhost:123', 'http://127.0.0.1:123/user', 'http://user:pass@127.0.0.1:123']) assert.throws(() => createSystemOneBackend('jev', { ...r.options, testOrigin }), /unavailable/);
  (r.cfg.decision.systemOne as any).kev.endpoint = 'http://localhost:8008/v1/systemone';
  assert.equal(createSystemOneBackend('kev', { ...r.options, kevEligible: () => true }).eligible?.(ctx()), false);
});

test('disabled flags remain disabled with a secret and the configuration is read live', async t => {
  const r = await rig(t); const backend = createSystemOneBackend('jev', r.options);
  assert.equal(backend.eligible?.(ctx()), true);
  (r.cfg.decision.systemOne as any).jev.enabled = false; assert.equal(backend.eligible?.(ctx()), false);
  (r.cfg.decision.systemOne as any).jev = { model: 'jev-1.13.0', secretRef: 'typesafe-key' }; assert.equal(backend.eligible?.(ctx()), false);
  assert.equal(r.calls.length, 0);
});
