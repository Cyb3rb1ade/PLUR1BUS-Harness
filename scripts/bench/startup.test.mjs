import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startup, markdown } from './startup.mjs';
test('missing executable produces a failed machine report', async () => {
  const r = await startup({ bin: '/missing/plur1bus-perf-test' });
  assert.equal(r.errors.length, 1);
  assert.equal(r.results.length, 0);
  assert.match(markdown(r), /ERROR:/);
});
