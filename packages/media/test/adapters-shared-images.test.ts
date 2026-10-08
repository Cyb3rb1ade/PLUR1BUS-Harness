import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaError } from '../src/index.ts';
import { sniffFormat, stripMetadata, sanitizeRequest } from '../src/adapters/_shared/images.ts';
import { makePng, makeLeakyPng, makeJpeg, makeWebp, pngChunk, jpegSegments, pngChunkTypes, webpChunks, SECRET_GPS, SECRET_PROMPT_HINT } from './adapters-fixtures.ts';

const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text));

test('formats are detected from magic bytes, not from the declared type', () => {
  assert.equal(sniffFormat(makePng()), 'png'); assert.equal(sniffFormat(makeJpeg()), 'jpeg'); assert.equal(sniffFormat(makeWebp()), 'webp');
  for (const junk of [Buffer.from('image'), Buffer.alloc(0), Buffer.from([0xff, 0xd8]), Buffer.from('RIFF....WAVE')]) assert.equal(sniffFormat(junk), undefined);
});

test('PNG: textual and EXIF chunks are removed, image and colour chunks survive', () => {
  const clean = stripMetadata(makeLeakyPng());
  assert.equal(clean.format, 'png'); assert.equal(has(clean.bytes, SECRET_GPS), false); assert.equal(has(clean.bytes, SECRET_PROMPT_HINT), false);
  assert.deepEqual(pngChunkTypes(clean.bytes), ['IHDR', 'gAMA', 'IDAT', 'IEND']);
  assert.deepEqual(stripMetadata(clean.bytes).bytes, clean.bytes);
  const unknown = stripMetadata(makePng([pngChunk('prVt', Buffer.from('private')), pngChunk('tIME', Buffer.alloc(7))]));
  assert.deepEqual(pngChunkTypes(unknown.bytes), ['IHDR', 'IDAT', 'IEND']);
});

test('JPEG: EXIF/GPS, XMP and comments are dropped; ICC, JFIF and the scan are untouched', () => {
  const original = makeJpeg({ exif: 1, xmp: '<x:xmpmeta>user-location</x:xmpmeta>', comment: 'camera-serial-123', icc: true });
  const clean = stripMetadata(original).bytes;
  for (const secret of [SECRET_GPS, 'user-location', 'camera-serial-123']) assert.equal(has(clean, secret), false, secret);
  assert.deepEqual(jpegSegments(clean).map(s => s.marker), [0xe0, 0xe2, 0xdb, 0xc0, 0xda]);
  assert.deepEqual(clean.subarray(clean.length - 7), original.subarray(original.length - 7)); // scan bytes + EOI verbatim
  assert.deepEqual(stripMetadata(clean).bytes, clean);
});

test('JPEG: a non-default orientation survives as an orientation-only EXIF block, nothing else does', () => {
  const clean = stripMetadata(makeJpeg({ exif: 6 })).bytes;
  const exif = jpegSegments(clean).filter(s => s.marker === 0xe1);
  assert.equal(exif.length, 1); assert.equal(has(clean, SECRET_GPS), false); assert.ok(exif[0]!.payload.length < 40);
  // "Exif\0\0" (6) + TIFF header (8) + entry count (2) + tag/type/count (8) = value of the single orientation entry.
  assert.equal(exif[0]!.payload.readUInt16BE(24), 6); assert.equal(exif[0]!.payload.readUInt16BE(16), 0x0112);
  assert.equal(jpegSegments(stripMetadata(makeJpeg({ exif: 1 })).bytes).some(s => s.marker === 0xe1), false);
});

test('JPEG: malformed EXIF never blocks stripping', () => {
  const bad = makeJpeg(); const broken = Buffer.concat([bad.subarray(0, 2), Buffer.from([0xff, 0xe1, 0x00, 0x0e]), Buffer.from('Exif\0\0MM\0*\0\0'), bad.subarray(2)]);
  const clean = stripMetadata(broken).bytes; assert.equal(jpegSegments(clean).some(s => s.marker === 0xe1), false);
});

test('WebP: EXIF and XMP chunks vanish, flags and RIFF size stay consistent', () => {
  const original = makeWebp({ exif: true, xmp: '<x:xmpmeta>where</x:xmpmeta>' });
  const clean = stripMetadata(original).bytes; const chunks = webpChunks(clean);
  assert.equal(has(clean, SECRET_GPS), false); assert.equal(has(clean, 'where'), false);
  assert.deepEqual([...chunks.keys()], ['VP8X', 'ICCP', 'VP8L']);
  assert.equal(chunks.get('VP8X')![0]! & 0x0c, 0); assert.equal(chunks.get('VP8X')![0]! & 0x20, 0x20);
  assert.equal(Buffer.from(clean).readUInt32LE(4), clean.length - 8);
  const simple = makeWebp(); assert.deepEqual(stripMetadata(simple).bytes, simple);
});

test('unknown or truncated images are refused with a stable code', () => {
  const jpeg = makeJpeg(); const png = makePng(); const webp = makeWebp({ extended: true });
  for (const bad of [Buffer.from('reference'), Buffer.alloc(0), png.subarray(0, 20), png.subarray(0, png.length - 12), jpeg.subarray(0, 30), Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0xff, 0xff])]), webp.subarray(0, webp.length - 3), Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('xx')])]) {
    assert.throws(() => stripMetadata(bad), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
  }
  assert.throws(() => stripMetadata(Buffer.from('nope'), 'invalid_response'), (e: unknown) => e instanceof MediaError && e.code === 'invalid_response');
  const noIhdr = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IDAT', Buffer.from([1])), pngChunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => stripMetadata(noIhdr), MediaError);
});

test('sanitizeRequest cleans every reference and the mask, keeps the declared-wrong format honest, and never mutates', () => {
  const leaky = makeLeakyPng(); const req = { prompt: 'edit', seed: 3, referenceImages: [{ bytes: leaky, format: 'jpeg' as const }], mask: { bytes: makeJpeg({ exif: 1 }), format: 'png' as const } };
  const clean = sanitizeRequest(req);
  assert.equal(clean.referenceImages![0]!.format, 'png'); assert.equal(clean.mask!.format, 'jpeg'); assert.equal(clean.seed, 3);
  for (const bytes of [clean.referenceImages![0]!.bytes, clean.mask!.bytes]) assert.equal(has(bytes, SECRET_GPS), false);
  assert.equal(has(req.referenceImages[0]!.bytes, SECRET_GPS), true); assert.equal(req.referenceImages[0]!.format, 'jpeg');
  const plain = { prompt: 'tree' }; assert.equal(sanitizeRequest(plain), plain);
});
