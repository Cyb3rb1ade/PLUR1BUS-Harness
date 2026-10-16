import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardware, render } from './reference-hardware.mjs';
import { budgets } from './budgets.mjs';
test('hardware output has a strict privacy allowlist and no machine identifiers', () => {
  assert.deepEqual(Object.keys(hardware()).sort(), ['cpuModel','logicalCores','ramBytes','os','osVersion','architecture','storageType','storageNote'].sort());
});
test('every ADR budget appears, including an explicit incomplete B10', () => {
  assert.deepEqual(budgets.map(b => b.id), Array.from({ length: 11 }, (_, i) => `B${i + 1}`));
  const text = render({ hardware: {}, status: { B10: 'partial' }, gaps: ['LRU soak missing'] });
  assert.match(text, /B10.*partial/); assert.match(text, /LRU soak missing/);
  assert.match(text, /B1.*gate/); assert.match(text, /B9.*gate/);
});
