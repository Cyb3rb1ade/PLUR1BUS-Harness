import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribution, runs } from './metrics.mjs';
test('nearest rank retains outliers and does not mutate samples', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i + 1); xs[29] = 10000;
  const d = distribution(xs, 3);
  assert.equal(d.p95, 29); assert.equal(d.max, 10000); assert.equal(d.samples, xs);
  assert.equal(d.n, 30); assert.equal(d.warmups, 3); assert.equal(d.outliersDiscarded, 0);
});
test('p95 refuses fewer than 30 runs and invalid samples', () => {
  for (const n of ['29', 'NaN', '30.5']) assert.throws(() => runs(n));
  assert.equal(runs('30'), 30);
  for (const xs of [[], [NaN], [-1], [Infinity]]) assert.throws(() => distribution(xs, 0));
});
