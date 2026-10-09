import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreMLAdapter, MediaError } from '../src/index.ts';

// Talks to the real Swift helper. Needs `swift build` in tools/coreml-sd-helper (or PLUR1BUS_COREML_BINARY) on macOS arm64; skipped otherwise.
const built = fileURLToPath(new URL('../../../tools/coreml-sd-helper/.build/debug/media-coreml', import.meta.url));
const binary = process.env.PLUR1BUS_COREML_BINARY ?? built;
const skip = process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(binary) ? 'needs macOS arm64 and a built media-coreml' : false;

test('the real helper is detected as jsonl/1 and lists models from a models directory', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-native-'));
  for (const part of ['TextEncoder', 'Unet', 'VAEDecoder']) await mkdir(join(dir, 'sd-split', `${part}.mlmodelc`), { recursive: true });
  const a = new CoreMLAdapter({ id: 'coreml-local', model: 'sd-split', helperPath: binary, modelDir: dir, timeoutMs: 20000 });
  try { assert.deepEqual(await a.listModels(), ['sd-split']); } finally { await a.close(); }
});

test('the real helper refuses an unknown model with a stable code and survives for the next request', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-native-'));
  const a = new CoreMLAdapter({ id: 'coreml-local', model: 'missing', helperPath: binary, modelDir: dir, timeoutMs: 20000 });
  try {
    await assert.rejects(a.generate({ prompt: 'a tree' }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
    assert.deepEqual(await a.listModels(), []);
    await assert.rejects(a.generate({ prompt: 'x', seed: 2 ** 32 - 1 }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
  } finally { await a.close(); }
});
