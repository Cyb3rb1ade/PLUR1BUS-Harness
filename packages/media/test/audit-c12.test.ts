// Module audit (agent c12): each test pins one finding. See the commit messages for the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter, CoreMLAdapter, FileJobPersistence, JobRunner, MediaError, OutputStore, adapterConfigsFromSettings, estimateCost } from '../src/index.ts';
import type { ImageAdapter, ImageResult } from '../src/index.ts';
import { privateHost, HttpTransport } from '../src/http.ts';
import { sanitizeReference, stripMetadata, verifyOutput } from '../src/adapters/_shared/images.ts';
import { fakeServer, json, b64, makePng, makeJpeg, pngChunk, riff, vp8xChunk, vp8lChunk, riffChunk } from './adapters-fixtures.ts';

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const png1 = makePng();
const result: ImageResult = { files: [{ bytes: png1, format: 'png' }], metadata: { adapter: 'fake', model: 'm', durationMs: 1, costUsd: 0 } };

// --- dimensions: a tiny file whose header claims a gigantic canvas is refused before anything decodes it ---------------
function pngWithSize(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const marker = makePng();
  // keep IDAT/IEND of the 1x1 image, swap only the header
  return Buffer.concat([marker.subarray(0, 8), pngChunk('IHDR', ihdr), marker.subarray(8 + 25)]);
}
function jpegWithSize(width: number, height: number): Buffer {
  const ok = makeJpeg({ jfif: false }); const at = ok.indexOf(Buffer.from([0xff, 0xc0]));
  const out = Buffer.from(ok); out.writeUInt16BE(height, at + 5); out.writeUInt16BE(width, at + 7); return out;
}
function webpWithSize(width: number, height: number): Buffer { return riff([vp8xChunk(width, height, 0x20), riffChunk('ICCP', Buffer.from('icc')), vp8lChunk(1, 1)]); }

test('reference images and provider outputs with absurd header dimensions are refused as too_large', () => {
  const bombs = [pngWithSize(100000, 100000), pngWithSize(2 ** 31 - 1, 1), pngWithSize(0, 5), jpegWithSize(65535, 65535), webpWithSize(16000000, 16000000)];
  for (const bytes of bombs) {
    assert.throws(() => stripMetadata(bytes), code('too_large'));
    assert.throws(() => sanitizeReference({ bytes, format: 'png' }), code('too_large'));
    assert.throws(() => verifyOutput({ bytes, format: 'png' }), code('too_large'));
  }
  // ordinary large-but-sane images and the 1x1 fixtures still pass
  for (const bytes of [png1, pngWithSize(8192, 8192), jpegWithSize(4000, 3000), webpWithSize(4096, 4096), makeJpeg()]) assert.doesNotThrow(() => verifyOutput({ bytes, format: 'png' }));
});

test('an adapter answer whose PNG header claims 100000x100000 is rejected, not handed to the store', async () => {
  const bomb = pngWithSize(100000, 100000);
  const s = await fakeServer((_c, res) => json(res, 200, { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64(bomb)}` } }] } }] }));
  try { await assert.rejects(createAdapter({ id: 'openrouter', model: 'm', baseUrl: s.url }).generate({ prompt: 'x' }), code('too_large')); } finally { await s.close(); }
});

// --- cost -------------------------------------------------------------------------------------------------------------
test('a provider-reported negative or non-finite image cost is not trusted', async () => {
  for (const raw of ['-5', '1e999']) {
    const s = await fakeServer((_c, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"choices":[{"message":{"images":[{"image_url":{"url":"data:image/png;base64,${b64(png1)}"}}]}}],"usage":{"cost":${raw}}}`); });
    try {
      const out = await createAdapter({ id: 'openrouter', model: 'm', baseUrl: s.url }).generate({ prompt: 'x' });
      assert.equal('costUsd' in out.metadata, false, `cost ${raw} must be treated as unknown`);
    } finally { await s.close(); }
  }
});

test('estimates carry no binary floating point residue', () => {
  const google = { id: 'google', model: 'veo-3.1-generate-preview' };
  assert.equal(estimateCost({ prompt: 'x', kind: 'video', durationSeconds: 3, resolution: '720p' }, google).usd, 1.2);
  assert.equal(estimateCost({ prompt: 'x', kind: 'video', durationSeconds: 7, resolution: '480p' }, { id: 'xai', model: 'grok-imagine-video' }).usd, 0.35);
});

