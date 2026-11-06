import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// D110 keeps direct OpenAI credentials out of every scheduled job. HYG-015 only recognises secret names that say "openai", so
// the live evaluation jobs are pinned by name here: which secrets each one may see, and in which step.
const nightly = readFileSync(new URL('../../.github/workflows/nightly.yml', import.meta.url), 'utf8');
const jobBlocks = yaml => Object.fromEntries(yaml.slice(yaml.indexOf('\njobs:\n')).split(/(?=^  [a-z][\w-]*:\s*$)/m).slice(1)
  .map(block => [/^  ([\w-]+):/.exec(block)[1], block]));
const jobs = jobBlocks(nightly);
const secretsIn = text => [...new Set([...text.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1]))].sort();
const stepsOf = block => block.slice(block.indexOf('\n    steps:\n')).split(/(?=^      - )/m).slice(1);

test('the scheduled live evaluation jobs see no secret but the two vendor keys and the engine read token', () => {
  for (const job of ['turn-eval-live', 'host-tool-eval-live', 'coding-bench-smoke', 'coding-bench-live']) {
    assert.ok(jobs[job], job);
    assert.deepEqual(secretsIn(jobs[job]), ['ANTHROPIC_API_KEY', 'GH_ENGINE_READ_TOKEN', 'GOOGLE_API_KEY'], job);
    assert.doesNotMatch(jobs[job], /^    environment:|secrets\.\w*openai/im, job);
  }
  assert.doesNotMatch(nightly, /PLUR1BUS_TURN_EVAL_API_KEY/);
});

