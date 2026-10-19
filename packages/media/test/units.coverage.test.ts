import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedUnits, deliveredUnits, MediaError } from '../src/index.ts';

// No money dimension since 2026-10-19: a generation is counted in images or video seconds, never priced.
test('requested units: n images (default 1) or durationSeconds of video (default 8)', () => {
  assert.deepEqual(requestedUnits({ prompt: 'x' }), { unit: 'image', quantity: 1 });
  assert.deepEqual(requestedUnits({ prompt: 'x', n: 4 }), { unit: 'image', quantity: 4 });
  assert.deepEqual(requestedUnits({ prompt: 'x', kind: 'video', durationSeconds: 5 }), { unit: 'videoSecond', quantity: 5 });
  assert.deepEqual(requestedUnits({ prompt: 'x', kind: 'video' }), { unit: 'videoSecond', quantity: 8 });
  assert.throws(() => requestedUnits({ prompt: 'x'.repeat(32001) }), (e: unknown) => e instanceof MediaError && e.code === 'too_large');
});

test('delivered units: stored image count, or summed video seconds', () => {
  const file = { path: '0.png', sha256: '', bytes: 1, format: 'png' };
  assert.deepEqual(deliveredUnits({ prompt: 'x', n: 3 }, { files: [file, file] }), { unit: 'image', quantity: 2 });
  assert.deepEqual(deliveredUnits({ prompt: 'x', kind: 'video', durationSeconds: 6 }, { files: [{ ...file, durationSeconds: 2 }, file] }), { unit: 'videoSecond', quantity: 8 });
});
