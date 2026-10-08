import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputStore, MediaError } from '../src/index.ts';
import { makePng, makeJpeg, makeWebp, jpegXmp, webpChunks, pngChunkTypes, xmpPayload, SECRET_GPS } from './adapters-fixtures.ts';

const req = { prompt: 'a lighthouse at dawn', n: 1 };
const metadata = { adapter: 'fake', model: 'sd-test', seed: 7, durationMs: 3 };
const inputs = { png: makePng(), jpeg: makeJpeg({ exif: 1 }), webp: makeWebp() } as const;
const resultOf = (format: keyof typeof inputs) => ({ files: [{ bytes: inputs[format], format }], metadata });

test('default is off for every format: stored bytes equal the provider bytes, no prompt anywhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-meta-off-')); const store = new OutputStore(root);
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const manifest = await store.put(format, req, resultOf(format)); const stored = await readFile(join(root, format, manifest.files[0]!.path));
    assert.deepEqual(stored, inputs[format]); assert.equal(stored.includes(Buffer.from(req.prompt)), false);
  }
});

test('opt-in writes prompt, model and seed into JPEG and WebP XMP and PNG iTXt, and drops provider EXIF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-meta-on-')); const store = new OutputStore(root, { embedMetadata: true });
  const jpeg = await readFile(join(root, (await store.put('jpeg', req, resultOf('jpeg'))).id, '0.jpeg'));
  const jpegRead = xmpPayload(jpegXmp(jpeg)[0]!) as { prompt: string; metadata: { model: string; seed: number } };
  assert.equal(jpegRead.prompt, req.prompt); assert.equal(jpegRead.metadata.model, 'sd-test'); assert.equal(jpegRead.metadata.seed, 7); assert.equal(jpeg.includes(SECRET_GPS), false);
  const webp = await readFile(join(root, (await store.put('webp', req, resultOf('webp'))).id, '0.webp'));
  assert.equal((xmpPayload(webpChunks(webp).get('XMP ')!.toString('utf8')) as { prompt: string }).prompt, req.prompt);
  const png = await readFile(join(root, (await store.put('png', req, resultOf('png'))).id, '0.png'));
  assert.deepEqual(pngChunkTypes(png), ['IHDR', 'IDAT', 'iTXt', 'IEND']);
});

test('precedence call > agent > global > false holds for the new formats; manifest hashes describe stored bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-meta-prec-')); const store = new OutputStore(root, { embedMetadata: true });
  const off = await store.put('call-off', { ...req, embedMetadata: false }, resultOf('jpeg'), true);
  assert.deepEqual(await readFile(join(root, 'call-off', '0.jpeg')), inputs.jpeg);
  const agentOff = await store.put('agent-off', req, resultOf('webp'), false); assert.deepEqual(await readFile(join(root, 'agent-off', '0.webp')), inputs.webp);
  const on = await store.put('call-on', { ...req, embedMetadata: true }, resultOf('jpeg'), false);
  assert.notEqual(on.files[0]!.sha256, off.files[0]!.sha256); assert.equal(agentOff.files[0]!.bytes, inputs.webp.length);
});

test('malformed or mislabeled provider output is refused when embedding is on, and nothing is published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-meta-bad-')); const store = new OutputStore(root, { embedMetadata: true });
  for (const [bytes, format] of [[Buffer.from('not an image'), 'jpeg'], [makePng(), 'webp'], [makeWebp().subarray(0, 16), 'webp']] as const) {
    await assert.rejects(store.put(`bad-${format}`, req, { files: [{ bytes, format }], metadata }), (e: unknown) => e instanceof MediaError && e.code === 'invalid_response');
  }
  assert.equal(await store.get('bad-jpeg'), null);
});
