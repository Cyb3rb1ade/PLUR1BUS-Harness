import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdapter, DEFAULT_MODELS } from '../src/index.ts';
import type { AdapterConfig } from '../src/index.ts';
import { ADAPTER_PROFILES } from '../src/adapters/capabilities.ts';

// docs/media-adapters.md carries the adapter x capability table. It must say what the code does.
const doc = readFileSync(fileURLToPath(new URL('../../../docs/media-adapters.md', import.meta.url)), 'utf8');
const rows = new Map<string, string[]>();
for (const line of doc.split('\n')) {
  const cells = line.split('|').slice(1, -1).map(c => c.trim());
  const id = /^`([a-z-]+)`$/.exec(cells[0] ?? '')?.[1];
  if (id && cells.length === 10) rows.set(id, cells);
}
const configs: AdapterConfig[] = [
  { id: 'openai', model: 'm' }, { id: 'google', model: 'm' }, { id: 'xai', model: 'm' }, { id: 'openrouter', model: 'm' }, { id: 'replicate', model: 'a/b' },
  { id: 'fal', model: 'a/b' }, { id: 'together', model: 'a/b' }, { id: 'draw-things', model: 'm' }, { id: 'coreml-local', model: 'm', helperPath: process.execPath },
];
const yes = (cell: string) => cell.startsWith('yes');

test('the adapter table lists every adapter exactly once', () => {
  assert.deepEqual([...rows.keys()].sort(), configs.map(c => c.id).sort());
});

test('documented capabilities, location, async and defaults match the code', () => {
  for (const config of configs) {
    const [, where, generate, edit, mask, async, , maxImages, , model] = rows.get(config.id)!;
    const caps = createAdapter(config).capabilities(); const profile = ADAPTER_PROFILES[config.id]!;
    assert.equal(yes(generate!), caps.generate, `${config.id}: generate`); assert.equal(yes(edit!), caps.edit, `${config.id}: edit`); assert.equal(yes(mask!), caps.inpaint, `${config.id}: mask`);
    assert.equal(yes(async!), profile.async, `${config.id}: async`); assert.equal(where, profile.location, `${config.id}: where`);
    assert.equal(Number.parseInt(maxImages!, 10), profile.maxImages, `${config.id}: max images`);
    const expected = (DEFAULT_MODELS as Record<string, string>)[config.id]; assert.equal(model, expected ? `\`${expected}\`` : 'none, set `model`', `${config.id}: default model`);
  }
});

test('the documented error codes and the retry rule are the implemented ones', () => {
  for (const code of ['content_policy', 'quota', 'too_large', 'unsupported_parameter', 'backend_unavailable', 'timeout', 'cancelled', 'invalid_response', 'interrupted']) assert.ok(doc.includes(`\`${code}\``), code);
  assert.match(doc, /not\s+for a submission/); assert.match(doc, /auth_invalid/); assert.match(doc, /auth_forbidden/);
});
