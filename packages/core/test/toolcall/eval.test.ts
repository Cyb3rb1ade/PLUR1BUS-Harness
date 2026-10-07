import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { runEval, markdownReport, type EvalScenario } from '../../src/toolcall/eval.ts';
const scenarios = JSON.parse(readFileSync(new URL('../fixtures/tool-eval/scenarios.json', import.meta.url), 'utf8')) as EvalScenario[];
test('fixture corpus gates routing, segmentation, classes and expected calls', async () => {
  assert.ok(scenarios.length >= 60); assert.equal(new Set(scenarios.map(s => s.id)).size, scenarios.length);
  const result = await runEval(scenarios);
  if (process.env['PLUR1BUS_EVAL_REPORT']) {
    writeFileSync(`${process.env['PLUR1BUS_EVAL_REPORT']}.json`, JSON.stringify(result, null, 2));
    writeFileSync(`${process.env['PLUR1BUS_EVAL_REPORT']}.md`, markdownReport(result));
  }
  assert.deepEqual(result.scenarios.filter(s => !s.passed), []);
  assert.ok(result.metrics.scenarioPassRate >= .95); assert.ok(result.metrics.routingRecall >= .95);
  assert.ok(result.metrics.segmentationF1 >= .9); assert.ok(result.metrics.underProvisioning <= .05);
  assert.ok(result.denominators.repairs > 0); assert.match(markdownReport(result), /routingRecall/);
});
test('live mode reports skipped and never invokes a port without explicit env flag', async () => {
  let calls = 0; const result = await runEval(scenarios, { mode: 'live', env: {}, model: () => { calls++; throw Error('should not call'); } });
  assert.equal(result.status, 'skipped'); assert.equal(calls, 0);
  await assert.rejects(runEval([], { mode: 'live', env: { PLUR1BUS_LIVE_EVAL: '1' } }), /explicit model port/);
});
test('bad model and classifier predictions lower metrics instead of reading expected answers', async () => {
  const result = await runEval(scenarios, { model: () => ({ async calls() { return []; } }), classifier: () => ({ schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] }) });
  assert.equal(result.metrics.routingRecall, 0); assert.equal(result.metrics.segmentationF1, 0); assert.equal(result.metrics.underProvisioning, 1); assert.equal(result.metrics.scenarioPassRate, 0);
});
