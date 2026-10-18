import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardware, render } from './reference-hardware.mjs';
import { budgets } from './budgets.mjs';
test('hardware output has a strict privacy allowlist and no machine identifiers', () => {
  assert.deepEqual(Object.keys(hardware()).sort(), ['systemModel','cpuModel','logicalCores','ramBytes','os','osVersion','osProductVersion','architecture','storageType','storageNote'].sort());
});
test('every ADR budget appears, including an explicit incomplete B10', () => {
  assert.deepEqual(budgets.map(b => b.id), Array.from({ length: 11 }, (_, i) => `B${i + 1}`));
  const text = render({ hardware: {}, status: { B10: 'partial' }, gaps: ['LRU soak missing'] });
  assert.match(text, /B10.*partial/); assert.match(text, /LRU soak missing/);
  assert.match(text, /B1.*gate/); assert.match(text, /B9.*gate/);
});

test('shared Markdown report carries the VM host and bare-metal comparison caveat', async () => {
  const { deviceContext } = await import('./device-context.mjs');
  const text = render({ hardware: { logicalCores: 4, ramBytes: 8 * 1024 ** 3 }, node: 'test-runtime', timing: { elapsedMs: 123 }, device: deviceContext('nas-windows-x64', { os: 'win32', architecture: 'x64' }), status: {}, gaps: [] });
  assert.match(text, /NAS/); assert.match(text, /vCPUs/);
  assert.match(text, /do not equate.*bare-metal/); assert.match(text, /duration: 123 ms/);
});
