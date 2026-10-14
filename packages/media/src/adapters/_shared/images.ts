import { MediaError } from '../../types.ts';
import type { ErrorCode, ImageFormat, ImageRequest, ReferenceImage } from '../../types.ts';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Ancillary PNG chunks that describe pixels or colour. Every other ancillary chunk (text, EXIF, time, private) is dropped. */
const PNG_KEEP = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT']);
export function sniffFormat(bytes: Uint8Array): ImageFormat | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12));
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}
function stripPng(b: Buffer, bad: () => MediaError): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)]; let i = 8; let first = true; let ended = false;
  while (i < b.length) {
    if (i + 12 > b.length) throw bad();
    const length = b.readUInt32BE(i); const type = b.toString('ascii', i + 4, i + 8); const end = i + 12 + length;
    if (end > b.length || (first && type !== 'IHDR')) throw bad();
    first = false;
    if (type === 'IEND') { out.push(b.subarray(i, end)); ended = true; i = end; break; }
    if (/^[A-Z]/.test(type) || PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
  }
  if (!ended) throw bad(); // anything after IEND is dropped, never carried along
  return Buffer.concat(out);
}
/** EXIF IFD0 orientation (1..8), or undefined when absent, default, or unreadable. */
function exifOrientation(payload: Buffer): number | undefined {
  try {
    if (payload.toString('latin1', 0, 6) !== 'Exif\0\0') return undefined;
    const tiff = payload.subarray(6); const order = tiff.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return undefined;
    const le = order === 'II'; const u16 = (o: number) => le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o); const u32 = (o: number) => le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);
    if (u16(2) !== 42) return undefined;
    const ifd = u32(4); const count = u16(ifd);
    for (let n = 0; n < count; n++) { const entry = ifd + 2 + n * 12; if (u16(entry) === 0x0112) { const value = u16(entry + 8); return value >= 2 && value <= 8 ? value : undefined; } }
  } catch { /* unreadable EXIF is simply dropped */ }
  return undefined;
}
/** Big-endian EXIF block holding only the orientation tag, so a rotated photo stays upright without carrying any other tag. */
function orientationSegment(value: number): Buffer {
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4); body.write('Exif\0\0', 0, 'latin1'); body.write('MM', 6, 'latin1'); body.writeUInt16BE(42, 8); body.writeUInt32BE(8, 10);
  body.writeUInt16BE(1, 14); body.writeUInt16BE(0x0112, 16); body.writeUInt16BE(3, 18); body.writeUInt32BE(1, 20); body.writeUInt16BE(value, 24);
  const head = Buffer.alloc(4); head[0] = 0xff; head[1] = 0xe1; head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]);
}
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
type JpegDecision = (marker: number, payload: Buffer, segment: Buffer) => Buffer[];
/**
 * Rewrites a JPEG segment by segment. Entropy-coded scan data is copied exactly (stuffed 0xFF00, restart markers and
 * fill bytes included), segments between scans go through `decide` too, and everything after the end-of-image marker
 * is dropped: a second picture or a video appended to the file must not carry its own metadata along.
 */
