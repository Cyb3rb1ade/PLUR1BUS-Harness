import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreMLAdapter, createAdapter, MediaError } from '../src/index.ts';
import { reasonOf } from '../src/adapters/_shared/errors.ts';
import { makePng, makeLeakyPng, SECRET_GPS } from './adapters-fixtures.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-coreml.mjs');
const mac = { os: 'darwin', arch: 'arm64' };
async function adapter(mode: string, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'media-coreml-')); const log = join(root, 'log.txt');
  const a = new CoreMLAdapter({ id: 'coreml-local', model: 'sd-split', helperPath: process.execPath, helperArgs: [script, mode, log], modelDir: root, platform: mac, timeoutMs: 5000, cancelGraceMs: 50, ...extra } as never);
  const lines = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { a, root, lines, starts: async () => (await lines()).filter(l => l === 'start').length };
}
const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;

test('a --jsonl capable helper is detected, generates, edits (img2img) and lists models through one process', async () => {
  const { a, lines, starts } = await adapter('ok');
  try {
    const progress: number[] = [];
    const out = await a.generate({ prompt: 'tree', seed: 5, steps: 12, guidance: 6, negativePrompt: 'fog', n: 1 }, { onProgress: p => { progress.push(p.fraction); } });
    assert.equal(out.files[0]!.format, 'png'); assert.deepEqual(Buffer.from(out.files[0]!.bytes).subarray(0, 8), makePng().subarray(0, 8)); assert.equal(out.metadata.seed, 42); assert.equal(out.metadata.costUsd, 0); assert.equal(out.metadata.origin, 'local'); assert.deepEqual(progress, [0.5]);
    const edit = await a.edit({ prompt: 'snow', referenceImages: [{ bytes: makeLeakyPng(), format: 'png' }] });
    assert.equal(edit.files.length, 1); assert.deepEqual(await a.listModels(), ['sd-split', 'sd-original']);
    assert.equal(await starts(), 1);
    const requests = (await lines()).filter(l => l.startsWith('request ')).map(l => JSON.parse(l.slice(8)) as Record<string, unknown>);
    assert.equal(requests[0]!.op, 'generate'); assert.equal(requests[1]!.op, 'img2img'); assert.equal(requests[2]!.op, 'list-models');
    const first = requests[0]!.request as Record<string, unknown>; assert.deepEqual([first.prompt, first.seed, first.steps, first.guidance, first.negativePrompt], ['tree', 5, 12, 6, 'fog']);
    assert.equal(requests[0]!.model, 'sd-split'); assert.match(String(requests[0]!.outputDir), /plur1bus-media-/);
    assert.match(String(requests[1]!.inputPath), /input\.png$/);
  } finally { await a.close(); }
});

test('compute units, scheduler, strength and the models directory reach the helper', async () => {
  const { a, lines, root } = await adapter('ok', { computeUnits: 'cpuAndGPU', scheduler: 'dpmpp', strength: 0.5 });
  try {
    await a.edit({ prompt: 'x', referenceImages: [{ bytes: makePng(), format: 'png' }] });
    const req = JSON.parse((await lines()).find(l => l.startsWith('request '))!.slice(8)) as Record<string, unknown>;
    assert.equal(req.computeUnits, 'cpuAndGPU'); assert.equal(req.modelsDir, root); assert.deepEqual([(req.request as Record<string, unknown>).scheduler, (req.request as Record<string, unknown>).strength], ['dpmpp', 0.5]);
  } finally { await a.close(); }
  for (const bad of [{ computeUnits: 'gpu' }, { strength: 2 }, { scheduler: '' }, { protocol: 'xml' }, { cancelGraceMs: -1 }]) assert.throws(() => new CoreMLAdapter({ id: 'coreml-local', model: 'sd', helperPath: process.execPath, ...bad } as never), MediaError);
});

test('a helper without --jsonl keeps working through the one-shot protocol, but cannot edit or cancel mid-run', async () => {
  const { a, lines } = await adapter('legacy');
  try {
    assert.deepEqual(await a.listModels(), ['legacy-sd']);
    assert.equal((await a.generate({ prompt: 'tree' })).files.length, 1);
    await assert.rejects(a.edit({ prompt: 'x', referenceImages: [{ bytes: makePng(), format: 'png' }] }), code('unsupported_parameter'));
    assert.ok((await lines()).every(l => l.startsWith('oneshot ')));
  } finally { await a.close(); }
});

test('an explicit protocol setting skips the probe', async () => {
  const forced = await adapter('legacy', { protocol: 'oneshot' }); assert.deepEqual(forced.a.capabilities(), { generate: true, edit: false, inpaint: false });
  assert.deepEqual((await adapter('ok')).a.capabilities(), { generate: true, edit: true, inpaint: false });
});

