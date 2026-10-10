import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaError } from '../src/index.ts';
import { sniffFormat, stripMetadata, sanitizeRequest, sanitizeReference, walkJpeg, dropJpegXmp, readRiff, writeRiff, verifyOutput } from '../src/adapters/_shared/images.ts';
import { makePng, makeLeakyPng, makeJpeg, makeWebp, pngChunk, jpegSegment, jpegSegments, pngChunkTypes, riff, riffChunk, vp8lChunk, webpChunks, SECRET_GPS } from './adapters-fixtures.ts';

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const bad = () => new MediaError('invalid_response');
const keepAll = (_marker: number, _payload: Buffer, segment: Buffer) => [segment];
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** TIFF block for an APP1 "Exif" payload. Entries are [tag, value]; value is written as a 16-bit SHORT. */
function exifApp1(order: 'II' | 'MM' | 'XX', entries: [number, number][], magic = 42): Buffer {
  const le = order === 'II';
  const tiff = Buffer.alloc(8 + 2 + 12 * entries.length + 4);
  tiff.write(order, 0, 'latin1');
  const w16 = (o: number, v: number) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  w16(2, magic); w32(4, 8); w16(8, entries.length);
  entries.forEach(([tag, value], n) => { const o = 10 + n * 12; w16(o, tag); w16(o + 2, 3); w32(o + 4, 1); w16(o + 8, value); });
  return jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}
/** SOI + custom APP1 + the tail of a structurally valid JPEG (quant table, frame, scan, EOI). */
function jpegWith(app1: Buffer): Buffer {
  return Buffer.concat([SOI, app1, makeJpeg({ jfif: false }).subarray(2)]);
}
function orientationOf(jpeg: Uint8Array): number | undefined {
  const app1 = jpegSegments(stripMetadata(jpeg).bytes).find(s => s.marker === 0xe1);
  return app1?.payload.readUInt16BE(24);
}
/** RIFF with a declared size that does not match the buffer length, for reader boundary tests. */
function rawRiff(declared: number, body: Buffer): Buffer {
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(declared, 4); head.write('WEBP', 8, 'ascii');
  return Buffer.concat([head, body]);
}

test('stripMetadata refuses unknown input with the code the caller asked for', () => {
  assert.throws(() => stripMetadata(Buffer.from('not an image')), code('unsupported_parameter'));
  assert.throws(() => stripMetadata(Buffer.from('not an image'), 'invalid_response'), code('invalid_response'));
  assert.throws(() => stripMetadata(new Uint8Array(0), 'too_large'), code('too_large'));
});

test('sniffFormat and stripMetadata read a view that starts inside a larger buffer', () => {
  const png = makePng(); const big = Buffer.concat([Buffer.from('xxxx-prefix'), png, Buffer.from('tail')]);
  const view = new Uint8Array(big.buffer, big.byteOffset + 11, png.length);
  assert.equal(sniffFormat(view), 'png');
  assert.deepEqual(Buffer.from(stripMetadata(view).bytes), png);
});

test('PNG: a trailing fragment shorter than a chunk header is refused', () => {
  const png = makePng(); const truncated = Buffer.concat([png.subarray(0, png.length - 12), Buffer.alloc(5)]);
  assert.throws(() => stripMetadata(truncated), code('unsupported_parameter'));
});

test('PNG: the first chunk must be IHDR, chunks must fit, and IEND must be present', () => {
  const png = makePng(); const signature = png.subarray(0, 8); const ihdr = png.subarray(8, 33); const idat = pngChunk('IDAT', Buffer.from([1]));
  const cases: [string, Buffer][] = [
    ['first chunk not IHDR', Buffer.concat([signature, idat, pngChunk('IEND', Buffer.alloc(0))])],
    ['chunk length past end of file', Buffer.concat([signature, ihdr, Buffer.from([0, 0, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54])])],
    ['no IEND', Buffer.concat([signature, ihdr, idat])],
  ];
  for (const [name, bytes] of cases) assert.throws(() => stripMetadata(bytes), code('unsupported_parameter'), name);
});

