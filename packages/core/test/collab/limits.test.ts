/** D124: class budgets, project narrowing and independent deadlines remain enforceable without real time or models. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { defaults, validate } from '@plur1bus/config-schema';
import { resolveCollabLimits, delegationWorkBudget } from '../../src/collab/limits.ts';
import { createCollab } from '../../src/collab/service.ts';
import { CollabStore } from '../../src/collab/store.ts';
import { migrate } from '../../src/collab/migrations.ts';
import { evaluateGuardrails } from '../../src/collab/guardrails.ts';
import { DEFAULT_COLLAB_SETTINGS } from '../../src/collab/defaults.ts';
import { currentAgentScope } from '../../src/collab/scope.ts';
import { writerCapacity } from '../../src/collab/capacity.ts';
import { delegationToolView } from '../../src/collab/runner.ts';
import { scopeFor } from '../../src/collab/scope.ts';
import { owner } from './helpers.ts';
import { useTempDirs } from '../composition/helpers.ts';

const tmp = useTempDirs('tm1-limits-');

test('schema owns all five class limits, helper ceiling 32, writer default 4 and live advanced metadata', () => {
  const limits = defaults().collaboration.limits;
  assert.deepEqual(limits.readHelpers, { perTurn: 8, depth: 2 });
  assert.equal(limits.writers.perProject, 4);
  assert.equal(limits.consults.perPairPerTurn, 4);
  assert.deepEqual(Object.values(limits.taskClasses).map(value => value.rounds), [25, 50, 40, 100, 200]);
  assert.deepEqual(Object.values(limits.taskClasses).map(value => value.wallTimeMs), [300000, 900000, 1200000, 2700000, 7200000]);
  const config = defaults();
  config.collaboration.limits.readHelpers.perTurn = 33;
  assert.equal(validate(config).ok, false);
  config.collaboration.limits.readHelpers.perTurn = 32;
  config.collaboration.limits.writers.perProject = 100;
  assert.equal(validate(config).ok, true, 'writers have no fixed upper ceiling');
  config.collaboration.teams.disk.minFreeBytes = 0;
  assert.equal(validate(config).ok, false, 'the future worktree scheduler cannot disable the disk floor');
});

test('hardware capacity takes the smaller CPU/RAM bound and permits explicit overcommit with a warning fact', () => {
  const settings = defaults().collaboration.teams.capacity;
  assert.deepEqual(writerCapacity(4, { cores: 16, availableMemory: 8 * 1024 ** 3, settings }), { computed: 2, slots: 2, exceeded: false });
  assert.deepEqual(writerCapacity(4, { cores: 2, availableMemory: 64 * 1024 ** 3, settings: { ...settings, maxWriters: 4 } }), { computed: 1, slots: 4, exceeded: true });
  assert.equal(writerCapacity(100, { cores: 128, availableMemory: 512 * 1024 ** 3, settings }).slots, 100);
  assert.equal(writerCapacity(4, { cores: 1, availableMemory: 1, settings }).computed, 1);
});

test('project overrides can only narrow; absent legacy defaults cannot cap every class at 25 rounds', () => {
  const config = defaults().collaboration.limits;
  config.readHelpers.perTurn = 6;
  const limits = resolveCollabLimits(config, { maxDepth: 99, maxFanout: 30, maxPairPerTurn: 2, timeoutMs: 1000000 });
  assert.equal(limits.readHelpers.perTurn, 6);
  assert.equal(limits.readHelpers.depth, 2);
  assert.equal(limits.consults.perPairPerTurn, 2);
  assert.equal(limits.taskClasses['code-large'].rounds, 200);
  assert.equal(limits.taskClasses['code-large'].wallTimeMs, 1000000);
  assert.equal(limits.taskClasses.consult.wallTimeMs, 300000);
});

test('versionless defaults normalize on read; the next save marks settings, preserves intentional 3, and is idempotent', () => {
  const path = join(tmp.make(), 'collab.sqlite');
  const old = new DatabaseSync(path);
  migrate(old);
  const settings = { maxDepth: 1, maxFanout: 3, maxPairPerTurn: 2, maxTurns: 25, timeoutMs: 300000, returnTokens: 2000, repeatWindowMs: 30000, allowCrossProject: false, tokenBudget: null };
  const insert = old.prepare('INSERT INTO projects(id,name,owner,settings,created_at,updated_at) VALUES (?,?,?,?,1,1)');
  insert.run('defaults', 'Defaults', 'person', JSON.stringify(settings));
  insert.run('custom', 'Custom', 'person', JSON.stringify({ ...settings, maxFanout: 2, timeoutMs: 150000 }));
  old.close();
  const config = defaults().collaboration.limits;
  const store = new CollabStore({ path, limits: () => config });
  tmp.onCleanup(() => store.close());
  assert.equal(store.limits('defaults').readHelpers.perTurn, 8);
  assert.equal(store.limits('defaults').taskClasses['code-large'].rounds, 200);
  assert.equal(store.limits('custom').readHelpers.perTurn, 2);
  assert.equal(store.limits('custom').taskClasses['code-large'].wallTimeMs, 150000);
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare('SELECT settings FROM projects WHERE id=?').get('defaults') as { settings: string }).settings, JSON.stringify(settings), 'reading alone does not write');
  store.setSettings('defaults', { maxFanout: 3 });
  store.updateProject('custom', 'Renamed');
  assert.equal(store.limits('defaults').readHelpers.perTurn, 3);
  const saved = (raw.prepare('SELECT settings FROM projects WHERE id=?').get('defaults') as { settings: string }).settings;
  assert.deepEqual(JSON.parse(saved), { repeatWindowMs: 30000, allowCrossProject: false, tokenBudget: null, maxFanout: 3, settingsVersion: 2 });
  assert.equal(JSON.parse((raw.prepare('SELECT settings FROM projects WHERE id=?').get('custom') as { settings: string }).settings).settingsVersion, 2);
  const project = store.createProject({ name: 'New', owner: 'person' });
  config.readHelpers.perTurn = 5;
  assert.equal(store.limits(project.id).readHelpers.perTurn, 5);
  store.setSettings('defaults', {});
  assert.equal((raw.prepare('SELECT settings FROM projects WHERE id=?').get('defaults') as { settings: string }).settings, saved, 'a second pass changes nothing');
  store.close();
  const reopened = new CollabStore({ path, limits: () => config });
  assert.equal(reopened.limits('defaults').readHelpers.perTurn, 3);
  reopened.close();
  raw.close();
});

test('read depth 2 is allowed; nested writers and a third read hop are refused; chain age does not expire new children', () => {
  const input = { settings: DEFAULT_COLLAB_SETTINGS, fromAgent: 'worker', toAgent: 'helper', path: ['lead', 'worker'], fanout: 0, pairCount: 0, now: 2000000, chainStartedAt: 0, lastRepeatAt: null, sameProject: true, tokensUsed: 0, nextTokens: 1 };
  assert.equal(evaluateGuardrails({ ...input, callClass: 'read' }), null);
  assert.equal(evaluateGuardrails({ ...input, callClass: 'write' }), 'depth');
  assert.equal(evaluateGuardrails({ ...input, toAgent: 'fourth', path: ['lead', 'worker', 'helper'], callClass: 'read' }), 'depth');
});

test('work budget reserves before calls, counts settled usage and shares the parent allocation', () => {
  const parent = delegationWorkBudget(100);
  const child = delegationWorkBudget(90, parent);
  const first = child.reserve(60);
  assert.throws(() => parent.reserve(50), /allocation exceeded/);
  first.settle(30);
  assert.equal(parent.used, 30);
  assert.equal(child.used, 30);
  const second = child.reserve(50);
  second.release();
  second.settle(50);
  assert.equal(child.used, 30, 'a released ticket cannot settle twice');
  const third = parent.reserve(70);
  assert.throws(() => child.reserve(1), /allocation exceeded/);
  third.release();
});

test('writer tools are the intersection of the trusted receiver view and the contract; an empty contract stays closed', () => {
  const held = scopeFor('writer', 'project');
  held.toolView = ['file.read'];
  held.delegation = { traceId: 'trace', spanId: 'span', path: ['lead', 'writer'], callClass: 'write', workBudget: delegationWorkBudget(100) };
  const input = { agentId: 'writer', question: 'work', context: '', signal: new AbortController().signal };
  assert.deepEqual(delegationToolView(input, held), { toolView: [] });
  const scoped = { ...input, handoff: { contract: { constraints: { scope: { tools: ['file.read', 'exec.run'] } } }, context: {} } } as import('../../src/collab/runner.ts').AgentRunInput;
  assert.deepEqual(delegationToolView(scoped, held), { toolView: ['file.read'] });
});

test('malformed stored scalar limits cannot disable budget or repeat guards', () => {
  const limits = resolveCollabLimits(undefined, { tokenBudget: 'invalid', repeatWindowMs: -1, allowCrossProject: 'yes' } as unknown as import('../../src/collab/types.ts').CollabSettings);
  assert.equal(limits.tokenBudget, 0);
  assert.equal(limits.repeatWindowMs, 30000);
  assert.equal(limits.allowCrossProject, false);
});

test('service capacity does not reserve already running writers a second time, and explicit overcommit warns', async t => {
  for (const override of [false, true]) {
    const barrier = Promise.withResolvers<void>();
    let active = 0, maximum = 0;
    const warnings: string[] = [];
    const settings = defaults().collaboration.teams.capacity;
    const collab = createCollab({ path: ':memory:', capacity: () => ({ cores: override ? 2 : 16, availableMemory: (16 - active * 4) * 1024 ** 3, totalMemory: 16 * 1024 ** 3, settings: { ...settings, ...(override ? { maxWriters: 4 } : {}) } }), logWarn: text => warnings.push(text), runner: { async run() {
      active++; maximum = Math.max(maximum, active);
      if (active === 4) barrier.resolve();
      try { await barrier.promise; return { text: 'done', inputTokens: 1, outputTokens: 1 }; }
      finally { active--; }
    } } });
    t.after(async () => { barrier.resolve(); await collab.shutdown(); });
    const project = collab.createProject(owner(), { name: 'Capacity', settings: { repeatWindowMs: 0 } });
    for (const agent of ['lead', 'a', 'b', 'c', 'd']) collab.addAgent(owner(), project.id, agent);
    const handles = ['a', 'b', 'c', 'd'].map(toAgent => collab.delegate({ principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent, task: 'work', acceptanceCriteria: 'done' }));
    const results = await Promise.all(handles.map(handle => handle.done));
    assert.ok(results.every(result => result.status === 'succeeded'));
    assert.equal(maximum, 4);
    assert.equal(warnings.filter(text => text.includes('team.capacity.exceeded')).length, override ? 3 : 0);
  }
});

test('failed task inserts never consume persistent project writer slots', async t => {
  let duplicate = false, sequence = 0, other = 0;
  const collab = createCollab({ path: ':memory:', newId: prefix => prefix === 'tsk' ? duplicate ? 'tsk-1' : `tsk-${++sequence}` : `${prefix}-${++other}`, runner: { async run() { return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } });
  t.after(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Storage failure', settings: { repeatWindowMs: 0 } });
  for (const agent of ['lead', 'writer']) collab.addAgent(owner(), project.id, agent);
  const input = { principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent: 'writer', task: 'work', acceptanceCriteria: 'done' };
  assert.equal((await collab.delegate(input).done).status, 'succeeded');
  duplicate = true;
  for (let i = 0; i < 4; i++) assert.throws(() => collab.delegate(input), /UNIQUE constraint/);
  duplicate = false;
  assert.equal((await collab.delegate(input).done).status, 'succeeded');
});

test('a failure while marking a task running still releases its writer slot', async t => {
  let throwClock = false, inject = true;
  const limits = defaults().collaboration.limits;
  limits.writers.perProject = 1;
  const collab = createCollab({ path: ':memory:', limits: () => limits, clock: () => { if (throwClock) { throwClock = false; throw new Error('injected store clock failure'); } return Date.now(); }, emit: { emit(event) { if (inject && event.type === 'delegate.queued') { inject = false; throwClock = true; } } }, runner: { async run() { return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } });
  t.after(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Running failure', settings: { repeatWindowMs: 0 } });
  for (const agent of ['lead', 'writer']) collab.addAgent(owner(), project.id, agent);
  const input = { principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent: 'writer', task: 'work', acceptanceCriteria: 'done' };
  assert.equal((await collab.delegate(input).done).status, 'failed');
  assert.equal((await collab.delegate(input).done).status, 'succeeded');
});

test('a code-large delegation survives the old five-minute chain timer and keeps its own 200-round limit', async t => {
  let now = 1000;
  const scheduled = new Set<{ at: number; fire(): void }>();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let runInput: import('../../src/collab/runner.ts').AgentRunInput | undefined;
  const collab = createCollab({ path: ':memory:', clock: () => now, timers: { set(callback, ms) { const entry = { at: now + ms, fire: callback }; scheduled.add(entry); return () => scheduled.delete(entry); } }, runner: { async run(input) { runInput = input; started.resolve(); await finish.promise; input.signal.throwIfAborted(); return { text: 'done', inputTokens: 1, outputTokens: 1 }; } } });
  t.after(async () => { finish.resolve(); await collab.shutdown(); });
  const project = collab.createProject(owner(), { name: 'Code' });
  for (const agent of ['lead', 'writer']) collab.addAgent(owner(), project.id, agent);
  const handle = collab.delegate({ principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent: 'writer', task: 'build', acceptanceCriteria: 'passes', taskClass: 'code-large' });
  await started.promise;
  now += 300001;
  for (const timer of [...scheduled]) if (timer.at <= now) timer.fire();
  assert.equal(runInput!.signal.aborted, false);
  assert.equal(runInput!.maxRounds, 200);
  finish.resolve();
  assert.equal((await handle.done).status, 'succeeded');
  assert.equal(scheduled.size, 0);
});

test('the service propagates an unforgeable nested path and refuses a writer at depth 2', async t => {
  let collab: ReturnType<typeof createCollab>;
  let nestedPath: string[] | undefined;
  collab = createCollab({ path: ':memory:', runner: { async run(input) {
    const held = currentAgentScope()!;
    if (input.agentId === 'worker') {
      const origin = held.delegation!;
      assert.throws(() => collab.delegate({ principal: owner(), projectId: held.projectId, fromAgent: 'worker', toAgent: 'helper', task: 'write', acceptanceCriteria: 'done', traceId: origin.traceId, path: origin.path }), /depth/);
      await collab.consult({ principal: owner(), projectId: held.projectId, fromAgent: 'worker', toAgent: 'helper', question: 'inspect', context: '', traceId: origin.traceId, path: origin.path });
    } else nestedPath = held.delegation!.path;
    return { text: 'done', inputTokens: 1, outputTokens: 1 };
  } } });
  t.after(() => collab.shutdown());
  const project = collab.createProject(owner(), { name: 'Nested' });
  for (const agent of ['lead', 'worker', 'helper']) collab.addAgent(owner(), project.id, agent);
  await collab.consult({ principal: owner(), projectId: project.id, fromAgent: 'lead', toAgent: 'worker', question: 'inspect', context: '' });
  assert.deepEqual(nestedPath, ['lead', 'worker', 'helper']);
  assert.equal(collab.listTraces(owner(), project.id).length, 1);
});
