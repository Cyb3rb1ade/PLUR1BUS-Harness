import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { validateParams } from '@plur1bus/rpc-schema';
import { createCore } from '../../src/core.ts';
import { connect } from '../helpers/connect.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { scriptedAdapter } from '../composition/helpers.ts';
test('full Core routes triage, mapped decision events and synthetic diagnostic through the shared service', async () => {
  const home = tempDir('decision-core-'), cfg = defaults(); cfg.agents.bernd = {}; cfg.modelRoles.decision = 'decision';
  // The 200 ms production budgets are for reference hardware; a first decision on a shared CI runner (Windows) outlasts
  // them and ends `timeout`. This test is about routing and event mapping, so its budgets only catch a hang.
  cfg.decision.timeoutMs = 10_000; cfg.decision.budgets = { triage: 10_000, routing: 10_000 };
  cfg.engine = { duplicateThreshold: 1.01, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const triage = { schema: 'plur1bus.triage/1', shape: 'single', tasks: [{ id: 'task', summary: 'Search', start: 0, end: 6, categories: { 'web.research': 1 }, modelClass: { small: 1, medium: 0, large: 0, frontier: 0 }, chosenClass: 'small', effort: 'low', dependsOn: [], confidence: 1, reason: 'secret-model-prose' }] };
  const decision = scriptedAdapter([{ text: JSON.stringify(triage) }, { text: JSON.stringify({ id: 'even', probabilities: { even: 1, odd: 0 }, confidence: 1 }) }]);
  const main = scriptedAdapter([{ text: 'done' }]);
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false }, composition: { providers: { profiles: { decision: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: decision.adapter }], default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: main.adapter }] } } } });
  await core.start(); const rpc = await connect({ address: core.address, token: core.token });
  try {
    const caller = { channel: 'cli', accountId: 'host', userId: 'alice' };
    const { session } = await rpc.call<{ session: { id: string } }>('session.create', { caller, agentId: 'bernd' });
    const result = await rpc.call<{ state: string }>('session.submit', { caller, sessionId: session.id, text: 'Search', wait: true }); assert.equal(result.state, 'completed');
    const { events } = await rpc.call<{ events: { type: string; data: Record<string, unknown> }[] }>('session.events', { caller, sessionId: session.id });
    const trace = events.filter(e => e.type === 'decision.completed'); assert.equal(trace.length, 1); assert.equal(trace[0]!.data.outcome, 'accepted'); assert(!JSON.stringify(trace).includes('secret-model-prose')); assert(!JSON.stringify(trace).includes('Search'));
    const before = await rpc.call<{ requests: number; failures: number }>('decision.status', {}); assert.equal(before.requests, 1); assert.equal(before.failures, 0);
    const probe = await rpc.call<{ ok: boolean; outcome: string }>('decision.test', { agentId: 'bernd' }); assert.equal(probe.ok, true); assert.equal(probe.outcome, 'accepted');
    const request = decision.requests[1]!; assert.deepEqual(request.tools, []); assert(JSON.stringify(request.messages).includes('Is this integer even or odd?')); assert(!JSON.stringify(request.messages).includes('Search'));
    const after = await rpc.call<{ requests: number }>('decision.status', {}); assert.equal(after.requests, 2);
    assert.equal(validateParams('decision.test', { agentId: 'bernd', prompt: 'arbitrary' }).ok, false);
    const replay = await rpc.call<{ events: unknown[] }>('session.events', { caller, sessionId: session.id }); assert.equal(replay.events.length, events.length);
  } finally { await rpc.close(); await core.stop({ budgetMs: 5000 }); }
});

test('Core System One diagnostics send only the fixed synthetic choice through the registered adapter', async t => {
  const calls: any[] = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); calls.push(parsed);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: parsed.model, answers: { decision: { type: 'choice', choice: 'even', confidence: 1, probabilities: { even: 1, odd: 0 } } }, usage: { input_tokens: 20, output_tokens: 10 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const oldAllow = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, oldKeyring = process.env.PLUR1BUS_SECRETS_KEYRING;
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1'; process.env.PLUR1BUS_SECRETS_KEYRING = 'memory';
  t.after(() => { if (oldAllow === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS; else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = oldAllow; if (oldKeyring === undefined) delete process.env.PLUR1BUS_SECRETS_KEYRING; else process.env.PLUR1BUS_SECRETS_KEYRING = oldKeyring; });
  const home = tempDir('decision-system-one-core-'), cfg = defaults(); cfg.agents.bernd = {};
  cfg.decision.backend = 'jev'; cfg.decision.timeoutMs = 1000; cfg.decision.budgets = { routing: 1000 };
  cfg.decision.systemOne = { jev: { enabled: true, model: 'jev-1.13.0', secretRef: 'typesafe-test' }, kev: { enabled: false } };
  cfg.egress.allowHosts = ['127.0.0.1']; cfg.egress.allowPorts = [port]; cfg.egress.allowLoopback = true;
  cfg.engine = { duplicateThreshold: 1.01, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false }, composition: { decisionTestOrigin: `http://127.0.0.1:${port}` } });
  await core.start(); const rpc = await connect({ address: core.address, token: core.token });
  try {
    await rpc.call('secret.set', { name: 'typesafe-test', value: 'core-diagnostic-key-probe' });
    await assert.rejects(rpc.call('decision.test', { agentId: 'bernd', state: 'private arbitrary message' })); assert.equal(calls.length, 0);
    const result = await rpc.call<{ ok: boolean; backend: string }>('decision.test', { agentId: 'bernd' }); assert.equal(result.ok, true); assert.equal(result.backend, 'jev');
    assert.equal(calls.length, 1); assert.equal(calls[0].state, '2'); assert.equal(calls[0].questions.decision.instructions, 'Is this integer even or odd?');
    assert.equal(JSON.stringify(calls).includes('private arbitrary message'), false);
  } finally { await rpc.close(); await core.stop({ budgetMs: 5000 }); }
});