test('cancel is honoured mid-run and the process survives', async () => {
  const { a, starts } = await adapter('hold');
  try {
    const c = new AbortController();
    await assert.rejects(a.generate({ prompt: 'tree' }, { signal: c.signal, onProgress: () => { c.abort(); } }), code('cancelled'));
    await assert.rejects(a.generate({ prompt: 'tree' }, { signal: AbortSignal.abort() }), code('cancelled'));
    assert.equal(await starts(), 1);
  } finally { await a.close(); }
});

test('a helper that ignores cancel is killed after the grace period, and the next request restarts it', async () => {
  const { a, starts } = await adapter('deaf');
  try {
    const c = new AbortController();
    await assert.rejects(a.generate({ prompt: 'tree' }, { signal: c.signal, onProgress: () => { c.abort(); } }), code('cancelled'));
    const d = new AbortController();
    await assert.rejects(a.generate({ prompt: 'tree' }, { signal: d.signal, onProgress: () => { d.abort(); } }), code('cancelled'));
    assert.equal(await starts(), 2);
  } finally { await a.close(); }
});

test('a request that exceeds its timeout is a timeout, not a cancellation', async () => {
  const { a } = await adapter('hold', { timeoutMs: 100 });
  try { await assert.rejects(a.generate({ prompt: 'tree' }), code('timeout')); } finally { await a.close(); }
});

test('a crash mid-request fails that request only; the supervisor restarts the helper for the next one', async () => {
  const { a, starts } = await adapter('crash');
  try {
    await assert.rejects(a.generate({ prompt: 'tree' }), code('backend_unavailable'));
    assert.equal((await a.generate({ prompt: 'tree' })).files.length, 1); assert.equal(await starts(), 2);
  } finally { await a.close(); }
});

test('helper failures map to stable codes and never leak helper text', async () => {
  for (const [mode, expected] of [['policy', 'content_policy'], ['bad-code', 'unsupported_parameter'], ['garbage', 'invalid_response'], ['traversal', 'invalid_response'], ...(process.platform === 'win32' ? [] : [['symlink', 'too_large'] as const])] as const) { // creating a symlink needs a privilege on Windows
    const { a } = await adapter(mode);
    try { await assert.rejects(a.generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === expected && !String(e).includes('secret-123') && !String(e).includes('/etc/hosts')); } finally { await a.close(); }
  }
});

test('input is validated before the helper is started; references lose EXIF/GPS first', async () => {
  const { a, lines } = await adapter('ok');
  try {
    for (const req of [{ prompt: 'x', size: { width: 512, height: 512 } }, { prompt: 'x', aspect: '1:1' }, { prompt: 'x', format: 'jpeg' as const }, { prompt: 'x', seed: -1 }, { prompt: 'x', referenceImages: [{ bytes: makePng(), format: 'png' as const }] }]) await assert.rejects(a.generate(req), code('unsupported_parameter'));
    for (const req of [{ prompt: 'x' }, { prompt: 'x', referenceImages: [{ bytes: makePng(), format: 'png' as const }, { bytes: makePng(), format: 'png' as const }] }, { prompt: 'x', referenceImages: [{ bytes: makePng(), format: 'png' as const }], mask: { bytes: makePng(), format: 'png' as const } }, { prompt: 'x', referenceImages: [{ bytes: Buffer.from('nope'), format: 'png' as const }] }]) await assert.rejects(a.edit(req), code('unsupported_parameter'));
    assert.deepEqual(await lines(), []);
    await a.edit({ prompt: 'x', referenceImages: [{ bytes: makeLeakyPng(), format: 'png' }] });
    assert.equal((await lines()).join('\n').includes(SECRET_GPS), false);
  } finally { await a.close(); }
});

test('off macOS arm64 the adapter reports unavailable with a stable reason and never spawns', async () => {
  for (const platform of [{ os: 'linux', arch: 'x64' }, { os: 'darwin', arch: 'x64' }, { os: 'win32', arch: 'arm64' }]) {
    const { a, lines } = await adapter('ok', { platform });
    assert.deepEqual(a.availability(), { available: false, reason: 'coreml_unavailable_platform' });
    for (const call of [() => a.generate({ prompt: 'x' }), () => a.edit({ prompt: 'x', referenceImages: [{ bytes: makePng(), format: 'png' }] }), () => a.listModels()]) {
      await assert.rejects(call(), (e: unknown) => e instanceof MediaError && e.code === 'backend_unavailable' && reasonOf(e) === 'coreml_unavailable_platform');
    }
    assert.deepEqual(await lines(), []);
  }
  assert.deepEqual((await adapter('ok')).a.availability(), { available: true });
  assert.ok(createAdapter({ id: 'coreml-local', model: 'sd', helperPath: process.execPath }) instanceof CoreMLAdapter); // construction never depends on the platform
});