test('PNG: pixel and colour ancillary chunks survive, text and time chunks do not', () => {
  const keep = ['gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'tRNS'];
  const drop = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'];
  const chunks = [...keep, ...drop].map(type => pngChunk(type, Buffer.from([1, 2, 3, 4])));
  const types = pngChunkTypes(stripMetadata(makePng(chunks)).bytes);
  for (const k of keep) assert.ok(types.includes(k), k);
  for (const d of drop) assert.equal(types.includes(d), false, d);
});

test('PNG: a leaky fixture keeps exactly the colour chunk and loses the GPS block', () => {
  const clean = stripMetadata(makeLeakyPng()).bytes;
  assert.equal(Buffer.from(clean).includes(Buffer.from(SECRET_GPS)), false);
  assert.deepEqual(pngChunkTypes(clean), ['IHDR', 'gAMA', 'IDAT', 'IEND']);
});

test('JPEG: APP1 without an Exif header is not orientation data and is dropped', () => {
  const app1 = jpegSegment(0xe1, Buffer.from('Nope\0\0MM\0*\0\0\0\x08', 'binary'));
  assert.equal(jpegSegments(stripMetadata(jpegWith(app1)).bytes).some(s => s.marker === 0xe1), false);
});

test('JPEG: EXIF byte order and TIFF magic are checked before any orientation is read', () => {
  const invalid = [
    ['unknown byte order', exifApp1('XX', [[0x0112, 6]])],
    ['wrong TIFF magic', exifApp1('MM', [[0x0112, 6]], 43)],
  ] as const;
  for (const [name, app1] of invalid) assert.equal(orientationOf(jpegWith(app1)), undefined, name);
});

test('JPEG: little-endian EXIF is read, and its orientation is re-emitted big-endian', () => {
  assert.equal(orientationOf(jpegWith(exifApp1('II', [[0x0112, 8]]))), 8);
  assert.equal(orientationOf(jpegWith(exifApp1('MM', [[0x0112, 3]]))), 3);
});

test('JPEG: orientation values outside 2..8 and a missing orientation tag keep nothing', () => {
  for (const value of [0, 1, 9, 0xffff]) assert.equal(orientationOf(jpegWith(exifApp1('MM', [[0x0112, value]]))), undefined, String(value));
  assert.equal(orientationOf(jpegWith(exifApp1('II', [[0x010e, 6]]))), undefined);
  assert.equal(orientationOf(jpegWith(exifApp1('MM', [[0x010e, 2], [0x0112, 5]]))), 5); // orientation found after another tag
});

test('JPEG: APP14 is kept only when it is Adobe; APP3..APP15 and IPTC/comment blocks are dropped', () => {
  const adobe = jpegSegment(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\0', 'binary'));
  const notAdobe = jpegSegment(0xee, Buffer.from('Other\0\x01', 'binary'));
  const dropped = [jpegSegment(0xe3, Buffer.from('a')), jpegSegment(0xef, Buffer.from('b')), jpegSegment(0xed, Buffer.from('iptc-photoshop')), jpegSegment(0xfe, Buffer.from('comment'))];
  const kept = jpegSegments(stripMetadata(Buffer.concat([SOI, adobe, ...dropped, makeJpeg({ jfif: false }).subarray(2)])).bytes).map(s => s.marker);
  assert.ok(kept.includes(0xee));
  assert.equal(kept.some(m => [0xe3, 0xef, 0xed, 0xfe].includes(m)), false);
  const withoutAdobe = jpegSegments(stripMetadata(Buffer.concat([SOI, notAdobe, makeJpeg({ jfif: false }).subarray(2)])).bytes).map(s => s.marker);
  assert.equal(withoutAdobe.includes(0xee), false);
});

test('walkJpeg: a missing start-of-image is refused, and so is a stray non-marker byte between segments', () => {
  assert.throws(() => walkJpeg(Buffer.from([0x00, 0xd8, 0xff, 0xd9]), bad, keepAll), code('invalid_response'));
  assert.throws(() => walkJpeg(Buffer.concat([SOI, Buffer.from([0x41]), EOI]), bad, keepAll), code('invalid_response'));
});

test('walkJpeg: fill bytes before a marker are skipped, and standalone markers are copied without decisions', () => {
  const seen: number[] = [];
  const out = walkJpeg(Buffer.concat([SOI, Buffer.from([0xff, 0xff, 0xff, 0x01]), Buffer.from([0xff, 0xd0]), Buffer.from([0xff, 0xd7]), Buffer.from([0xff, 0xff, 0xd9])]), bad, (m, _p, s) => { seen.push(m); return [s]; });
  assert.deepEqual([...out], [0xff, 0xd8, 0xff, 0x01, 0xff, 0xd0, 0xff, 0xd7, 0xff, 0xd9]);
  assert.deepEqual(seen, []);
});

test('walkJpeg: truncated marker headers, impossible segment lengths and a lone trailing 0xff are refused', () => {
  const cases: [string, Buffer][] = [
    ['0xff at end of file', Buffer.concat([SOI, Buffer.from([0xff])])],
    ['length field cut off', Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00])])],
    ['length below 2', Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), EOI])],
    ['length past end of file', Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x10, 0x01])])],
  ];
  for (const [name, bytes] of cases) assert.throws(() => walkJpeg(bytes, bad, keepAll), code('invalid_response'), name);
});

