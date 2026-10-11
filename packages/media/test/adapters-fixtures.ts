// Shared synthetic fixtures for the MG-2 adapter tests. Not a test file: the package glob is test/*.test.ts.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out;
}
/** A real, decodable 1x1 grey PNG, optionally with extra chunks (inserted before IDAT). */
export function makePng(extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(Buffer.from([0, 128]))), pngChunk('IEND', Buffer.alloc(0))]);
}
export const SECRET_GPS = 'GPS-52.5200N-13.4050E';
export const SECRET_PROMPT_HINT = 'secret-parameters-prompt';
/** PNG carrying a tEXt "parameters" chunk (A1111 style), an iTXt and an eXIf chunk with GPS-like content. */
export function makeLeakyPng(): Buffer {
  return makePng([pngChunk('tEXt', Buffer.from(`parameters\0${SECRET_PROMPT_HINT}`)), pngChunk('eXIf', Buffer.from(`MM\0*${SECRET_GPS}`)), pngChunk('gAMA', Buffer.from([0, 1, 0x86, 0xa0]))]);
}
const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
export function jpegSegment(marker: number, payload: Uint8Array): Buffer { return Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]); }
/** Big-endian EXIF with orientation (tag 0x0112) and a GPS-ish ASCII tag whose value contains SECRET_GPS. */
export function exifPayload(orientation: number): Buffer {
  const text = Buffer.from(`${SECRET_GPS}\0`);
  const ifd = Buffer.alloc(2 + 2 * 12 + 4);
  ifd.writeUInt16BE(2, 0);
  ifd.writeUInt16BE(0x0112, 2); ifd.writeUInt16BE(3, 4); ifd.writeUInt32BE(1, 6); ifd.writeUInt16BE(orientation, 10);
  ifd.writeUInt16BE(0x010e, 14); ifd.writeUInt16BE(2, 16); ifd.writeUInt32BE(text.length, 18); ifd.writeUInt32BE(8 + ifd.length, 22);
  return Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08', 'binary'), ifd, text]);
}
export interface JpegOptions { exif?: number; xmp?: string; comment?: string; icc?: boolean; jfif?: boolean }
/** Structurally valid JPEG (SOI, optional APPn/COM, SOF0/SOS stub, EOI). Not decodable pixels, parser-level only. */
export function makeJpeg(options: JpegOptions = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (options.jfif !== false) parts.push(jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')));
  if (options.exif !== undefined) parts.push(jpegSegment(0xe1, exifPayload(options.exif)));
  if (options.xmp) parts.push(jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0${options.xmp}`)));
  if (options.icc) parts.push(jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile-bytes', 'binary')));
  if (options.comment) parts.push(jpegSegment(0xfe, Buffer.from(options.comment)));
  parts.push(jpegSegment(0xdb, Buffer.alloc(65, 1)), jpegSegment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])));
  parts.push(jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
export function riffChunk(fourcc: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8); head.write(fourcc, 0, 'ascii'); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
export function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]); const head = Buffer.alloc(8); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
export function vp8lChunk(width: number, height: number, alpha = false): Buffer {
  const bits = Buffer.alloc(5); bits[0] = 0x2f; bits.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | (alpha ? 1 << 28 : 0), 1);
  return riffChunk('VP8L', Buffer.concat([bits, Buffer.from('lossless-stub')]));
}
export function vp8Chunk(width: number, height: number): Buffer {
  const head = Buffer.alloc(10); head[0] = 0x10; head[3] = 0x9d; head[4] = 0x01; head[5] = 0x2a; head.writeUInt16LE(width, 6); head.writeUInt16LE(height, 8);
  return riffChunk('VP8 ', Buffer.concat([head, Buffer.from('lossy-stub')]));
}
export function vp8xChunk(width: number, height: number, flags = 0): Buffer {
  const d = Buffer.alloc(10); d[0] = flags; d.writeUIntLE(width - 1, 4, 3); d.writeUIntLE(height - 1, 7, 3); return riffChunk('VP8X', d);
}
/** Simple lossless WebP, or an extended one carrying EXIF and XMP chunks. */
export function makeWebp(options: { extended?: boolean; exif?: boolean; xmp?: string; lossy?: boolean } = {}): Buffer {
  const image = options.lossy ? vp8Chunk(1, 1) : vp8lChunk(1, 1);
  if (!options.extended && !options.exif && !options.xmp) return riff([image]);
  const flags = (options.exif ? 0x08 : 0) | (options.xmp ? 0x04 : 0) | 0x20;
  return riff([vp8xChunk(1, 1, flags), riffChunk('ICCP', Buffer.from('icc-profile')), image, ...(options.exif ? [riffChunk('EXIF', Buffer.from(`II*\0${SECRET_GPS}`))] : []), ...(options.xmp ? [riffChunk('XMP ', Buffer.from(options.xmp))] : [])]);
}
/** Walks a WebP and returns chunk fourcc -> payload (last wins). */
export function webpChunks(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes); const out = new Map<string, Buffer>(); let i = 12;
  while (i + 8 <= b.length) { const size = b.readUInt32LE(i + 4); out.set(b.toString('ascii', i, i + 4), b.subarray(i + 8, i + 8 + size)); i += 8 + size + (size % 2); }
  return out;
}
/** Concatenates every APP1 XMP packet of a JPEG. */
export function jpegXmp(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes); const out: string[] = []; let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!; if (marker === 0xda || marker === 0xd9) break;
    const length = b.readUInt16BE(i + 2); const payload = b.subarray(i + 4, i + 2 + length);
    if (marker === 0xe1 && payload.toString('latin1').startsWith('http://ns.adobe.com/xap/1.0/\0')) out.push(payload.subarray(29).toString('utf8'));
    i += 2 + length;
  }
  return out;
}
export function jpegSegments(bytes: Uint8Array): { marker: number; payload: Buffer }[] {
  const b = Buffer.from(bytes); const out: { marker: number; payload: Buffer }[] = []; let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!; const length = b.readUInt16BE(i + 2); out.push({ marker, payload: b.subarray(i + 4, i + 2 + length) });
    if (marker === 0xda) break; i += 2 + length;
  }
  return out;
}
export function pngChunkTypes(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes); const out: string[] = []; let i = 8;
  while (i + 12 <= b.length) { const len = b.readUInt32BE(i); out.push(b.toString('ascii', i + 4, i + 8)); i += 12 + len; }
  return out;
}
export function xmpPayload(packet: string): Record<string, unknown> {
  const m = /<plur1bus:payload>([\s\S]*?)<\/plur1bus:payload>/.exec(packet); if (!m) throw new Error('no plur1bus payload');
  const json = m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(json) as Record<string, unknown>;
}

export interface RecordedCall { method: string; path: string; body: string; headers: IncomingMessage['headers'] }
export type Handler = (call: RecordedCall, res: ServerResponse, index: number) => void | Promise<void>;
export interface FakeServer { url: string; calls: RecordedCall[]; close(): Promise<void> }
/** Loopback fake provider: every request is recorded, the handler decides the (synthetic) response. */
export async function fakeServer(handler: Handler): Promise<FakeServer> {
  const calls: RecordedCall[] = [];
  const s = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = { method: req.method!, path: req.url!, body, headers: req.headers }; calls.push(call);
    await handler(call, res, calls.length - 1);
  });
  s.on('connection', socket => socket.setNoDelay(true));
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, calls, close: () => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }) };
}
export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body));
}
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
/** Deterministic sleeper: records requested delays, never waits. */
export function recordingSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms, signal) => { signal.throwIfAborted(); delays.push(ms); } };
}
