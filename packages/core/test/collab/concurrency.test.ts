/** D124 PT-1: prove asynchronous fan-out and admission with barriers, never elapsed-time guesses. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createCollab, type CollabOptions } from '../../src/collab/service.ts';
import { collaborationTools, type CollaborationTools } from '../../src/tools/collaboration.ts';
import { DEFAULT_MAX_RESULT_BYTES, ToolRegistry } from '../../src/tools/registry.ts';
import { defaults } from '@plur1bus/config-schema';
import { ToolDispatcher } from '../../src/tools/dispatcher.ts';
import type { ChatRequest } from '../../src/session/provider.ts';
import { returnFromText, type Handoff } from '../../src/collab/handoff.ts';
import type { CollabSettings } from '../../src/collab/types.ts';
import { owner } from './helpers.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { alsAgentScopePort, runWithAgentScope, scopeFor } from '../../src/collab/scope.ts';
import { delegationWorkBudget } from '../../src/collab/limits.ts';
import { tempDir } from '../helpers/temp-dir.ts';

function fixture(t: TestContext, options: Partial<CollabOptions> = {}, settings: Partial<CollabSettings> = {}) {
  const person = owner();
  const abort = new AbortController();
  const collab = createCollab({ path: ':memory:', ...options });
  const project = collab.createProject(person, { name: 'Concurrent peers', settings: { repeatWindowMs: 0, ...settings } });
  for (const id of ['lead', 'a', 'b', 'c', 'd']) collab.addAgent(person, project.id, id);
  const request: ChatRequest = { sessionId: 'root', turnId: 'turn', projectId: project.id, agentId: 'lead', principal: person.userId, summaries: [], memory: '', messages: [], signal: abort.signal };
  const config: CollaborationTools = { collab, enabled: () => true, principal: () => person, authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, audit() {}, now: Date.now } };
  const registry = new ToolRegistry();
  for (const tool of collaborationTools(config, request)) registry.register(tool);
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const context = { agentId: 'lead', principal: person.userId, sessionId: 'root', turnId: 'turn', surface: 1 as const, signal: abort.signal };
  let callId = 0;
  const call = (name: string, args: object) => dispatcher.call({ id: `call-${++callId}`, name, args }, context);
  t.after(async () => { abort.abort(); await collab.shutdown(); });
  return { collab, project, request, config, registry, context, call };
}

for (const name of ['consult_agent', 'delegate_task']) {
  test(`${name}: four sequential nonblocking tool starts reach one barrier with maximum concurrency 4`, { timeout: 5000 }, async t => {
    const barrier = Promise.withResolvers<void>();
    let active = 0, maximum = 0, started = 0;
    const f = fixture(t, { runner: { async run(input) {
      active++; started++; maximum = Math.max(maximum, active);
      if (started === 4) barrier.resolve();
      try { await barrier.promise; input.signal.throwIfAborted(); return { text: `done ${input.agentId}`, inputTokens: 1, outputTokens: 1 }; }
      finally { active--; }
    } } });
    t.after(() => barrier.resolve());
    const taskIds: string[] = [];
    for (const toAgent of ['a', 'b', 'c', 'd']) {
      const result = await f.call(name, { projectId: f.project.id, toAgent, objective: `Inspect ${toAgent}`, wait: false });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(!result.isError && typeof (result.value as { taskId: string }).taskId === 'string');
      if (!result.isError) taskIds.push((result.value as { taskId: string }).taskId);
    }
    const collected = await f.call('await_delegations', { taskIds, timeoutMs: 1000 });
    assert.equal(collected.isError, false, JSON.stringify(collected));
    assert.ok(!collected.isError);
    const value = collected.value as { trust: string; results: { taskId: string; trust: string; provenance: { agentId: string }; result: { schema: string } }[]; running: string[] };
    assert.deepEqual(value.running, []);
    assert.equal(value.results.length, 4);
    assert.ok(value.results.every(result => result.result.schema === 'plur1bus.return/1'));
    assert.equal(value.trust, 'untrusted');
    assert.ok(value.results.every(result => result.trust === 'untrusted' && ['a', 'b', 'c', 'd'].includes(result.provenance.agentId)));
    assert.equal(maximum, 4);
    assert.equal(f.collab.listTraces(owner(), f.project.id).length, 1);
    assert.equal(f.collab.listTraces(owner(), f.project.id)[0]!.spans.length, 4);
    t.diagnostic(`maximum concurrency: ${maximum}`);
  });
}

for (const [limit, samePair] of [[3, false], [2, true]] as const) {
  test(`reserves ${samePair ? 'pair' : 'start'} slots before asynchronous handoff repair`, async t => {
    const gate = Promise.withResolvers<void>();
    t.after(() => gate.resolve());
    const f = fixture(t, { runner: { async run() { return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } }, samePair ? { maxPairPerTurn: limit } : { maxFanout: limit });
    let repairs = 0;
    f.config.repair = async value => { repairs++; await gate.promise; return { ...(value as Handoff), objective: 'compact' }; };
    const tool = f.registry.get('consult_agent')!;
    const runs = Array.from({ length: 8 }, (_, i) => tool.execute({ projectId: f.project.id, toAgent: samePair ? 'a' : ['a', 'b', 'c', 'd'][i % 4], objective: 'x'.repeat(2200), doneWhen: ['inspection complete'], context: `question ${i}` }, f.context));
    // The repair callback runs synchronously up to its gate; rejected calls must never reach it.
    assert.equal(repairs, limit);
    gate.resolve();
    const outcomes = await Promise.allSettled(runs);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, limit);
    assert.equal(f.collab.listTraces(owner(), f.project.id).length, 1);
  });
}

test('await_delegations rejects ids from another turn and zero-time polls retain running children', async t => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(t, { runner: { async run() { await gate.promise; return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } });
  t.after(() => gate.resolve());
  const started = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect', wait: false });
  assert.ok(!started.isError, JSON.stringify(started));
  const taskId = (started.value as { taskId: string }).taskId;
  const poll = await f.call('await_delegations', { taskIds: [taskId], timeoutMs: 0 });
  assert.ok(!poll.isError);
  assert.deepEqual((poll.value as { running: string[] }).running, [taskId]);
  assert.equal((await f.call('await_delegations', { taskIds: ['another-turn'], timeoutMs: 0 })).isError, true);
  gate.resolve();
});

test('the composed callee can consult one read helper as the authenticated person, without inheriting an approval', async t => {
  let f: ReturnType<typeof fixture>;
  const seen: string[] = [];
  const runner = composedAgentRunner({ id: 'nested-fixture', async *stream(request) {
    seen.push(request.agentId);
    assert.equal(request.approver, undefined, 'the caller approval policy never travels with person identity');
    if (request.agentId === 'a') {
      const definitions = collaborationTools(f.config, request);
      const context = { ...f.context, agentId: 'a', signal: request.signal };
      await assert.rejects(definitions.find(tool => tool.name === 'delegate_task')!.execute({ projectId: f.project.id, toAgent: 'b', objective: 'write' }, context), /depth/);
      const result = await definitions.find(tool => tool.name === 'consult_agent')!.execute({ projectId: f.project.id, toAgent: 'b', objective: 'inspect' }, context);
      assert.match(JSON.stringify(result), /helper evidence/);
    }
    yield { type: 'delta', text: 'helper evidence' };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
  } }, alsAgentScopePort(), tempDir('tm1-nested-'));
  f = fixture(t, { runner });
  f.request.authenticatedPerson = owner().userId;
  f.config.principal = request => request.authenticatedPerson === owner().userId ? owner() : null;
  const result = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect with helper' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(f.collab.listTraces(owner(), f.project.id).length, 1);
});

test('turn cancellation preserves an unbound partial result without cancelling a card-bound sibling', async t => {
  const started = Promise.withResolvers<void>(), releaseCard = Promise.withResolvers<void>();
  let count = 0, cardSignal: AbortSignal | undefined;
  const f = fixture(t, { runner: { async run(input) {
    input.onProgress?.({ text: 'inspected the first file', inputTokens: 1, outputTokens: 1 });
    if (++count === 2) started.resolve();
    if (input.agentId === 'a') {
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      input.signal.throwIfAborted();
    } else { cardSignal = input.signal; await releaseCard.promise; }
    return { text: 'complete', inputTokens: 1, outputTokens: 1 };
  } } });
  t.after(() => releaseCard.resolve());
  const card = f.collab.boardStore.createCard(f.project.id, { title: 'Owned task', columnId: f.collab.boardStore.columns(f.project.id)[0]!.id }, { kind: 'person', id: owner().userId });
  assert.equal((await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect', wait: false })).isError, false);
  const bound = await f.call('delegate_task', { projectId: f.project.id, toAgent: 'b', objective: 'continue', cardId: card.id, wait: false });
  assert.ok(!bound.isError);
  await started.promise;
  const results = await f.request.delegations!.finish(true);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.result!.status, 'partial');
  assert.match(results[0]!.result!.summary, /inspected the first file/);
  assert.equal(cardSignal!.aborted, false);
  releaseCard.resolve();
  const collected = await f.call('await_delegations', { taskIds: [(bound.value as { taskId: string }).taskId], timeoutMs: 1000 });
  assert.ok(!collected.isError);
  assert.match(JSON.stringify(collected.value), /complete/);
});

test('writer reservations belong to their project, rather than sharing a turn-wide four-writer cap', async t => {
  const gate = Promise.withResolvers<void>();
  let started = 0;
  const f = fixture(t, { runner: { async run() { if (++started === 8) gate.resolve(); await gate.promise; return { text: 'complete', inputTokens: 1, outputTokens: 1 }; } } });
  t.after(() => gate.resolve());
  delete f.request.projectId;
  const second = f.collab.createProject(owner(), { name: 'Another project', settings: { repeatWindowMs: 0 } });
  for (const agent of ['lead', 'a', 'b', 'c', 'd']) f.collab.addAgent(owner(), second.id, agent);
  const taskIds: string[] = [];
  for (const projectId of [f.project.id, second.id]) for (const toAgent of ['a', 'b', 'c', 'd']) {
    const result = await f.call('delegate_task', { projectId, toAgent, objective: 'inspect', wait: false });
    assert.ok(!result.isError, JSON.stringify(result));
    taskIds.push((result.value as { taskId: string }).taskId);
  }
  const collected = await f.call('await_delegations', { taskIds, timeoutMs: 1000 });
  assert.ok(!collected.isError);
  assert.deepEqual((collected.value as { running: string[] }).running, []);
  assert.equal(started, 8);
});

test('a nested read helper cannot add read tools outside its inherited view', async t => {
  const f = fixture(t);
  f.config.toolEffect = () => 'read';
  const scope = scopeFor('a', f.project.id);
  scope.toolView = ['file.read'];
  scope.delegation = { traceId: f.collab.openChain(owner(), f.project.id, 'lead'), spanId: 'parent', path: ['lead', 'a'], callClass: 'read', workBudget: delegationWorkBudget(10000) };
  await assert.rejects(runWithAgentScope(scope, () => f.registry.get('consult_agent')!.execute({ projectId: f.project.id, toAgent: 'b', objective: 'inspect', scope: { paths: [], tools: ['web.fetch'] } }, { ...f.context, agentId: 'a' })), /cannot widen/);
});

for (const name of ['consult_agent', 'delegate_task']) test(`${name} does not leak reservations after synchronous preparation errors`, async t => {
  const f = fixture(t, { runner: { async run() { return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } });
  for (let i = 0; i < 8; i++) assert.equal((await f.call(name, { projectId: f.project.id, toAgent: 'a', objective: 'inspect', deadline: 'invalid-date' })).isError, true);
  const valid = await f.call(name, { projectId: f.project.id, toAgent: 'a', objective: 'inspect' });
  assert.ok(!valid.isError, JSON.stringify(valid));
});

test('two instances of one helper get independent per-turn read allowances in one trace', async t => {
  let f: ReturnType<typeof fixture>, visits = 0;
  const runner = composedAgentRunner({ id: 'per-turn-fixture', async *stream(request) {
    if (request.agentId === 'a') {
      const tools = collaborationTools(f.config, request);
      for (const toAgent of ['b', 'c']) await tools.find(tool => tool.name === 'consult_agent')!.execute({ projectId: f.project.id, toAgent, objective: 'inspect' }, { ...f.context, agentId: 'a', signal: request.signal });
    } else visits++;
    yield { type: 'delta', text: 'done' };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
  } }, alsAgentScopePort(), tempDir('tm1-per-turn-'));
  f = fixture(t, { runner }, { maxFanout: 2 });
  const ids: string[] = [];
  for (const objective of ['first', 'second']) {
    const result = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective, wait: false });
    assert.ok(!result.isError); ids.push((result.value as { taskId: string }).taskId);
  }
  const result = await f.call('await_delegations', { taskIds: ids, timeoutMs: 1000 });
  assert.ok(!result.isError);
  assert.ok((result.value as { results: { result?: unknown }[] }).results.every(child => child.result), JSON.stringify(result));
  assert.equal(visits, 4);
  await f.request.delegations!.finish();
  const trace = f.collab.listTraces(owner(), f.project.id)[0]!;
  assert.equal(trace.spans.length, 6);
  assert.equal(trace.status, 'succeeded');
});

test('an explicitly empty nested read scope exposes no filesystem or delegation tools', async t => {
  let f: ReturnType<typeof fixture>, view: readonly string[] | undefined;
  const runner = composedAgentRunner({ id: 'empty-scope', async *stream(request) {
    if (request.agentId === 'a') await collaborationTools(f.config, request).find(tool => tool.name === 'consult_agent')!.execute({ projectId: f.project.id, toAgent: 'b', objective: 'reason only', scope: { paths: [], tools: [] } }, { ...f.context, agentId: 'a', signal: request.signal });
    else view = request.toolView;
    yield { type: 'delta', text: 'done' };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
  } }, alsAgentScopePort(), tempDir('tm1-empty-scope-'));
  f = fixture(t, { runner });
  f.config.toolEffect = name => name === 'web.fetch' ? 'read' : undefined;
  const result = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect', scope: { paths: [], tools: ['web.fetch'] } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(view, []);
});

test('the configured ceiling of 32 helpers can collect bounded returns without the generic 64 KiB tool limit dropping them', async t => {
  const limits = defaults().collaboration.limits;
  limits.readHelpers.perTurn = 32;
  const f = fixture(t, { limits: () => limits, runner: { async run(input) {
    const contract = input.handoff!.contract;
    const report = returnFromText(contract, 'evidence', { tokens: 2, toolCalls: 0, durationMs: 1 });
    report.concerns = [];
    const base = Buffer.byteLength(JSON.stringify(report));
    report.concerns = ['x'.repeat(contract.returnContract.maxTokens - base - 2)];
    return { text: JSON.stringify(report), inputTokens: 1, outputTokens: 1 };
  } } });
  const taskIds: string[] = [];
  for (let i = 0; i < 32; i++) {
    const toAgent = `helper-${i}`;
    f.collab.addAgent(owner(), f.project.id, toAgent);
    const result = await f.call('consult_agent', { projectId: f.project.id, toAgent, objective: 'inspect', wait: false });
    assert.ok(!result.isError, JSON.stringify(result));
    taskIds.push((result.value as { taskId: string }).taskId);
  }
  const result = await f.call('await_delegations', { taskIds, timeoutMs: 1000 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal((result.value as { results: unknown[] }).results.length, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) > DEFAULT_MAX_RESULT_BYTES, 'the fixture must exercise the old overflow');
});