test('walkJpeg: a scan that ends in a lone 0xff, or never reaches EOI, is refused', () => {
  const sos = jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
  assert.throws(() => walkJpeg(Buffer.concat([SOI, sos, Buffer.from([0x12, 0xff])]), bad, keepAll), code('invalid_response'));
  assert.throws(() => walkJpeg(Buffer.concat([SOI, sos, Buffer.from([0x12, 0x34])]), bad, keepAll), code('invalid_response'));
});

test('walkJpeg: a file that ends in a marker-less 0xff after SOI is refused', () => {
  assert.throws(() => walkJpeg(Buffer.from([0xff, 0xd8, 0xff]), bad, keepAll), code('invalid_response'));
});

test('walkJpeg: decisions may drop or replace segments, and nothing after EOI is read', () => {
  const jpeg = makeJpeg({ exif: 1, comment: 'drop-me' });
  const replaced = walkJpeg(jpeg, bad, (m, _p, s) => (m === 0xfe ? [] : [s]));
  assert.equal(Buffer.from(replaced).includes(Buffer.from('drop-me')), false);
  const trailing = Buffer.concat([jpeg, Buffer.from('appended-video-bytes')]);
  assert.equal(Buffer.from(walkJpeg(trailing, bad, keepAll)).includes(Buffer.from('appended-video-bytes')), false);
});

test('dropJpegXmp removes only the XMP packet and leaves EXIF, ICC and the scan byte-identical', () => {
  const withXmp = makeJpeg({ exif: 1, xmp: '<x:xmpmeta>where</x:xmpmeta>', icc: true });
  const expected = makeJpeg({ exif: 1, icc: true });
  assert.deepEqual(Buffer.from(dropJpegXmp(withXmp, bad)), expected);
  assert.deepEqual(Buffer.from(dropJpegXmp(expected, bad)), expected);
  assert.throws(() => dropJpegXmp(Buffer.from('nope'), () => new MediaError('too_large')), code('too_large'));
});

test('readRiff rejects headers that are too short or declare more than the buffer holds', () => {
  assert.throws(() => readRiff(Buffer.alloc(11), bad), code('invalid_response'));
  assert.throws(() => readRiff(rawRiff(100, Buffer.alloc(0)), bad), code('invalid_response'));
});

test('readRiff rejects a RIFF payload with no chunks, a truncated chunk header, or a chunk that overruns the payload', () => {
  assert.throws(() => readRiff(rawRiff(4, Buffer.alloc(0)), bad), code('invalid_response'));
  assert.throws(() => readRiff(rawRiff(8 + 4, Buffer.from('VP8 ')), bad), code('invalid_response'));
  const overrun = Buffer.concat([Buffer.from('VP8L'), Buffer.from([100, 0, 0, 0]), Buffer.from('xx')]);
  assert.throws(() => readRiff(rawRiff(4 + overrun.length, overrun), bad), code('invalid_response'));
});

