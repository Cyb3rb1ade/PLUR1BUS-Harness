import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaError } from '../src/index.ts';
import { embedPng } from '../src/png.ts';
import { embedImage } from '../src/adapters/_shared/metadata.ts';
import { makePng, makeJpeg, makeWebp, jpegXmp, jpegSegments, webpChunks, pngChunkTypes, xmpPayload, SECRET_GPS, vp8lChunk, riff } from './adapters-fixtures.ts';

const payload = { prompt: 'a <red> fox & "friend" 🦊 – naïve', parameters: { seed: 42, n: 1 }, metadata: { adapter: 'fake', model: 'm-1', seed: 42, durationMs: 4 } };

test('JPEG: prompt, model and seed round-trip through one XMP packet; an earlier XMP packet is replaced, the rest stays as delivered', () => {
  const original = makeJpeg({ exif: 6, xmp: '<x:xmpmeta>old-location</x:xmpmeta>', icc: true });
  const out = embedImage(original, 'jpeg', payload); const packets = jpegXmp(out);
  assert.equal(packets.length, 1); assert.match(packets[0]!, /^<\?xpacket begin=/); assert.match(packets[0]!, /<\?xpacket end="w"\?>$/);
  const read = xmpPayload(packets[0]!) as { prompt: string; metadata: { model: string; seed: number } };
  assert.equal(read.prompt, payload.prompt); assert.equal(read.metadata.model, 'm-1'); assert.equal(read.metadata.seed, 42);
  assert.equal(Buffer.from(out).includes('old-location'), false);
  assert.equal(Buffer.from(out).includes(SECRET_GPS), true); // provider EXIF is not ours to rewrite, as with PNG
  assert.deepEqual(jpegSegments(out).map(s => s.marker), [0xe0, 0xe1, 0xe1, 0xe2, 0xdb, 0xc0, 0xda]); // JFIF, XMP, orientation-only EXIF, ICC, tables, frame, scan
  assert.deepEqual(out.subarray(out.length - 7), original.subarray(original.length - 7));
});

test('JPEG: an oversized prompt is truncated to fit one APP1 segment and says so', () => {
  const out = embedImage(makeJpeg(), 'jpeg', { ...payload, prompt: '日'.repeat(32000) });
  const segment = jpegSegments(out).find(s => s.marker === 0xe1)!; assert.ok(segment.payload.length <= 65533);
  const read = xmpPayload(jpegXmp(out)[0]!) as { prompt: string; truncated?: boolean };
  assert.equal(read.truncated, true); assert.ok(read.prompt.length > 1000 && read.prompt.length < 32000); assert.ok(/^日+$/.test(read.prompt));
});

test('WebP: a simple lossless file gains VP8X (canvas, alpha hint) and an XMP chunk', () => {
  for (const [source, alpha, width] of [[makeWebp(), false, 1], [riff([vp8lChunk(3, 2, true)]), true, 3]] as const) {
    const out = embedImage(source, 'webp', payload); const chunks = webpChunks(out);
    assert.deepEqual([...chunks.keys()], ['VP8X', 'VP8L', 'XMP ']);
    const x = chunks.get('VP8X')!; assert.equal(x[0]! & 0x04, 0x04); assert.equal((x[0]! & 0x10) === 0x10, alpha);
    assert.equal(x.readUIntLE(4, 3) + 1, width); assert.equal(Buffer.from(out).readUInt32LE(4), out.length - 8);
    assert.equal((xmpPayload(chunks.get('XMP ')!.toString('utf8')) as { prompt: string }).prompt, payload.prompt);
  }
});

test('WebP: lossy canvas size is read from the VP8 frame header; extended files get their XMP replaced and keep the rest', () => {
  const lossy = embedImage(makeWebp({ lossy: true }), 'webp', payload); assert.equal(webpChunks(lossy).get('VP8X')!.readUIntLE(4, 3), 0);
  const extended = embedImage(makeWebp({ exif: true, xmp: '<x:xmpmeta>old-where</x:xmpmeta>' }), 'webp', payload);
  const chunks = webpChunks(extended); assert.equal(chunks.has('EXIF'), true); assert.equal(Buffer.from(extended).includes('old-where'), false);
  assert.equal(chunks.get('VP8X')![0]! & 0x0c, 0x0c); assert.equal(chunks.get('VP8X')![0]! & 0x20, 0x20);
  assert.equal(Buffer.from(extended).readUInt32LE(4), extended.length - 8);
});

test('PNG keeps the existing iTXt behaviour and does not alter pixels', () => {
  const png = makePng(); const out = embedImage(png, 'png', payload);
  assert.deepEqual(out, embedPng(png, payload)); assert.deepEqual(pngChunkTypes(out), ['IHDR', 'IDAT', 'iTXt', 'IEND']);
  assert.ok(Buffer.from(out).includes(Buffer.from('plur1bus\0')));
});

test('malformed provider output is an invalid response, and unknown formats are refused', () => {
  for (const [bytes, format] of [[Buffer.from('nope'), 'jpeg'], [Buffer.from('nope'), 'webp'], [makeJpeg().subarray(0, 25), 'jpeg'], [makeWebp().subarray(0, 14), 'webp'], [riff([Buffer.from('JUNK\0\0\0\0')]), 'webp']] as const) {
    assert.throws(() => embedImage(bytes, format, payload), (e: unknown) => e instanceof MediaError && e.code === 'invalid_response');
  }
  assert.throws(() => embedImage(makePng(), 'gif' as never, payload), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
});