test('prototype names never resolve to a price (regression)', () => {
  for (const model of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    for (const id of ['together', '__proto__', 'constructor']) {
      assert.equal(estimateCost({ prompt: 'x' }, { id, model }).usd, null, `${id}:${model}`);
      assert.equal(estimateCost({ prompt: 'x', kind: 'video', resolution: model }, { id, model }).usd, null, `video ${id}:${model}`);
    }
  }
});

test('invalid quantities never produce a price (regression)', () => {
  const together = { id: 'together', model: 'stabilityai/stable-diffusion-xl-base-1.0' };
  for (const n of [0, -1, 1.5, Number.NaN, Infinity, 11]) assert.throws(() => estimateCost({ prompt: 'x', n }, together), code('unsupported_parameter'), String(n));
  for (const durationSeconds of [0, -1, Number.NaN, Infinity, 601]) assert.throws(() => estimateCost({ prompt: 'x', kind: 'video', durationSeconds }, { id: 'google', model: 'veo-3.1-generate-preview' }), code('unsupported_parameter'), String(durationSeconds));
});

// --- jobs ---------------------------------------------------------------------------------------------------------------
async function setup(adapter: ImageAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'media-audit-')); const persistence = new FileJobPersistence(join(root, 'jobs')); const store = new OutputStore(join(root, 'store'));
  return { root, persistence, store, runner: new JobRunner(persistence, store, [adapter]) };
}
const waiting: ImageAdapter = {
  id: 'fake', capabilities: () => ({ generate: true, edit: true, inpaint: false }),
  generate: (_r, c) => new Promise((_resolve, reject) => { c!.signal!.addEventListener('abort', () => reject(c!.signal!.reason), { once: true }); }), edit: async () => result,
};

test('cancel() issued while run() is still starting up is not lost', async () => {
  const s = await setup(waiting); const job = await s.runner.enqueue('fake', { prompt: 'x' });
  const execution = s.runner.run(job.id);
  await s.runner.cancel(job.id); // used to reject with backend_unavailable: the claim is taken but no controller is registered yet
  await execution;
  assert.equal((await s.persistence.get(job.id))!.state, 'cancelled');
});

test('a second run() of a job that is already running in this process is refused without touching its controller', async () => {
  const s = await setup(waiting); const job = await s.runner.enqueue('fake', { prompt: 'x' });
  const first = s.runner.run(job.id); await new Promise(r => setTimeout(r, 50));
  await assert.rejects(s.runner.run(job.id), code('backend_unavailable'));
  await s.runner.cancel(job.id); await first; assert.equal((await s.persistence.get(job.id))!.state, 'cancelled');
});

test('recover() carries on past a job another runner holds, and past unreadable job files', async () => {
  const ok: ImageAdapter = { ...waiting, generate: async () => result };
  const s = await setup(ok); const jobs = [await s.runner.enqueue('fake', { prompt: 'a' }), await s.runner.enqueue('fake', { prompt: 'b' }), await s.runner.enqueue('fake', { prompt: 'c' })];
  const release = await s.persistence.claim(jobs[1]!.id);
  await writeFile(join(s.root, 'jobs', 'corrupt.json'), '{not json'); await writeFile(join(s.root, 'jobs', 'dotted.name.json'), '{}');
  await s.runner.recover(); // used to reject with a raw SyntaxError / backend_unavailable and leave the rest unrecovered
  const states = await Promise.all(jobs.map(async j => (await s.persistence.get(j.id))!.state));
  assert.deepEqual(states.filter((_x, i) => i !== 1), ['succeeded', 'succeeded']); assert.equal(states[1], 'queued');
  await release();
});

test('a caller deadline that fires is reported as timeout, not cancelled', async () => {
  const s = await setup(waiting); const job = await s.runner.enqueue('fake', { prompt: 'x' });
  await s.runner.run(job.id, AbortSignal.timeout(30));
  assert.equal((await s.persistence.get(job.id))!.error, 'timeout');
  const again = await s.runner.enqueue('fake', { prompt: 'y' }); const caller = new AbortController(); const run = s.runner.run(again.id, caller.signal); await new Promise(r => setTimeout(r, 30)); caller.abort(); await run;
  assert.equal((await s.persistence.get(again.id))!.error, 'cancelled');
});

