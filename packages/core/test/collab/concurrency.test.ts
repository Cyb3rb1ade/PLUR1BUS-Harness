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

test('turn cancellation collects partial results from both unbound and card-bound children', async t => {
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
  f.collab.boardStore.assign(f.project.id, card.id, { kind: 'agent', id: 'lead' }, true, { kind: 'person', id: owner().userId });
  assert.equal((await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect', wait: false })).isError, false);
  const bound = await f.call('delegate_task', { projectId: f.project.id, toAgent: 'b', objective: 'continue', cardId: card.id, wait: false });
  assert.ok(!bound.isError);
  await started.promise;
  const results = await f.request.delegations!.finish(true);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.result!.status, 'partial');
  assert.match(results[0]!.result!.summary, /inspected the first file/);
  assert.equal(cardSignal!.aborted, true);
  releaseCard.resolve();
  const collected = await f.call('await_delegations', { taskIds: [(bound.value as { taskId: string }).taskId], timeoutMs: 1000 });
  assert.ok(!collected.isError);
  assert.deepEqual((collected.value as { results: unknown[] }).results, []);
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

test('review rejects a writing scope before admission and defaults to read tools', async t => {
  const views: string[][] = [];
  const f = fixture(t, { runner: { async run(input) {
    views.push([...alsAgentScopePort().current()!.toolView]);
    return { text: 'review', inputTokens: 1, outputTokens: 1 };
  } } });
  const refused = await f.call('request_review', { projectId: f.project.id, toAgent: 'a', objective: 'review', scope: { paths: [], tools: ['file.write'] } });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /unauthorized/);
  assert.equal(views.length, 0);
  await f.call('request_review', { projectId: f.project.id, toAgent: 'a', objective: 'review' });
  assert.deepEqual(views, [['file.read', 'file.list', 'file.stat']]);
});

for (const [name, taskClass] of [['consult_agent', 'code-large'], ['request_review', 'consult'], ['delegate_task', 'review']]) test(`${name} rejects an incompatible task class at both entry points`, async t => {
  let runs = 0;
  const f = fixture(t, { runner: { async run() { runs++; return { text: 'done', inputTokens: 0, outputTokens: 0 }; } } });
  const args = { projectId: f.project.id, toAgent: 'a', objective: 'inspect', taskClass };
  assert.equal((await f.call(name!, args)).isError, true);
  await assert.rejects(f.registry.get(name!)!.execute(args, f.context), /task class/);
  assert.equal(runs, 0);
});

test('card validation refuses missing, foreign and unassigned cards before starting work or review', async t => {
  let runs = 0, reviews = 0;
  const f = fixture(t, { runner: { async run() { runs++; return { text: 'done', inputTokens: 0, outputTokens: 0 }; } } });
  f.config.review = { start() { reviews++; return {}; }, root: () => '/tmp', finish() {} };
  const foreign = f.collab.createProject(owner(), { name: 'Foreign' });
  const make = (project: string) => f.collab.boardStore.createCard(project, { title: 'Card', columnId: f.collab.boardStore.columns(project)[0]!.id }, { kind: 'person', id: owner().userId });
  for (const cardId of ['missing', make(foreign.id).id, make(f.project.id).id]) for (const name of ['consult_agent', 'delegate_task', 'request_review']) {
    const result = await f.call(name, { projectId: f.project.id, toAgent: 'a', objective: 'inspect', cardId, ...(name === 'request_review' ? {} : { wait: false }) });
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(result)}`);
  }
  assert.equal(runs, 0); assert.equal(reviews, 0);
});

test('service refusal releases the turn and pair start allowances', async t => {
  const f = fixture(t, { runner: { async run() { return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } }, { maxFanout: 1, maxPairPerTurn: 1 });
  f.collab.removeAgent(owner(), f.project.id, 'a');
  assert.equal((await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect' })).isError, true);
  f.collab.addAgent(owner(), f.project.id, 'a');
  assert.equal((await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect' })).isError, false);
});

test('handoff acknowledgement cancels old unbound work and collects its partial output', async t => {
  const oldStarted = Promise.withResolvers<void>();
  let oldSignal: AbortSignal | undefined, handoffSignal: AbortSignal | undefined;
  const f = fixture(t, { runner: { async run(input) {
    if (input.agentId === 'a') {
      oldSignal = input.signal;
      input.onProgress?.({ text: 'old evidence', inputTokens: 1, outputTokens: 1 });
      oldStarted.resolve();
      return new Promise(() => {});
    }
    handoffSignal = input.signal;
    await input.handoff!.context.onAccepted?.();
    return { text: 'ownership accepted', inputTokens: 1, outputTokens: 1 };
  } } });
  await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'old work', wait: false });
  await oldStarted.promise;
  const result = await f.call('handoff', { projectId: f.project.id, toAgent: 'b', objective: 'take over' });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(oldSignal!.aborted, true);
  assert.equal(handoffSignal!.aborted, false);
  const collected = await f.request.delegations!.finish();
  assert.equal(collected.length, 1);
  assert.match(collected[0]!.result!.summary, /old evidence/);
});

test('nonblocking writers reserve shared CPU and RAM before asynchronous preparation', async t => {
  const gate = Promise.withResolvers<void>();
  const limits = defaults().collaboration;
  let prepared = 0, runs = 0;
  const f = fixture(t, { capacity: () => ({ cores: 4, availableMemory: limits.teams.capacity.memoryPerWriter * 2, settings: { ...limits.teams.capacity, coresPerWriter: 2 } }), runner: { async run() { runs++; return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } });
  t.after(() => gate.resolve());
  f.config.repair = async value => { prepared++; await gate.promise; return { ...(value as Handoff), objective: 'compact' }; };
  // A second closure/turn shares only the actual service, never local counters.
  const anotherRequest = { ...f.request, turnId: 'another-turn' };
  delete anotherRequest.delegations;
  const another = collaborationTools(f.config, anotherRequest).find(t => t.name === 'delegate_task')!;
  const ids: string[] = [];
  for (const toAgent of ['a', 'b', 'c', 'd']) {
    const result = await f.call('delegate_task', { projectId: f.project.id, toAgent, objective: 'x'.repeat(2200), doneWhen: ['done'], wait: false });
    assert.equal(result.isError, ids.length >= 2, JSON.stringify(result));
    if (!result.isError) ids.push((result.value as { taskId: string }).taskId);
  }
  await assert.rejects(another.execute({ projectId: f.project.id, toAgent: 'a', objective: 'other turn', wait: false }, f.context), /slots full/);
  assert.equal(prepared, 2); assert.equal(runs, 0);
  gate.resolve();
  const result = await f.call('await_delegations', { taskIds: ids, timeoutMs: 1000 });
  assert.ok(!result.isError);
  assert.equal((result.value as { results: unknown[] }).results.length, 2);
  assert.equal(runs, 2, 'admitted reservations must not be charged again');
  assert.equal((await f.call('delegate_task', { projectId: f.project.id, toAgent: 'c', objective: 'slot released' })).isError, false);
});

test('an admitted worker failure consumes its start allowance', async t => {
  let runs = 0;
  const f = fixture(t, { runner: { async run() { runs++; throw new Error('worker failed'); } } }, { maxFanout: 1 });
  assert.equal((await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'first' })).isError, true);
  const second = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'b', objective: 'second' });
  assert.equal(second.isError, true); assert.match(JSON.stringify(second), /fanout/); assert.equal(runs, 1);
});

test('writer reservations reject another identity and duplicate consumption; release is idempotent', async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const f = fixture(t, { runner: { async run() { await gate.promise; return { text: 'done', inputTokens: 0, outputTokens: 0 }; } } });
  const input = { principal: owner(), projectId: f.project.id, fromAgent: 'lead', toAgent: 'a', task: 'work', acceptanceCriteria: 'done' };
  const reservation = f.collab.reserveWriter(input);
  assert.throws(() => f.collab.delegate({ ...input, toAgent: 'b', writerReservation: reservation }), /identity mismatch/);
  const run = f.collab.delegate({ ...input, writerReservation: reservation });
  assert.throws(() => f.collab.delegate({ ...input, task: 'duplicate', writerReservation: reservation }), /already consumed/);
  gate.resolve(); await run.done;
  reservation.release(); reservation.release();
  assert.throws(() => f.collab.delegate({ ...input, task: 'released', writerReservation: reservation }), /already consumed/);
});

test('a nested reviewer default scope cannot inherit its writer parent write tools', async t => {
  let view: readonly string[] = [];
  const f = fixture(t, { runner: { async run() { view = alsAgentScopePort().current()!.toolView; return { text: 'review', inputTokens: 1, outputTokens: 1 }; } } });
  const scope = scopeFor('lead', f.project.id);
  scope.toolView = ['file.read', 'file.write'];
  scope.delegation = { traceId: f.collab.openChain(owner(), f.project.id, 'lead'), spanId: 'parent', path: ['lead'], callClass: 'write', workBudget: delegationWorkBudget(10000) };
  await runWithAgentScope(scope, () => f.call('request_review', { projectId: f.project.id, toAgent: 'a', objective: 'review' }));
  assert.deepEqual(view, ['file.read']);
});

for (const explicit of [false, true]) test(`card reviewer preserves the inherited read restriction at the actual provider (explicit=${explicit})`, async t => {
  const views: string[][] = [];
  const runner = composedAgentRunner({ id: 'card-review-scope', async *stream(request) {
    const h = JSON.parse(request.peerResults![0]!.text).handoff as Handoff;
    if (request.messages[0]?.text.startsWith('Acceptance check')) {
      yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] }) };
    } else {
      views.push([...(request.toolView ?? [])]);
      assert.equal(request.readOnlyWorktree, '/tmp/review-fixture');
      assert.deepEqual(h.constraints.scope.tools, ['file.stat']);
      assert.deepEqual(h.constraints.scope.paths, explicit ? ['src/**'] : ['**']);
      const report = returnFromText(h, 'review complete', { tokens: 2, toolCalls: 0, durationMs: 1 });
      report.output = { verdict: 'pass', findings: [] }; report.citations = ['repo:fixture'];
      yield { type: 'delta', text: JSON.stringify(report) };
    }
  } }, alsAgentScopePort(), tempDir('tm1-card-review-'));
  const f = fixture(t, { runner });
  const card = f.collab.boardStore.createCard(f.project.id, { title: 'Review', columnId: f.collab.boardStore.columns(f.project.id)[0]!.id }, { kind: 'person', id: owner().userId });
  f.collab.boardStore.assign(f.project.id, card.id, { kind: 'agent', id: 'lead' }, true, { kind: 'person', id: owner().userId });
  f.config.review = { start: () => ({}), root: () => '/tmp/review-fixture', finish() {} };
  const scope = scopeFor('lead', f.project.id);
  scope.toolView = explicit ? ['file.stat', 'file.read'] : ['file.stat'];
  scope.delegation = { traceId: f.collab.openChain(owner(), f.project.id, 'lead'), spanId: 'parent', path: ['lead'], callClass: 'write', workBudget: delegationWorkBudget(10000) };
  const result = await runWithAgentScope(scope, () => f.call('request_review', { projectId: f.project.id, cardId: card.id, toAgent: 'a', objective: 'review', ...(explicit ? { scope: { paths: ['src/**'], tools: ['file.stat'] } } : {}) }));
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(views, [['file.stat']]);
});

test('hardware capacity is shared while each project retains its own four writer slots', async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const settings = defaults().collaboration.teams.capacity;
  const f = fixture(t, { capacity: () => ({ cores: 16, availableMemory: 64 * 1024 ** 3, settings }), runner: { async run() { return { text: 'done', inputTokens: 0, outputTokens: 0 }; } } });
  delete f.request.projectId;
  const projects = [f.project, ...['B', 'C'].map(name => {
    const project = f.collab.createProject(owner(), { name, settings: { repeatWindowMs: 0 } });
    for (const agent of ['lead', 'a', 'b', 'c', 'd']) f.collab.addAgent(owner(), project.id, agent);
    return project;
  })];
  let prepared = 0;
  f.config.repair = async value => { prepared++; await gate.promise; return { ...(value as Handoff), objective: 'compact' }; };
  const args = (projectId: string, toAgent: string) => ({ projectId, toAgent, objective: 'x'.repeat(2200), doneWhen: ['done'], wait: false });
  const ids: string[] = [];
  for (const project of projects.slice(0, 2)) {
    for (const agent of ['a', 'b', 'c', 'd']) {
      const result = await f.call('delegate_task', args(project.id, agent));
      assert.ok(!result.isError, JSON.stringify(result));
      ids.push((result.value as { taskId: string }).taskId);
    }
    assert.equal((await f.call('delegate_task', args(project.id, 'a'))).isError, true, 'each project has only four slots');
  }
  assert.equal((await f.call('delegate_task', args(projects[2]!.id, 'a'))).isError, true, 'hardware has eight shared slots');
  assert.equal(prepared, 8);
  gate.resolve();
  const result = await f.call('await_delegations', { taskIds: ids, timeoutMs: 1000 });
  assert.ok(!result.isError); assert.equal((result.value as { results: unknown[] }).results.length, 8);
});

for (const name of ['consult_agent', 'delegate_task', 'request_review']) test(`${name} rechecks card assignment after asynchronous preparation`, async t => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let runs = 0;
  const f = fixture(t, { runner: { async run() { runs++; return { text: 'work after revocation', inputTokens: 1, outputTokens: 1 }; } } });
  const card = f.collab.boardStore.createCard(f.project.id, { title: 'Assigned work', columnId: f.collab.boardStore.columns(f.project.id)[0]!.id }, { kind: 'person', id: owner().userId });
  const sender = { kind: 'agent' as const, id: 'lead' }, person = { kind: 'person' as const, id: owner().userId };
  f.collab.boardStore.assign(f.project.id, card.id, sender, true, person);
  f.config.repair = async value => { entered.resolve(); await gate.promise; return { ...(value as Handoff), objective: 'compact' }; };
  f.config.review = { start: () => ({}), root: () => '/tmp/review-fixture', finish() {} };
  const call = f.call(name, { projectId: f.project.id, cardId: card.id, toAgent: 'a', objective: 'x'.repeat(2200), doneWhen: ['done'], ...(name !== 'request_review' ? { wait: false } : {}) });
  await entered.promise;
  f.collab.boardStore.assign(f.project.id, card.id, sender, false, person);
  gate.resolve();
  const output = await call;
  const results = await f.request.delegations!.finish();
  assert.equal(runs, 0);
  if (name === 'request_review') { assert.ok(output.isError); assert.match(JSON.stringify(output), /unauthorized/); }
  else { assert.ok(!output.isError); assert.equal(results[0]!.error!.code, 'unauthorized'); }
  assert.equal(f.collab.boardStore.comments(f.project.id, card.id, {}).items.length, 0);
});

test('a writer consulting with default scope exposes only read tools to the actual peer provider', async t => {
  let f: ReturnType<typeof fixture>;
  const views: (readonly string[])[] = [];
  const runner = composedAgentRunner({ id: 'writer-consult', async *stream(request) {
    if (request.messages[0]?.text.startsWith('Acceptance check')) {
      const h = JSON.parse(request.peerResults![0]!.text).handoff;
      yield { type: 'delta', text: JSON.stringify({ schema: 'plur1bus.ack/1', inReplyTo: h.id, objective: h.objective, status: 'ok', blockingQuestions: [] }) };
      return;
    }
    if (request.agentId === 'a') {
      const consult = collaborationTools(f.config, request).find(tool => tool.name === 'consult_agent')!;
      await consult.execute({ projectId: f.project.id, toAgent: 'b', objective: 'inspect' }, { ...f.context, agentId: 'a', signal: request.signal });
    } else views.push(request.toolView ?? []);
    yield { type: 'delta', text: 'inspection complete' };
  } }, alsAgentScopePort(), tempDir('tm1-writer-consult-'));
  f = fixture(t, { runner, toolView: () => ['file.read', 'file.write', 'unknown.tool', 'custom.read'] });
  f.config.toolEffect = name => name === 'custom.read' ? 'read' : undefined;
  const result = await f.call('delegate_task', { projectId: f.project.id, toAgent: 'a', objective: 'work with advice', scope: { paths: [], tools: ['file.read', 'file.write', 'unknown.tool', 'custom.read'] } });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(views, [['file.read', 'custom.read', 'consult_agent', 'await_delegations']]);
});

for (const bound of ['project', 'hardware'] as const) test(`writer ${bound} refusal records a guardrail span and audit event before preparation`, async t => {
  const events: import('../../src/collab/types.ts').CollabEvent[] = [];
  const limits = defaults().collaboration;
  const f = fixture(t, {
    emit: { emit: event => { events.push(event); } },
    ...(bound === 'hardware' ? { capacity: () => ({ cores: 1, availableMemory: limits.teams.capacity.memoryPerWriter, settings: limits.teams.capacity }) } : {}),
  });
  const reservations = Array.from({ length: bound === 'project' ? 4 : 1 }, () => f.collab.reserveWriter({ principal: owner(), projectId: f.project.id, fromAgent: 'lead', toAgent: 'a' }));
  t.after(() => reservations.forEach(reservation => reservation.release()));
  const denied = await f.call('delegate_task', { projectId: f.project.id, toAgent: 'b', objective: 'denied writer', wait: false });
  assert.equal(denied.isError, true);
  await f.request.delegations!.finish();
  const trace = f.collab.listTraces(owner(), f.project.id)[0]!;
  assert.equal(trace.spans.length, 1);
  assert.equal(trace.spans[0]!.kind, 'guardrail');
  assert.equal(trace.spans[0]!.status, 'refused');
  assert.equal(trace.spans[0]!.guardrail, 'fanout');
  assert.equal(trace.spans[0]!.parentSpanId, null);
  assert.equal(trace.status, 'failed');
  assert.deepEqual(events.filter(event => event.type === 'guardrail.refused').map(event => ({ traceId: event.traceId, agentId: event.agentId, reason: event.data.reason })), [{ traceId: trace.traceId, agentId: 'b', reason: 'fanout' }]);
  assert.throws(() => f.collab.reserveWriter({ principal: owner(), projectId: f.project.id, fromAgent: 'lead', toAgent: 'c', traceId: trace.traceId, parentSpanId: trace.spans[0]!.spanId }), /slots full/);
  const nested = f.collab.getTrace(owner(), trace.traceId).spans.find(span => span.agentId === 'c')!;
  assert.equal(nested.parentSpanId, trace.spans[0]!.spanId);
});


for (const cancelled of [false, true]) test(`blocking failure is delivered once when dispatcher cancellation=${cancelled}`, async t => {
  const started = Promise.withResolvers<void>();
  const f = fixture(t, { runner: { async run(input) {
    started.resolve();
    if (cancelled) {
      input.onProgress?.({ text: 'retained evidence', inputTokens: 1, outputTokens: 1 });
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      input.signal.throwIfAborted();
    }
    throw new Error('worker failure');
  } } });
  const abort = new AbortController();
  const dispatcher = new ToolDispatcher({ registry: f.registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const pending = dispatcher.call({ id: 'blocking-failure', name: 'delegate_task', args: { projectId: f.project.id, toAgent: 'a', objective: 'work' } }, { ...f.context, signal: abort.signal });
  await started.promise;
  if (cancelled) abort.abort(new Error('caller cancelled'));
  const result = await pending;
  assert.equal(result.isError, true);
  const joined = await f.request.delegations!.finish();
  if (cancelled) {
    assert.equal(joined.length, 1, 'a dispatcher abort must leave the child return for the final join');
    assert.equal(joined[0]!.result!.status, 'partial');
    assert.match(joined[0]!.result!.summary, /retained evidence/);
  } else {
    assert.match(JSON.stringify(result), /delegation failed/);
    assert.deepEqual(joined, [], 'a delivered blocking error must not reappear at turn completion');
  }
  assert.deepEqual(await f.request.delegations!.finish(), []);
});

for (const wait of [true, false]) test(`read-only delegate_task scope directs the caller to consult_agent, wait=${wait}`, async t => {
  let runs = 0;
  const f = fixture(t, { runner: { async run() { runs++; return { text: 'evidence', inputTokens: 1, outputTokens: 1 }; } } });
  f.config.toolEffect = name => name === 'custom.read' ? 'read' : undefined;
  const args = { projectId: f.project.id, toAgent: 'a', objective: 'inspect', wait, scope: { paths: [], tools: ['file.read', 'custom.read'] } };
  const refused = await f.call('delegate_task', args);
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /consult_agent/);
  assert.equal(runs, 0);
  assert.deepEqual(f.collab.listTraces(owner(), f.project.id), []);
  const consult = await f.call('consult_agent', { ...args, wait: true });
  assert.equal(consult.isError, false, JSON.stringify(consult));
  assert.equal(runs, 1);
});

for (const failed of [false, true]) for (const cancelled of [false, true]) test(`dispatcher acknowledges a completed blocking child only after acceptance: failed=${failed}, cancelled=${cancelled}`, async t => {
  const completed = Promise.withResolvers<void>(), accept = Promise.withResolvers<void>();
  t.after(() => accept.resolve());
  const f = fixture(t, { runner: { async run(input) {
    input.onProgress?.({ text: 'retained evidence', inputTokens: 1, outputTokens: 1 });
    if (failed) throw new Error('worker failed');
    return { text: 'retained evidence', inputTokens: 1, outputTokens: 1 };
  } } });
  const registry = new ToolRegistry();
  for (const tool of f.registry.entries()) registry.register({ ...tool, async execute(args, context) {
    try { return await tool.execute(args, context); }
    finally {
      // Pause at the real tool/dispatcher boundary after the child has settled.
      completed.resolve();
      await accept.promise;
    }
  } });
  const abort = new AbortController();
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const pending = dispatcher.call({ id: 'acceptance-race', name: 'delegate_task', args: { projectId: f.project.id, toAgent: 'a', objective: 'finish work' } }, { ...f.context, signal: abort.signal });
  await completed.promise;
  if (cancelled) abort.abort(new Error('cancel before dispatcher acceptance'));
  accept.resolve();
  const result = await pending;
  assert.equal(result.isError, cancelled || failed);
  if (cancelled) { assert.ok(result.isError); assert.equal(result.error.code, 'aborted'); }
  const joined = await f.request.delegations!.finish(true);
  assert.equal(joined.length, cancelled ? 1 : 0);
  if (cancelled && !failed) assert.match(joined[0]!.result!.summary, /retained evidence/);
  if (cancelled && failed) assert.equal(joined[0]!.error!.code, 'invalid');
  assert.deepEqual(await f.request.delegations!.finish(), []);
  // Cancellation of delivery does not rewrite the completed worker's outcome.
  assert.equal(f.collab.listTraces(owner(), f.project.id)[0]!.spans[0]!.status, failed ? 'failed' : 'succeeded');
});

for (const cancelled of [false, true]) test(`collection waits for dispatcher acceptance without losing or duplicating the child, cancelled=${cancelled}`, async t => {
  const completed = Promise.withResolvers<void>(), accept = Promise.withResolvers<void>();
  t.after(() => accept.resolve());
  const f = fixture(t, { runner: { async run() { return { text: 'collected evidence', inputTokens: 1, outputTokens: 1 }; } } });
  const started = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect', wait: false });
  assert.ok(!started.isError);
  const taskId = (started.value as { taskId: string }).taskId;
  const registry = new ToolRegistry();
  for (const tool of f.registry.entries()) registry.register({ ...tool, async execute(args, context) {
    const result = await tool.execute(args, context);
    completed.resolve();
    await accept.promise;
    return result;
  } });
  const abort = new AbortController();
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const pending = dispatcher.call({ id: 'collect-race', name: 'await_delegations', args: { taskIds: [taskId], timeoutMs: 1000 } }, { ...f.context, signal: abort.signal });
  await completed.promise;
  const competing = await f.call('await_delegations', { taskIds: [taskId], timeoutMs: 0 });
  assert.ok(!competing.isError);
  assert.deepEqual((competing.value as { results: unknown[] }).results, [], 'an in-flight delivery owns its claim');
  if (cancelled) abort.abort(new Error('cancel before collection acceptance'));
  accept.resolve();
  const output = await pending;
  assert.equal(output.isError, cancelled);
  const joined = await f.request.delegations!.finish(true);
  assert.equal(joined.length, cancelled ? 1 : 0);
  if (cancelled) assert.match(joined[0]!.result!.summary, /collected evidence/);
  else assert.match(JSON.stringify(output), /collected evidence/);
  assert.deepEqual(await f.request.delegations!.finish(), []);
});

test('a collection withheld by the dispatcher result limit releases its child claims', async t => {
  const f = fixture(t, { runner: { async run() { return { text: 'bounded evidence', inputTokens: 1, outputTokens: 1 }; } } });
  const started = await f.call('consult_agent', { projectId: f.project.id, toAgent: 'a', objective: 'inspect', wait: false });
  assert.ok(!started.isError);
  const registry = new ToolRegistry();
  registry.register({ ...f.registry.get('await_delegations')!, limits: { maxResultBytes: 1 } });
  const dispatcher = new ToolDispatcher({ registry, approvals: { async request() { throw new Error('unexpected approval'); } }, grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
  const output = await dispatcher.call({ id: 'limited', name: 'await_delegations', args: { taskIds: [(started.value as { taskId: string }).taskId], timeoutMs: 1000 } }, f.context);
  assert.ok(output.isError);
  assert.equal(output.error.code, 'tool-result-too-large');
  const joined = await f.request.delegations!.finish();
  assert.equal(joined.length, 1);
  assert.match(joined[0]!.result!.summary, /bounded evidence/);
  assert.deepEqual(await f.request.delegations!.finish(), []);
});
