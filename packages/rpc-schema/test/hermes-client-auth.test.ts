import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParams } from '../src/index.ts';
test('core.auth additively accepts personal client tokens and preserves 64-char owner tokens', () => {
  for (const token of ['0'.repeat(64), 'plb_123456789abc_' + 'x'.repeat(43)]) assert.deepEqual(validateParams('core.auth', { token }), { ok: true });
  for (const token of ['x'.repeat(59), 'x'.repeat(65)]) assert.equal(validateParams('core.auth', { token }).ok, false);
});