test('the turn evaluation step resolves credentials from the store: only the setup step has the keys', () => {
  const steps = stepsOf(jobs['turn-eval-live']);
  const withKeys = steps.filter(step => /\$\{\{\s*secrets\.(?:ANTHROPIC|GOOGLE)_API_KEY/.test(step));
  assert.equal(withKeys.length, 1);
  assert.match(withKeys[0], /scripts\/eval\/turn-eval-secrets\.ts/);
  const evaluation = steps.find(step => /scripts\/eval\/turn-eval\.ts --live/.test(step));
  assert.ok(evaluation);
  assert.deepEqual(secretsIn(evaluation), []);
  assert.doesNotMatch(evaluation, /_API_KEY/);
  assert.match(evaluation, /PLUR1BUS_TURN_EVAL_HOME: \$\{\{ runner\.temp \}\}\/turn-eval-home/);
  assert.match(steps.at(-2), /rm -rf .*turn-eval-home/);
  assert.match(steps.at(-2), /if: always\(\)/);
});

test('the turn evaluation job stays off until the owner configures models', () => {
  assert.match(jobs['turn-eval-live'], /^    if: \$\{\{ vars\.PLUR1BUS_TURN_EVAL_MODELS != '' \}\}$/m);
});

test('coding setup alone sees vendor keys and publication waits for a canary scan', () => {
  const steps = stepsOf(jobs['coding-bench-live']);
  const withKeys = steps.filter(step => /\$\{\{\s*secrets\.(?:ANTHROPIC|GOOGLE)_API_KEY/.test(step));
  assert.equal(withKeys.length, 1);
  assert.match(withKeys[0], /coding-bench\.ts --setup/);
  const evaluation = steps.find(step => /coding-bench\.ts --live/.test(step));
  assert.ok(evaluation);
  assert.deepEqual(secretsIn(evaluation), []);
  assert.doesNotMatch(evaluation, /_API_KEY/);
  assert.match(evaluation, /> artifacts\/coding-bench\/run\.log 2>&1/);
  const scan = steps.find(step => /coding-bench\.ts --scan/.test(step));
  assert.ok(scan);
  assert.deepEqual(secretsIn(scan), []);
  assert.match(scan, /if: always\(\)/);
  assert.ok(scan.indexOf('--scan') < scan.indexOf('cat artifacts/'));
  assert.match(steps.at(-2), /rm -rf .*coding-bench-home/);
  assert.match(steps.at(-2), /if: always\(\)/);
  assert.match(steps.at(-1), /steps\.coding-canary\.outcome == 'success'/);
  assert.match(steps.at(-1), /path: artifacts\/coding-bench\/report\.json/);
  assert.doesNotMatch(steps.at(-1), /path:.*(?:home|run\.log)/);
  assert.match(jobs['coding-bench-plan'], /vars\.PLUR1BUS_CODING_BENCH_ENABLED == 'true'/);
  assert.match(jobs['coding-bench-live'], /max-parallel: 2/);
});


test('all model smoke jobs must succeed before the complete coding capture', () => {
  assert.ok(jobs['coding-bench-smoke']);
  assert.match(jobs['coding-bench-smoke'], /needs: coding-bench-plan/);
  assert.match(jobs['coding-bench-smoke'], /coding-bench\.ts --smoke --out artifacts\/coding-smoke\/report\.json/);
  assert.match(jobs['coding-bench-live'], /needs: \[coding-bench-plan, coding-bench-smoke\]/);
  assert.match(jobs['coding-bench-live'], /needs\.coding-bench-smoke\.result == 'success'/);
});


test('coding smoke keys stay in setup and only scanned reports can be uploaded', () => {
  const steps = stepsOf(jobs['coding-bench-smoke']);
  const withKeys = steps.filter(step => /\$\{\{\s*secrets\.(?:ANTHROPIC|GOOGLE)_API_KEY/.test(step));
  assert.equal(withKeys.length, 1);
  assert.match(withKeys[0], /coding-bench\.ts --setup/);
  const evaluation = steps.find(step => /coding-bench\.ts --smoke/.test(step));
  assert.ok(evaluation);
  assert.deepEqual(secretsIn(evaluation), []);
  assert.match(evaluation, /> artifacts\/coding-smoke\/run\.log 2>&1/);
  const scan = steps.find(step => /coding-bench\.ts --scan/.test(step));
  assert.ok(scan);
  assert.match(scan, /if: always\(\)/);
  assert.ok(scan.indexOf('--scan') < scan.indexOf('cat artifacts/'));
  assert.match(steps.at(-2), /if: always\(\)/);
  assert.match(steps.at(-2), /rm -rf .*coding-smoke-home/);
  assert.match(steps.at(-1), /steps\.coding-canary\.outcome == 'success'/);
  assert.match(steps.at(-1), /path: artifacts\/coding-smoke\/report\.json/);
  assert.doesNotMatch(steps.at(-1), /path:.*(?:home|run\.log)/);
});


test('extra smoke calls are limited to explicit baseline capture and a capture cannot bypass them', () => {
  assert.match(jobs['coding-bench-smoke'], /github\.event_name == 'workflow_dispatch' && inputs\.coding-baseline-capture/);
  assert.match(jobs['coding-bench-live'], /!cancelled\(\)/);
  assert.match(jobs['coding-bench-live'], /needs\.coding-bench-smoke\.result == 'skipped' &&\s*!\(github\.event_name == 'workflow_dispatch' && inputs\.coding-baseline-capture\)/);
});

test('failed coding runs scan their log before printing and never upload an absent report', () => {
  for (const [job, folder] of [['coding-bench-smoke', 'coding-smoke'], ['coding-bench-live', 'coding-bench']]) {
    const steps = stepsOf(jobs[job]);
    const scan = steps.find(step => /coding-bench\.ts --scan/.test(step));
    assert.ok(scan.includes(`if [ -f artifacts/${folder}/report.json ]; then report=(--report artifacts/${folder}/report.json); fi`));
    assert.ok(scan.includes('--scan "${report[@]}" --log'));
    assert.ok(scan.indexOf('--scan') < scan.indexOf('cat artifacts/'));
    assert.ok(steps.at(-1).includes(`hashFiles('artifacts/${folder}/report.json') != ''`));
  }
});
