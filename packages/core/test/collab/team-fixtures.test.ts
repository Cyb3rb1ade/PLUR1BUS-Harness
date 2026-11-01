import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { loadTeamTasks } from '../../src/collab/team-eval.ts';

const root = new URL('../../../../tests/bench/coding/team/', import.meta.url);
const materializer = await import(new URL('_shared/materialize.mjs', root).href) as {
  materialize(taskRoot: string, destination: string, seed: number, referenceStages?: number): Promise<unknown>;
  applyTree(source: string, destination: string, seed: number): Promise<void>;
  sourceFiles(directory: string): Promise<string[]>;
};
const checker = await import(new URL('_shared/check.mjs', root).href) as {
  verify(taskRoot: string, candidate: string, seed: number): Promise<{ checks: { scope: string; passed: boolean; cases: number; failures: string[] }[] }>;
  createProbe(task: (typeof tasks)[number], candidate: string, seed: number, scope?: string): Promise<{ invoke(scope: string, input: string): Promise<string>; close(): Promise<void> }>;
  validateCases(cases: unknown, scopes: string[]): void;
};
const tasks = await loadTeamTasks(root);

for (const task of tasks) test(`team fixture ${task.id}: every scope fails on start and passes on reference for all three seeds`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-self-test-'));
  const taskRoot = fileURLToPath(new URL(`${task.id}/`, root));
  const seenEntryFiles = new Set<string>();
  try {
    for (const seed of task.seeds) {
      const start = join(directory, `${seed}-start`), reference = join(directory, `${seed}-reference`);
      await materializer.materialize(taskRoot, start, seed);
      await materializer.materialize(taskRoot, reference, seed, task.packages.length);
      const publicFiles = await materializer.sourceFiles(start);
      assert.ok(publicFiles.includes('TASK.md') && publicFiles.includes('instance.json'));
      assert.ok(publicFiles.every(file => !/reference|check\.mjs|seed\.mjs/.test(file)), 'private fixture artifacts must not enter agent input');
      const entry = publicFiles.find(file => file.startsWith('src/'))!;
      assert.ok(entry && !entry.includes('__SEED__'));
      assert.ok(!seenEntryFiles.has(entry), 'filenames must vary across seeds');
      seenEntryFiles.add(entry);
      const before = await checker.verify(taskRoot, start, seed);
      const after = await checker.verify(taskRoot, reference, seed);
      assert.equal(before.checks.length, task.packages.length + 1);
      assert.ok(before.checks.every(check => !check.passed), JSON.stringify(before));
      assert.ok(after.checks.every(check => check.passed), JSON.stringify(after));
      assert.ok(after.checks.every(check => check.cases >= 3));
      assert.deepEqual(await materializer.sourceFiles(start), publicFiles, 'checking must not pollute the candidate tree');
    }
    const seed = task.seeds[0]!;
    const partialStages = task.kind === 'coupled' ? task.packages.length - 1 : task.packages.length;
    for (let index = 0; index < partialStages; index++) {
      const partial = join(directory, `partial-${index}`);
      await materializer.materialize(taskRoot, partial, seed, task.kind === 'coupled' ? index + 1 : 0);
      if (task.kind === 'decomposable') await materializer.applyTree(join(taskRoot, task.packages[index]!.reference), partial, seed);
      const report = await checker.verify(taskRoot, partial, seed);
      assert.deepEqual(report.checks.slice(0, task.packages.length).map(check => check.passed), task.packages.map((_, slot) => task.kind === 'coupled' ? slot <= index : slot === index));
      assert.equal(report.checks.at(-1)!.passed, false, 'partial solutions must not pass the integration checker');
    }
    const paths: Set<string>[] = [];
    const previous = new Map<string, string>();
    for (const file of await materializer.sourceFiles(join(taskRoot, task.start))) previous.set(file, await readFile(join(taskRoot, task.start, file), 'utf8'));
    for (const item of task.packages) {
      const changed = new Set<string>();
      for (const file of await materializer.sourceFiles(join(taskRoot, item.reference))) {
        const text = await readFile(join(taskRoot, item.reference, file), 'utf8');
        if (text !== previous.get(file)) changed.add(file);
        previous.set(file, text);
      }
      assert.ok(changed.size > 0, 'every package must change real source content');
      assert.ok([...changed].every(file => item.owns.includes(file)), 'reference changes must stay inside package ownership');
      paths.push(changed);
    }
    for (let left = 0; left < paths.length; left++) for (let right = left + 1; right < paths.length; right++) {
      const overlap = [...paths[left]!].some(file => paths[right]!.has(file));
      assert.equal(overlap, task.kind === 'coupled', 'coupled reference diffs must overlap; decomposable diffs must be disjoint');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('seed materialization is deterministic and rejects invalid seeds before creating a tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-seed-proof-'));
  try {
    const task = tasks[0]!, seed = task.seeds[0]!, taskRoot = fileURLToPath(new URL(`${task.id}/`, root));
    const left = join(directory, 'left'), right = join(directory, 'right');
    await materializer.materialize(taskRoot, left, seed);
    await materializer.materialize(taskRoot, right, seed);
    const files = await materializer.sourceFiles(left);
    assert.deepEqual(await materializer.sourceFiles(right), files);
    for (const file of files) assert.equal(await readFile(join(left, file), 'utf8'), await readFile(join(right, file), 'utf8'));
    await assert.rejects(materializer.materialize(taskRoot, join(directory, 'invalid'), NaN), /uint32/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a checker compilation failure is nonzero and never prints arbitrary candidate diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-checker-canary-'));
  try {
    const task = tasks.find(task => task.language === 'rust')!, seed = task.seeds[0]!;
    const taskRoot = fileURLToPath(new URL(`${task.id}/`, root)), candidate = join(directory, 'candidate');
    await materializer.materialize(taskRoot, candidate, seed, task.packages.length);
    const entry = (await materializer.sourceFiles(candidate)).find(file => file.startsWith('src/'))!;
    const canary = 'TM2_PRIVATE_CHECKER_DIAGNOSTIC_CANARY';
    await writeFile(join(candidate, entry), `this is deliberately invalid Rust ${canary}\n`);
    await assert.rejects(promisify(execFile)(process.execPath, [join(taskRoot, 'check.mjs'), '--candidate', candidate, '--seed', String(seed), '--scope', 'all'], { encoding: 'utf8', timeout: 30000 }), (error: unknown) => {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1);
      assert.ok(!`${failure.stdout ?? ''}${failure.stderr ?? ''}`.includes(canary));
      const report = JSON.parse(failure.stdout!);
      assert.equal(report.passed, false);
      assert.equal(report.checks.filter((check: { passed: boolean }) => !check.passed).length, 2);
      assert.ok(report.checks.filter((check: { passed: boolean }) => !check.passed).every((check: { reason: string }) => check.reason === 'candidate-error'));
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent compiled packages are graded even when a sibling does not compile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-isolation-'));
  try {
    for (const language of ['rust', 'go']) {
    const task = tasks.find(task => task.language === language && task.kind === 'decomposable')!, seed = task.seeds[0]!;
    const taskRoot = fileURLToPath(new URL(`${task.id}/`, root)), candidate = join(directory, language);
    await materializer.materialize(taskRoot, candidate, seed, task.packages.length);
    const files = (await materializer.sourceFiles(candidate)).filter(file => file.startsWith('src/'));
    const broken = files.find(file => file.includes(task.packages[1]!.id))!;
    await writeFile(join(candidate, broken), 'deliberately invalid source\n');
    const report = await checker.verify(taskRoot, candidate, seed);
    assert.deepEqual(report.checks.map(check => check.passed), [true, false, true, false]);
    await unlink(join(candidate, broken));
    const missing = await checker.verify(taskRoot, candidate, seed);
    assert.deepEqual(missing.checks.map(check => check.passed), [true, false, true, false]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('empty oracle scopes and undeclared seeds fail before candidate execution', async () => {
  assert.throws(() => checker.validateCases({ group: [] }, ['group']), /nonempty/);
  assert.throws(() => checker.validateCases({}, ['missing']), /nonempty/);
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-seed-refusal-'));
  try {
    const task = tasks[0]!, taskRoot = fileURLToPath(new URL(`${task.id}/`, root));
    await assert.rejects(checker.verify(taskRoot, directory, 0), /not declared/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a missing compiler is an explicit infrastructure failure, never a successful grade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-toolchain-refusal-'));
  const previous = process.env.PATH;
  try {
    const task = tasks.find(task => task.language === 'rust')!, seed = task.seeds[0]!;
    const taskRoot = fileURLToPath(new URL(`${task.id}/`, root)), candidate = join(directory, 'candidate');
    await materializer.materialize(taskRoot, candidate, seed, task.packages.length);
    process.env.PATH = '';
    await assert.rejects(checker.verify(taskRoot, candidate, seed), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'TOOLCHAIN_UNAVAILABLE');
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Rust checker builds ignore toolchain overrides in the candidate working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-rust-toolchain-'));
  const previous = process.cwd();
  try {
    const task = tasks.find(task => task.language === 'rust')!, seed = task.seeds[0]!;
    const taskRoot = fileURLToPath(new URL(`${task.id}/`, root)), candidate = join(directory, 'candidate');
    await materializer.materialize(taskRoot, candidate, seed, task.packages.length);
    await writeFile(join(candidate, 'rust-toolchain.toml'), '[toolchain]\nchannel = "tm2-nonexistent-custom-toolchain"\n');
    process.chdir(candidate);
    const report = await checker.verify(taskRoot, candidate, seed);
    assert.ok(report.checks.every(check => check.passed), JSON.stringify(report));
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate probes do not inherit an ambient credential variable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-environment-'));
  const previous = process.env.PLUR1BUS_TEAM_ENV_CANARY;
  try {
    const task = tasks.find(task => task.language === 'typescript')!, seed = task.seeds[0]!;
    const taskRoot = fileURLToPath(new URL(`${task.id}/`, root)), candidate = join(directory, 'candidate');
    await materializer.materialize(taskRoot, candidate, seed, task.packages.length);
    const entry = (await materializer.sourceFiles(candidate)).find(file => file.includes(`/${task.packages[0]!.id}.`))!;
    await writeFile(join(candidate, entry), "export function solve(_raw: string): string { return process.env.PLUR1BUS_TEAM_ENV_CANARY ?? 'absent'; }\n");
    process.env.PLUR1BUS_TEAM_ENV_CANARY = 'fixture-only-canary';
    const probe = await checker.createProbe(task, candidate, seed, task.packages[0]!.id);
    try { assert.equal(await probe.invoke(task.packages[0]!.id, ''), 'absent'); }
    finally { await probe.close(); }
  } finally {
    if (previous === undefined) delete process.env.PLUR1BUS_TEAM_ENV_CANARY; else process.env.PLUR1BUS_TEAM_ENV_CANARY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Go grading ignores candidate module and toolchain directives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p1b-team-go-module-'));
  try {
    const task = tasks.find(task => task.language === 'go')!, seed = task.seeds[0]!;
    const taskRoot = fileURLToPath(new URL(`${task.id}/`, root)), candidate = join(directory, 'candidate');
    await materializer.materialize(taskRoot, candidate, seed, task.packages.length);
    await writeFile(join(candidate, 'go.mod'), 'this is not a valid module\n');
    const report = await checker.verify(taskRoot, candidate, seed);
    assert.ok(report.checks.every(check => check.passed), JSON.stringify(report));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
