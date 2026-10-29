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
  for (const job of ['turn-eval-live', 'host-tool-eval-live']) {
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
