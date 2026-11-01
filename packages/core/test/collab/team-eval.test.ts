import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTeamTasks, parseTeamTask, evaluationArms, planArm, planComparison, missingArmCapabilities, localCapacityTrials } from '../../src/collab/team-eval.ts';
import type { ComparisonBudget } from '../../src/collab/team-eval.ts';
const fixtureRoot = new URL('../../../../tests/bench/coding/team/', import.meta.url);

test('the team tier has twelve decomposable and six coupled tasks across four languages', async () => {
  const tasks = await loadTeamTasks(fixtureRoot);
  assert.equal(tasks.length, 18);
  assert.equal(tasks.filter(task => task.kind === 'decomposable').length, 12);
  assert.equal(tasks.filter(task => task.kind === 'coupled').length, 6);
  assert.deepEqual([...new Set(tasks.map(task => task.language))].sort(), ['go', 'python', 'rust', 'typescript']);
  assert.equal(new Set(tasks.map(task => task.id)).size, 18);
  for (const task of tasks) {
    assert.equal(task.license, 'MIT');
    assert.equal(task.tier, 'team');
    assert.ok(task.budgets.tokens > 0 && task.budgets.maxRounds > 0 && task.budgets.wallMs > 0);
    assert.equal(new Set(task.seeds).size, 3);
    assert.ok(task.packages.length >= 3 && task.packages.length <= 5);
  }
});

test('initial arm definitions keep future team and best-of-n execution unavailable', () => {
  const arms = evaluationArms();
  assert.deepEqual(arms.map(arm => arm.id), ['single', 'single-highest-effort', 'single+review', 'explore+single']);
  assert.equal(arms.find(arm => arm.id === 'single-highest-effort')!.effort, 'highest');
  assert.ok(arms.find(arm => arm.id === 'explore+single')!.requires.includes('async-consult'));
  for (const id of ['team', 'best-of-n']) assert.throws(() => planArm(id, { regime: 'matched', capTokens: 8192 }), /unavailable/);
});

test('matched budgets include all roles and never multiply the task cap by worker count', () => {
  for (const arm of evaluationArms()) {
    const plan = planArm(arm.id, { regime: 'matched', capTokens: 8192 });
    assert.equal(plan.budget.capTokens, 8192);
    assert.equal(plan.budget.accounting, 'all-model-calls');
    assert.equal(plan.budget.pool, 'shared-task');
  }
  assert.throws(() => planArm('single', { regime: 'matched', capTokens: 0 }), /positive/);
  assert.throws(() => planArm('single', { regime: 'matched', capTokens: NaN }), /positive/);
});

test('local capacity measurements describe concurrency one, two and four without invented results', () => {
  assert.deepEqual(localCapacityTrials(), { requestConcurrency: [1, 2, 4], writerCapacityMultipliers: [1, 1.5, 2] });
});

test('a comparison owns one matched cap; natural caps must be supplied for every arm', () => {
  const plans = planComparison(['single', 'explore+single'], { regime: 'matched', capTokens: 8192 });
  assert.deepEqual(plans.map(plan => plan.budget.capTokens), [8192, 8192]);
  const natural = planComparison(['single', 'single+review'], { regime: 'natural', caps: { single: 4096, 'single+review': 6144 } });
  assert.deepEqual(natural.map(plan => plan.budget.capTokens), [4096, 6144]);
  assert.throws(() => planComparison(['single', 'single+review'], { regime: 'natural', caps: { single: 4096 } }), /missing natural budget/);
  assert.throws(() => planComparison(['single', 'single'], { regime: 'matched', capTokens: 8192 }), /distinct/);
  const typo = { regime: 'natural', caps: { single: 4096, 'single+reveiw': 6144 } } as unknown as ComparisonBudget;
  assert.throws(() => planComparison(['single'], typo), /unknown natural budget arm/);
});

test('a fixture root must be an explicit file directory URL', async () => {
  await assert.rejects(loadTeamTasks(new URL(fixtureRoot.href.slice(0, -1))), /directory file URL/);
  await assert.rejects(loadTeamTasks(new URL('https://example.invalid/team/')), /directory file URL/);
});

test('matched comparisons reject a runtime per-arm cap map and do not copy unknown budget fields', () => {
  const forged = { regime: 'matched', caps: { single: 1, 'single+review': 9000 } } as unknown as ComparisonBudget;
  assert.throws(() => planComparison(['single', 'single+review'], forged), /matched/);
  const budget = { regime: 'matched' as const, capTokens: 8192, extra: 'must-not-travel' };
  assert.deepEqual(planArm('single', budget).budget, { regime: 'matched', capTokens: 8192, accounting: 'all-model-calls', pool: 'shared-task' });
});

test('capabilities distinguish declared exploration from an executable binding', () => {
  const arm = evaluationArms().find(arm => arm.id === 'explore+single')!;
  assert.deepEqual(missingArmCapabilities(arm, new Set()), ['b1-runner', 'async-consult']);
  assert.deepEqual(missingArmCapabilities(arm, new Set(['b1-runner'])), ['async-consult']);
  assert.deepEqual(missingArmCapabilities(arm, new Set(['b1-runner', 'async-consult'])), []);
  const returned = evaluationArms();
  returned[0]!.requires = [];
  assert.deepEqual(evaluationArms()[0]!.requires, ['b1-runner']);
});

test('task manifests reject traversal, duplicate seeds, unknown fields and future dependencies', async () => {
  const original = (await loadTeamTasks(fixtureRoot))[0]!;
  for (const modify of [
    (task: typeof original) => { task.instruction = '../private'; },
    (task: typeof original) => { task.seedGenerator = '*.mjs'; },
    (task: typeof original) => { task.seeds = [1, 1, 2]; },
    (task: typeof original) => { task.packages[0]!.dependsOn = [task.packages[1]!.id]; },
    (task: typeof original) => { task.packages[0]!.owns = ['src/*']; },
    (task: typeof original) => { task.packages[0]!.owns = [task.packages[1]!.entry]; },
    (task: typeof original) => { task.packages[1]!.entry = task.packages[0]!.entry; task.packages[1]!.owns = [task.packages[0]!.entry]; },
    (task: typeof original) => { task.packages[0]!.entry = 'src/group.__SEED__.py'; task.packages[0]!.owns = [task.packages[0]!.entry]; },
    (task: typeof original) => { (task as unknown as Record<string, unknown>).extra = true; },
    (task: typeof original) => { (task as unknown as Record<string, unknown>).language = ['go']; },
  ]) {
    const task = structuredClone(original);
    modify(task);
    assert.throws(() => parseTeamTask(task));
  }
  const coupled = structuredClone((await loadTeamTasks(fixtureRoot)).find(task => task.kind === 'coupled')!);
  coupled.packages[1]!.entry = 'src/other.__SEED__.ts';
  coupled.packages[1]!.owns = [coupled.packages[1]!.entry];
  assert.throws(() => parseTeamTask(coupled), /share an entry/);
});