// --- store: no raw error text leaves put() -----------------------------------------------------------------------------
test('video put() maps a failing download or processor to a stable code and keeps remote text out of the error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-audit-store-'));
  const store = new OutputStore(join(root, 'out'), { videoProcessor: async () => { throw new Error('processor failed for https://u:tok-abc123@host/x?sig=tok-abc123'); } });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
  const request = { prompt: 'x', kind: 'video' as const };
  const stream = async function* () { yield mp4; throw new Error('fetch failed: https://host/file?X-Amz-Signature=tok-abc123'); };
  for (const [name, files] of [['stream', [{ bytes: new Uint8Array(), format: 'mp4' as const, stream: stream() }]], ['processor', [{ bytes: mp4, format: 'mp4' as const }]]] as const) {
    await assert.rejects(store.put(`v-${name}`, request, { files: [...files], metadata: { adapter: 'f', model: 'm', durationMs: 1 } }), (e: unknown) => e instanceof MediaError && !String((e as Error).message + JSON.stringify(e)).includes('tok-abc123'), name);
  }
});

// --- hosts --------------------------------------------------------------------------------------------------------------
test('privateHost covers loopback and internal spellings that URL normalisation produces', () => {
  const internal = ['localhost', 'localhost.', '127.0.0.1', '[::1]', '::1', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '[::ffff:a00:1]', '169.254.169.254', '0.0.0.0', '[::]', '[fe80::1]', 'fe80::abcd', '100.64.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '[fd12::1]'];
  for (const host of internal) assert.equal(privateHost(host), true, host);
  for (const host of ['8.8.8.8', 'example.com', '172.32.0.1', '[2001:db8::1]', '[::ffff:808:808]', 'localhost.example.com', '100.128.0.1']) assert.equal(privateHost(host), false, host);
  assert.equal(privateHost(new URL('http://[::ffff:127.0.0.1]/').hostname), true);
  assert.equal(privateHost(new URL('http://0x7f.1/').hostname), true);
});

test('a credential is never configured for a link-local or mapped-loopback base URL', () => {
  for (const base of ['https://169.254.169.254', 'https://[::ffff:7f00:1]', 'https://[fe80::1]']) assert.throws(() => new HttpTransport(base, 'k'), code('unsupported_parameter'), base);
});

test('settings: a hostname that merely starts with 127. is not loopback and is skipped, not turned into a config', async () => {
  const out = await adapterConfigsFromSettings({ adapters: { drawthings: { enabled: true, model: 'm', host: '127.evil.example' } } }, async () => undefined);
  assert.deepEqual(out.configs, []); assert.deepEqual(out.skipped, [{ id: 'draw-things', reason: 'lan_not_allowed' }]);
});

// --- core ml ------------------------------------------------------------------------------------------------------------
test('a Core ML model name cannot point outside the models directory', async () => {
  for (const model of ['../../etc', 'a/b', 'a\\b', '..', '.', 'x\0y']) assert.throws(() => new CoreMLAdapter({ id: 'coreml-local', model, helperPath: '/bin/helper' }), code('unsupported_parameter'), JSON.stringify(model));
  assert.doesNotThrow(() => new CoreMLAdapter({ id: 'coreml-local', model: 'sd-split_einsum.v2', helperPath: '/bin/helper' }));
});

// --- known gaps (need changes outside what the audit may touch or conflict with an existing test) -------------------
test('KNOWN GAP: two jobs finishing at the same moment both publish (put() fails fast on a held lock instead of waiting)', { todo: 'tests/lifecycle "quota concurrency cannot overcommit" asserts exactly one of two unlimited-quota puts succeeds; the lock needs an in-process queue plus bounded retry, which contradicts that test' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-audit-lock-')); const store = new OutputStore(root);
  const outcomes = await Promise.allSettled([store.put('a', { prompt: 'x' }, result), store.put('b', { prompt: 'x' }, result)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 2);
});

test('KNOWN GAP: put() stores bytes that are not the declared image format when metadata embedding is off', { todo: 'store.coverage tests publish fake "png-bytes-for-store-tests" payloads; magic-byte verification in put() would break them' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-audit-magic-')); const store = new OutputStore(root);
  await assert.rejects(store.put('fake', { prompt: 'x' }, { ...result, files: [{ bytes: Buffer.from('<html>not a png</html>'), format: 'png' }] }), code('invalid_response'));
  assert.equal((await readFile(join(root, 'fake', '0.png'), 'utf8').catch(() => '')), '');
});
