import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTeamTasks, parseTeamTask, evaluationArms, planArm, planComparison, missingArmCapabilities, localCapacityTrials, canonicalArmId } from '../../src/collab/team-eval.ts';
import type { ComparisonBudget } from '../../src/collab/team-eval.ts';
const fixtureRoot = new URL('../../../../tests/bench/coding/team/', import.meta.url);

test('arm identity comes from family and JSON parameters, independent of object key order', () => {
  const first = { family: 'team', params: { workers: 4, routing: { effort: 'highest', review: true } } };
  const reordered = { family: 'team', params: { routing: { review: true, effort: 'highest' }, workers: 4 } };
  assert.equal(canonicalArmId(first), canonicalArmId(reordered));
  assert.notEqual(canonicalArmId(first), canonicalArmId({ ...first, params: { ...first.params, workers: 2 } }));
  assert.notEqual(canonicalArmId(first), canonicalArmId({ ...first, family: 'best-of-n' }));
  assert.match(canonicalArmId(first), /^[a-z][a-z0-9-]{0,63}$/);
  assert.equal(canonicalArmId({ family: 'single', params: {} }), 'single');
});

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
  assert.deepEqual(arms.map(({ family, params }) => ({ family, params })), [
    { family: 'single', params: {} }, { family: 'single', params: { effort: 'highest' } },
    { family: 'single', params: { review: true } }, { family: 'explore+single', params: {} },
  ]);
  for (const arm of arms) assert.equal(arm.id, canonicalArmId(arm));
  assert.equal(arms.find(arm => arm.params.effort === 'highest')!.family, 'single');
  assert.ok(arms.find(arm => arm.family === 'explore+single')!.requires.includes('async-consult'));
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
  const plans = planComparison([{ family: 'single', params: {} }, { family: 'explore+single', params: {} }], { regime: 'matched', capTokens: 8192 });
  assert.deepEqual(plans.map(plan => plan.budget.capTokens), [8192, 8192]);
  const review = { family: 'single', params: { review: true } };
  const reviewId = canonicalArmId(review);
  const natural = planComparison(['single', review], { regime: 'natural', caps: { single: 4096, [reviewId]: 6144 } });
  assert.deepEqual(natural.map(plan => plan.budget.capTokens), [4096, 6144]);
  assert.throws(() => planComparison(['single', review], { regime: 'natural', caps: { single: 4096 } }), /missing natural budget/);
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
  assert.throws(() => planComparison(['single', { family: 'single', params: { review: true } }], forged), /matched/);
  const budget = { regime: 'matched' as const, capTokens: 8192, extra: 'must-not-travel' };
  assert.deepEqual(planArm('single', budget).budget, { regime: 'matched', capTokens: 8192, accounting: 'all-model-calls', pool: 'shared-task' });
});

test('capabilities distinguish declared exploration from an executable binding', () => {
  const arm = evaluationArms().find(arm => arm.family === 'explore+single')!;
  assert.deepEqual(missingArmCapabilities(arm, new Set()), ['b1-runner', 'async-consult']);
  assert.deepEqual(missingArmCapabilities(arm, new Set(['b1-runner'])), ['async-consult']);
  assert.deepEqual(missingArmCapabilities(arm, new Set(['b1-runner', 'async-consult'])), []);
  const returned = evaluationArms();
  returned[0]!.requires = [];
  (returned[1]!.params as Record<string, unknown>).effort = 'changed';
  assert.deepEqual(evaluationArms()[0]!.requires, ['b1-runner']);
  assert.deepEqual(evaluationArms()[1]!.params, { effort: 'highest' });
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


test('canonical arm IDs distinguish array order, JSON types, exact strings and slug-alias families', () => {
  const id = (params: Record<string, unknown>) => canonicalArmId({ family: 'future-control', params } as never);
  assert.notEqual(id({ route: ['a', 'b'] }), id({ route: ['b', 'a'] }));
  assert.notEqual(id({ review: true }), id({ review: 'true' }));
  assert.notEqual(id({ separator: '\r\n' }), id({ separator: '\n' }));
  assert.notEqual(canonicalArmId({ family: 'explore+single', params: {} }), canonicalArmId({ family: 'explore-single', params: {} }));
  assert.equal(canonicalArmId({ family: 'a'.repeat(31), params: { workers: 4 } }).length, 64);
  for (const family of ['', 'Uppercase', '../single', 'a'.repeat(32)]) assert.throws(() => canonicalArmId({ family, params: {} }), /definition/);
});

test('non-JSON arm parameters fail before assigning an identity', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const sparse = Array(2);
  const extra = [1]; Object.assign(extra, { extra: true });
  let accessed = false;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { accessed = true; return 'not data'; } });
  for (const value of [NaN, Infinity, undefined, () => {}, Symbol('x'), 1n, new Date(0), new Map(), cycle, sparse, extra, getter]) {
    assert.throws(() => canonicalArmId({ family: 'single', params: { value } } as never), /arm parameters?/);
  }
  assert.equal(accessed, false);
  for (const params of [null, [], 'not an object']) assert.throws(() => canonicalArmId({ family: 'single', params } as never), /definition/);
});

test('plans resolve structured descriptors and reject duplicate canonical identities or forged metadata', () => {
  const review = { family: 'single', params: { review: true } };
  const forged = { ...review, id: 'single', requires: [], roles: [] };
  const plan = planArm(forged, { regime: 'matched', capTokens: 8192 });
  assert.equal(plan.arm.id, canonicalArmId(review));
  assert.ok(plan.arm.requires.includes('independent-review'));
  assert.deepEqual(plan.arm.roles, ['writer', 'reviewer']);
  assert.throws(() => planComparison(['single', { family: 'single', params: {} }], { regime: 'matched', capTokens: 8192 }), /distinct/);
  assert.throws(() => planArm({ family: 'team', params: { workers: 4 } }, { regime: 'matched', capTokens: 8192 }), /unavailable/);
  assert.throws(() => planArm({ family: 'best-of-n', params: { n: 4 } }, { regime: 'matched', capTokens: 8192 }), /unavailable/);
});


test('canonical arm IDs have portable stable vectors for the initial controls', () => {
  assert.deepEqual(evaluationArms().map(arm => arm.id), [
    'single',
    'single-5be7d61d3b2f49413c4d430dfaaf5687',
    'single-bff1d9a24fe367a959440318b427f08a',
    'explore-single-941e9c8ec727e2d5fd29d1b15d2e64ed',
  ]);
});


test('canonicalization bounds repeated-reference expansion while allowing ordinary shared data', () => {
  const shared = { effort: 'highest' };
  assert.equal(canonicalArmId({ family: 'team', params: { a: shared, b: shared } }),
    canonicalArmId({ family: 'team', params: { a: { effort: 'highest' }, b: { effort: 'highest' } } }));
  let expanded: unknown = { value: 1 };
  for (let depth = 0; depth < 20; depth++) expanded = [expanded, expanded];
  assert.throws(() => canonicalArmId({ family: 'team', params: { expanded } } as never), /node limit/);
});
