import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateLearning, type LearnEvalCase } from '../../src/dreams/learn/eval.ts';
const cases = JSON.parse(readFileSync(new URL('../../../../tests/eval/learn/cases.json', import.meta.url), 'utf8')) as LearnEvalCase[];
test('LQ3 all 24 MIT synthetic labels traverse the whole learning pipeline without a live model', async () => {
  assert.equal(cases.length, 24);
  const report = await evaluateLearning(cases);
  assert.deepEqual(report.results.filter(r => !r.passed).map(r => r.id), []);
  assert.equal(report.extractionPrecision, 1); assert.equal(report.extractionRecall, 1); assert.equal(report.skepticAgreement, 1);
  assert.equal(JSON.stringify(report).includes('LEARN_EVAL_PRIVATE_MARKER'), false);
  for (const c of cases) assert.equal(JSON.stringify(report).includes(c.text), false);
});

test('LQ3 live mode refuses before credentials or network without explicit opt-in; dry-run is content-free', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const script = new URL('../../../../scripts/eval/learn-eval.ts', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const args = ['--experimental-strip-types', '--conditions=source', fileURLToPath(script)];
  const env = { ...process.env }; delete env.PLUR1BUS_LEARN_EVAL_LIVE; delete env.PLUR1BUS_LEARN_EVAL_MODELS;
  const refused = spawnSync(process.execPath, [...args, '--live'], { env, encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /explicit consent/);
  const dry = JSON.parse(execFileSync(process.execPath, [...args, '--dry-run'], { env, encoding: 'utf8' }));
  assert.equal(dry.cases, 24); assert.equal(dry.live, false);
  const fake = JSON.parse(execFileSync(process.execPath, [...args, '--fake'], { env, encoding: 'utf8' }));
  assert.equal(fake.evidence, 'fixture'); assert.ok(fake.results.every((r: { passed: boolean }) => r.passed));
});

test('LQ3 workflow has only manual dispatch and no default model variable or scheduled trigger', () => {
  const workflow = readFileSync(new URL('../../../../.github/workflows/learn-eval.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /inputs.consent/);
  assert.doesNotMatch(workflow, /schedule:|cron:|pull_request:|push:|vars\./);
  assert.match(workflow, /PLUR1BUS_LEARN_EVAL_LIVE: "1"/);
});
