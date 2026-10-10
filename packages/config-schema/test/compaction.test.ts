import { it } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate, restartClassOf } from '../src/index.ts';
it('M2 compaction defaults, closed keys and bounded pruning settings', () => {
  const c = defaults();
  assert.deepEqual(c.session.compaction, { softRatio: .65, hardRatio: .88, summaryMaxTokens: 1228, maxMessageTokens: 819, summarizer: 'llm', prune: { enabled: true, keepLastTurns: 3, decider: 'laya', maxMs: 100, batchSize: 16 } });
  assert.equal(restartClassOf('session.compaction.prune.maxMs'), 'core');
  for (const patch of [{ softRatio: .9, hardRatio: .5 }, { softRatio: 1 }, { hardRatio: 0 }, { summarizer: 'random' }, { prune: { keepLastTurns: 0 } }, { prune: { maxMs: 0 } }, { prune: { batchSize: 0 } }, { extra: true }]) {
    const input = structuredClone(c); Object.assign(input.session.compaction, patch); assert.equal(validate(input).ok, false);
  }
});
