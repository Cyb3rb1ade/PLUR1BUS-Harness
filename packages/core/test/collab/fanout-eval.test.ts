import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFanoutEval, FANOUT_CASES } from '../../src/collab/fanout-eval.ts';
import { useTempDirs } from '../composition/helpers.ts';
const tmp = useTempDirs('m5-eval-');
test('24 reproducible single/peer cases use identical hard token budget including routed peer calls', async () => {
  const rows = await runFanoutEval(tmp.make());
  assert.equal(rows.length, 48); assert.equal(FANOUT_CASES.length, 24);
  for (const c of FANOUT_CASES) {
    const pair = rows.filter(r => r.id === c.id);
    assert.equal(pair[0]!.tokenBudget, pair[1]!.tokenBudget);
    assert.ok(pair.every(r => r.correct && r.settledTokens <= r.tokenBudget));
    assert.equal(pair[0]!.modelCalls, 1); assert.equal(pair[1]!.modelCalls, 3);
    assert.equal(pair[0]!.settledTokens, 24); assert.equal(pair[1]!.settledTokens, 72);
  }
});
