import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, MediaError } from '../src/index.ts';
import type { ImageRequest } from '../src/index.ts';
import table from '../src/prices.json' with { type: 'json' };

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const TOGETHER = { id: 'together', model: 'stabilityai/stable-diffusion-xl-base-1.0' };
const listedPrice = table.perImage['together:stabilityai/stable-diffusion-xl-base-1.0'];

test('a listed model is priced per image and multiplied by n; an absent n counts as one image', () => {
  const one = estimateCost({ prompt: 'x' }, TOGETHER);
  assert.equal(one.usd, listedPrice);
  assert.equal(estimateCost({ prompt: 'x', n: 1 }, TOGETHER).usd, listedPrice);
  assert.equal(estimateCost({ prompt: 'x', n: 4 }, TOGETHER).usd, listedPrice * 4);
  assert.equal(estimateCost({ prompt: 'x', n: 10 }, TOGETHER).usd, listedPrice * 10); // upper bound of validateRequest
});

test('the estimate carries the table date, currency and disclaimer unchanged', () => {
  const estimate = estimateCost({ prompt: 'x' }, TOGETHER);
  assert.deepEqual(estimate, { usd: listedPrice, asOf: table.asOf, currency: 'USD', disclaimer: table.disclaimer });
});

test('local adapters are free whatever the model is, including a missing one', () => {
  for (const adapter of [{ id: 'draw-things', model: 'sd.ckpt' }, { id: 'coreml-local', model: 'any' }, { id: 'coreml-local' }, { id: 'draw-things' }]) {
    assert.equal(estimateCost({ prompt: 'x', n: 3 }, adapter).usd, 0, JSON.stringify(adapter));
  }
});

test('an unlisted or missing model has no fixed estimate: usd is null, not zero', () => {
  assert.equal(estimateCost({ prompt: 'x' }, { id: 'together', model: 'not-in-table' }).usd, null);
  assert.equal(estimateCost({ prompt: 'x' }, { id: 'together' }).usd, null);
  assert.equal(estimateCost({ prompt: 'x' }, { id: 'together', model: '' }).usd, null);
  assert.equal(estimateCost({ prompt: 'x' }, { id: 'stabilityai', model: 'stable-diffusion-xl-base-1.0' }).usd, null); // key is adapter:model
});

test('a key that only looks like a table entry is not priced (no prototype or partial matches)', () => {
  assert.equal(estimateCost({ prompt: 'x' }, { id: 'constructor', model: 'x' }).usd, null);
  assert.equal(estimateCost({ prompt: 'x' }, { id: 'together', model: 'stabilityai/stable-diffusion-xl-base-1.0 ' }).usd, null);
});

test('an invalid request is refused before any price is looked up', () => {
  const bad: ImageRequest[] = [
    { prompt: '' },
    { prompt: '   ' },
    { prompt: 'x', n: 0 },
    { prompt: 'x', n: 11 },
    { prompt: 'x', n: 1.5 },
    { prompt: 'x', format: 'gif' as 'png' },
  ];
  for (const req of bad) assert.throws(() => estimateCost(req, TOGETHER), code('unsupported_parameter'), JSON.stringify(req));
  assert.throws(() => estimateCost({ prompt: 'x'.repeat(32001) }, TOGETHER), code('too_large'));
});