export function walkJpeg(b: Buffer, bad: () => MediaError, decide: JpegDecision): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw bad();
  const out: Buffer[] = [b.subarray(0, 2)]; let i = 2; let ended = false;
  while (i < b.length) {
    if (b[i] !== 0xff) throw bad();
    while (b[i + 1] === 0xff) i++;
    const marker = b[i + 1]; if (marker === undefined) throw bad();
    if (marker === 0xd9) { out.push(b.subarray(i, i + 2)); ended = true; break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > b.length) throw bad();
    const length = b.readUInt16BE(i + 2); const end = i + 2 + length;
    if (length < 2 || end > b.length) throw bad();
    const segment = b.subarray(i, end);
    if (marker === 0xda) {
      out.push(segment); let j = end;
      while (j < b.length) {
        if (b[j] !== 0xff) { j++; continue; }
        const next = b[j + 1]; if (next === undefined) throw bad();
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) j += 2; else if (next === 0xff) j++; else break;
      }
      out.push(b.subarray(end, j)); i = j; continue;
    }
    out.push(...decide(marker, b.subarray(i + 4, end), segment)); i = end;
  }
  if (!ended) throw bad();
  return Buffer.concat(out);
}
function stripJpeg(b: Buffer, bad: () => MediaError): Buffer {
  return walkJpeg(b, bad, (marker, payload, segment) => {
    if (marker === 0xe1) { const o = exifOrientation(payload); return o ? [orientationSegment(o)] : []; }
    if (marker === 0xe0) return payload.toString('latin1', 0, 5) === 'JFXX\0' ? [] : [segment]; // JFXX carries an embedded thumbnail
    if (marker === 0xe2) return payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0' ? [segment] : [];
    if (marker === 0xee) return payload.toString('latin1', 0, 5) === 'Adobe' ? [segment] : [];
    if (marker === 0xed || marker === 0xfe || (marker >= 0xe3 && marker <= 0xef)) return []; // IPTC, comments, vendor and provenance blocks
    return [segment];
  });
}
/** Removes only XMP packets (used before a new one is written to an output); everything else stays as the provider delivered it. */
export function dropJpegXmp(b: Buffer, bad: () => MediaError): Buffer {
  return walkJpeg(b, bad, (marker, payload, segment) => marker === 0xe1 && payload.toString('latin1', 0, XMP_HEADER.length) === XMP_HEADER ? [] : [segment]);
}
interface RiffChunk { type: string; data: Buffer }
export function readRiff(b: Buffer, bad: () => MediaError): RiffChunk[] {
  if (b.length < 12 || b.readUInt32LE(4) + 8 > b.length) throw bad();
  const end = b.readUInt32LE(4) + 8; const chunks: RiffChunk[] = []; let i = 12;
  while (i < end) {
    if (i + 8 > end) throw bad();
    const size = b.readUInt32LE(i + 4); const next = i + 8 + size + (size % 2);
    if (i + 8 + size > end) throw bad();
    chunks.push({ type: b.toString('ascii', i, i + 4), data: b.subarray(i + 8, i + 8 + size) }); i = next;
  }
  if (!chunks.length) throw bad();
  return chunks;
}
export function writeRiff(chunks: RiffChunk[]): Buffer {
  const parts: Buffer[] = [Buffer.from('WEBP', 'ascii')];
  for (const c of chunks) { const head = Buffer.alloc(8); head.write(c.type, 0, 'ascii'); head.writeUInt32LE(c.data.length, 4); parts.push(head, c.data); if (c.data.length % 2) parts.push(Buffer.alloc(1)); }
  const body = Buffer.concat(parts); const head = Buffer.alloc(8); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]);
}
const VP8X_EXIF = 0x08; const VP8X_XMP = 0x04;
/** Chunks that describe pixels, colour or animation. Every other chunk (EXIF, XMP, C2PA, vendor data) is metadata or unknown. */
const WEBP_KEEP = new Set(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L']);
function stripWebp(b: Buffer, bad: () => MediaError): Buffer {
  const kept = readRiff(b, bad).filter(c => WEBP_KEEP.has(c.type));
  if (!kept.some(c => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) throw bad();
  // Always rebuilt: bytes after the RIFF payload must not survive either.
  return writeRiff(kept.map(c => { if (c.type !== 'VP8X' || !c.data.length) return c; const data = Buffer.from(c.data); data[0] = data[0]! & ~(VP8X_EXIF | VP8X_XMP); return { type: c.type, data }; }));
}
/** Longest side and pixel count a header may claim. A few hundred bytes can declare 2^31 x 2^31; whatever decodes it would allocate for that. */
export const MAX_IMAGE_SIDE = 32768; export const MAX_IMAGE_PIXELS = 2 ** 28;
/** Canvas size declared by the header (PNG IHDR, first JPEG SOF, WebP VP8X/VP8L/VP8); undefined when it cannot be read. Never decodes pixels. */
export function declaredSize(b: Buffer, format: ImageFormat): { width: number; height: number } | undefined {
  try {
    if (format === 'png') return b.length >= 24 && b.toString('ascii', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : undefined;
    if (format === 'jpeg') {
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!; if (marker === 0xff) { i++; continue; }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
        if (marker === 0xd9 || marker === 0xda) return undefined;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return undefined;
    }
    let i = 12; const end = Math.min(b.length, b.readUInt32LE(4) + 8);
    while (i + 8 <= end) {
      const type = b.toString('ascii', i, i + 4); const size = b.readUInt32LE(i + 4); const data = i + 8;
      if (type === 'VP8X' && size >= 10) return { width: b.readUIntLE(data + 4, 3) + 1, height: b.readUIntLE(data + 7, 3) + 1 };
      if (type === 'VP8L' && size >= 5 && b[data] === 0x2f) { const bits = b.readUInt32LE(data + 1); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
      if (type === 'VP8 ' && size >= 10 && b[data + 3] === 0x9d) return { width: b.readUInt16LE(data + 6) & 0x3fff, height: b.readUInt16LE(data + 8) & 0x3fff };
      i = data + size + (size % 2);
    }
  } catch { /* a header too short to read is the format parser's business */ }
  return undefined;
}
/** Refuses a declared canvas of zero, beyond MAX_IMAGE_SIDE, or beyond MAX_IMAGE_PIXELS. Headers that cannot be read pass: the format checks own those. */
export function assertDimensions(bytes: Uint8Array, format: ImageFormat): void {
  const size = declaredSize(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), format); if (!size) return;
  if (size.width < 1 || size.height < 1 || size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE || size.width * size.height > MAX_IMAGE_PIXELS) throw new MediaError('too_large');
}
/** Removes EXIF/GPS, XMP, IPTC, comments and textual chunks without touching pixel data. Format comes from magic bytes. */
export function stripMetadata(bytes: Uint8Array, onInvalid: ErrorCode = 'unsupported_parameter'): { bytes: Uint8Array; format: ImageFormat } {
  const bad = () => new MediaError(onInvalid); const format = sniffFormat(bytes); const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format) assertDimensions(bytes, format);
  if (format === 'png') return { bytes: stripPng(b, bad), format };
  if (format === 'jpeg') return { bytes: stripJpeg(b, bad), format };
  if (format === 'webp') return { bytes: stripWebp(b, bad), format };
  throw bad();
}
export function sanitizeReference(image: ReferenceImage): ReferenceImage { return stripMetadata(image.bytes); }
/** References and mask leave the process without EXIF/GPS or textual metadata; the caller's request is not mutated. */
export function sanitizeRequest(req: ImageRequest): ImageRequest {
  if (!req.referenceImages?.length && !req.mask) return req;
  return { ...req, ...(req.referenceImages ? { referenceImages: req.referenceImages.map(sanitizeReference) } : {}), ...(req.mask ? { mask: sanitizeReference(req.mask) } : {}) };
}
/** A provider's declared content type is never trusted: the bytes must start like the image they claim to be. */
export function verifyOutput(file: { bytes: Uint8Array; format: ImageFormat }): { bytes: Uint8Array; format: ImageFormat } {
  const format = sniffFormat(file.bytes); if (!format) throw new MediaError('invalid_response');
  assertDimensions(file.bytes, format);
  return { bytes: file.bytes, format };
}
