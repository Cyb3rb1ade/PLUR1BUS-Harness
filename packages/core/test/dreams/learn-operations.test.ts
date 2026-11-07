import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { createMetrics, MAX_TOTAL_SERIES } from '../../src/metrics/metrics.ts';
test('LQ4 learning health exposes only schema, integrity, breaker and backlog counts', () => {
  const store = new LearnStore(':memory:'), target = { scope: 'agent' as const, owner: 'PRIVATE OWNER', agentId: 'PRIVATE AGENT' };
  try {
    assert.deepEqual(store.health(10), { schema: 7, integrity: true, pending: 0, waitingH3: 0, breakers: 0 });
    const run = store.begin(target, { from: 0, to: 1 }, 1);
    for (let i = 0; i < 3; i++) store.finish(run, 'failed', 'provider-failed', 2);
    assert.equal(store.health(10).breakers, 1); assert.doesNotMatch(JSON.stringify(store.health(10)), /PRIVATE/);
  } finally { store.close(); }
});
test('LQ4 learning metric labels fold arbitrary strings and measured tokens are separate from IDs', () => {
  const metrics = createMetrics({ connections: () => 0 });
  for (let i = 0; i < 1000; i++) metrics.learnRun({ outcome: `PRIVATE-${i}`, reason: `PRIVATE-${i}` }, [{ desiredTier: `PRIVATE-${i}`, status: `PRIVATE-${i}` }], 10);
  metrics.learnRun({ outcome: 'completed', reason: null }, [{ desiredTier: 'A', status: 'pending' }], 20);
  metrics.learnFinding('A', 'accepted');
  const rendered = metrics.render(); assert.doesNotMatch(rendered, /PRIVATE/); assert.match(rendered, /plur1bus_learn_tokens_total 10020/);
  assert.ok(rendered.split('\n').filter(line => line && !line.startsWith('#')).length <= MAX_TOTAL_SERIES);
});