test('writeRiff pads odd-sized chunks and readRiff reads them back', () => {
  const out = writeRiff([{ type: 'ICCP', data: Buffer.from('abc') }, { type: 'VP8L', data: Buffer.from('lossless') }]);
  assert.equal(Buffer.from(out).readUInt32LE(4), out.length - 8);
  assert.equal(out.length % 2, 0);
  const chunks = readRiff(out, bad);
  assert.deepEqual(chunks.map(c => c.type), ['ICCP', 'VP8L']);
  assert.equal(chunks[0]!.data.toString(), 'abc');
  assert.equal(chunks[1]!.data.toString(), 'lossless');
});

test('writeRiff with no chunks yields a container that readRiff refuses', () => {
  const empty = writeRiff([]);
  assert.equal(empty.toString('ascii', 0, 4), 'RIFF');
  assert.throws(() => readRiff(empty, bad), code('invalid_response'));
});

test('WebP: an image-less container is refused; an ANMF animation without a still survives', () => {
  const metadataOnly = riff([riffChunk('VP8X', Buffer.alloc(10)), riffChunk('EXIF', Buffer.from(SECRET_GPS))]);
  assert.throws(() => stripMetadata(metadataOnly), code('unsupported_parameter'));
  const animated = riff([riffChunk('ANIM', Buffer.alloc(6)), riffChunk('ANMF', Buffer.alloc(16)), riffChunk('XMP ', Buffer.from('where'))]);
  assert.deepEqual([...webpChunks(stripMetadata(animated).bytes).keys()], ['ANIM', 'ANMF']);
});

test('WebP: an empty VP8X chunk is passed through, and VP8X flags are cleared only when data is present', () => {
  const emptyVp8x = riff([riffChunk('VP8X', Buffer.alloc(0)), vp8lChunk(1, 1)]);
  assert.equal(webpChunks(stripMetadata(emptyVp8x).bytes).get('VP8X')!.length, 0);
  const flagged = riff([riffChunk('VP8X', Buffer.from([0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), vp8lChunk(1, 1)]);
  assert.equal(webpChunks(stripMetadata(flagged).bytes).get('VP8X')![0]! & 0x0c, 0);
});

test('verifyOutput returns the sniffed format and refuses bytes that are not an image', () => {
  assert.deepEqual(verifyOutput({ bytes: makePng(), format: 'png' }).format, 'png');
  assert.deepEqual(verifyOutput({ bytes: makeJpeg(), format: 'webp' }).format, 'jpeg'); // declared type is ignored
  assert.throws(() => verifyOutput({ bytes: Buffer.from('GIF89a'), format: 'png' }), code('invalid_response'));
  assert.throws(() => verifyOutput({ bytes: new Uint8Array(0), format: 'jpeg' }), code('invalid_response'));
});

test('sanitizeRequest handles references only and mask only, without adding the absent field', () => {
  const ref = { bytes: makeLeakyPng(), format: 'png' as const };
  const refsOnly = sanitizeRequest({ prompt: 'p', referenceImages: [ref] });
  assert.equal('mask' in refsOnly, false);
  assert.deepEqual(Buffer.from(refsOnly.referenceImages![0]!.bytes), Buffer.from(stripMetadata(ref.bytes).bytes));
  const maskOnly = sanitizeRequest({ prompt: 'p', mask: ref });
  assert.equal('referenceImages' in maskOnly, false);
  assert.equal(Buffer.from(maskOnly.mask!.bytes).includes(Buffer.from(SECRET_GPS)), false);
  assert.equal(sanitizeRequest({ prompt: 'p', referenceImages: [] }).referenceImages!.length, 0);
});

test('sanitizeReference returns a clean copy and never the caller bytes', () => {
  const ref = { bytes: makeJpeg({ exif: 1, comment: 'x' }), format: 'jpeg' as const };
  const out = sanitizeReference(ref);
  assert.equal(out.format, 'jpeg');
  assert.notEqual(out.bytes, ref.bytes);
  assert.equal(jpegSegments(out.bytes).some(s => s.marker === 0xfe), false);
});
