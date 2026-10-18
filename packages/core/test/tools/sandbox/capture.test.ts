import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCapture } from '../../../src/tools/sandbox/capture.ts';
test('a sustained output flood retains only capped bytes, including partial input allocations', () => {
  const c = new BoundedCapture(512);
  const large = new Uint8Array(64 * 1024).fill(97);
  for (let i = 0; i < 10000; i++) c.push(large);
  assert.equal(c.retainedBytes, 512);
  assert.equal(c.text(), 'a'.repeat(512)); assert.equal(c.truncated, true);
});
