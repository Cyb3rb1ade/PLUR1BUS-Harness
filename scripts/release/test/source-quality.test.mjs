import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTheme } from '../check-source-quality.mjs';
test('retired theme bridge is caught in definitions and references; independent Glow names remain valid', () => {
  assert.deepEqual(checkTheme(':root { --oc-accent: red; } a { color:var(--oc-text); }'), ['--oc-accent', '--oc-text']);
  assert.deepEqual(checkTheme(':root { --glow-ink: #16161A; --accent: #E5484D; }'), []);
});
