import { MediaError } from '../../types.ts';
import type { ImageFormat } from '../../types.ts';
import { embedPng } from '../../png.ts';
import { readRiff, sniffFormat, stripMetadata, writeRiff } from './images.ts';
export interface EmbedPayload { prompt: string; parameters: unknown; metadata: unknown }
const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const JPEG_APP1_MAX = 65533;
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One element holding the same JSON the PNG iTXt chunk carries; JSON escapes control characters, so only & < > need XML escaping. */
export function xmpPacket(payload: EmbedPayload & { truncated?: boolean }): string {
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:plur1bus="https://plur1bus.dev/ns/media/1/"><plur1bus:payload>'
    + escapeXml(JSON.stringify(payload)) + '</plur1bus:payload></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>';
}
function fitPacket(payload: EmbedPayload, limit: number): Buffer {
  let packet = Buffer.from(xmpPacket(payload), 'utf8'); if (packet.length <= limit) return packet;
  const chars = Array.from(payload.prompt); let keep = chars.length;
  while (packet.length > limit && keep > 0) {
    keep = Math.floor(keep * 0.9) - 1; packet = Buffer.from(xmpPacket({ ...payload, prompt: chars.slice(0, Math.max(keep, 0)).join(''), truncated: true }), 'utf8');
  }
  if (packet.length > limit) throw new MediaError('too_large');
  return packet;
}
function embedJpeg(bytes: Uint8Array): (payload: EmbedPayload) => Uint8Array {
  const clean = Buffer.from(stripMetadata(bytes, 'invalid_response').bytes);
  return payload => {
    const packet = fitPacket(payload, JPEG_APP1_MAX - XMP_HEADER.length);
    const body = Buffer.concat([XMP_HEADER, packet]); const head = Buffer.alloc(4); head[0] = 0xff; head[1] = 0xe1; head.writeUInt16BE(body.length + 2, 2);
    // After SOI and a leading JFIF APP0 when present.
    let at = 2; if (clean[2] === 0xff && clean[3] === 0xe0) at = 2 + 2 + clean.readUInt16BE(4);
    return Buffer.concat([clean.subarray(0, at), head, body, clean.subarray(at)]);
  };
}
function canvas(chunks: { type: string; data: Buffer }[]): { width: number; height: number; alpha: boolean } {
  const bad = () => new MediaError('invalid_response');
  const vp8x = chunks.find(c => c.type === 'VP8X');
  if (vp8x) { if (vp8x.data.length < 10) throw bad(); return { width: vp8x.data.readUIntLE(4, 3) + 1, height: vp8x.data.readUIntLE(7, 3) + 1, alpha: (vp8x.data[0]! & 0x10) !== 0 }; }
  const lossless = chunks.find(c => c.type === 'VP8L');
  if (lossless) {
    if (lossless.data.length < 5 || lossless.data[0] !== 0x2f) throw bad();
    const bits = lossless.data.readUInt32LE(1); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
  }
  const lossy = chunks.find(c => c.type === 'VP8 ');
  if (lossy) {
    if (lossy.data.length < 10 || lossy.data[3] !== 0x9d || lossy.data[4] !== 0x01 || lossy.data[5] !== 0x2a) throw bad();
    return { width: lossy.data.readUInt16LE(6) & 0x3fff, height: lossy.data.readUInt16LE(8) & 0x3fff, alpha: false };
  }
  throw bad();
}
function embedWebp(bytes: Uint8Array, payload: EmbedPayload): Uint8Array {
  const chunks = readRiff(Buffer.from(stripMetadata(bytes, 'invalid_response').bytes), () => new MediaError('invalid_response'));
  const size = canvas(chunks); const out = chunks.filter(c => c.type !== 'VP8X');
  const flagsOld = chunks.find(c => c.type === 'VP8X')?.data[0] ?? 0;
  const vp8x = Buffer.alloc(10); vp8x[0] = flagsOld | 0x04 | (size.alpha ? 0x10 : 0); vp8x.writeUIntLE(size.width - 1, 4, 3); vp8x.writeUIntLE(size.height - 1, 7, 3);
  return writeRiff([{ type: 'VP8X', data: vp8x }, ...out, { type: 'XMP ', data: Buffer.from(xmpPacket(payload), 'utf8') }]);
}
/** PNG: unchanged iTXt writer. JPEG/WebP: a single XMP packet; prior EXIF/XMP is removed first. Throws invalid_response on malformed bytes. */
export function embedImage(bytes: Uint8Array, format: ImageFormat, payload: EmbedPayload): Uint8Array {
  if (format === 'png') return embedPng(bytes, payload);
  if (format !== 'jpeg' && format !== 'webp') throw new MediaError('unsupported_parameter');
  if (sniffFormat(bytes) !== format) throw new MediaError('invalid_response');
  return format === 'jpeg' ? embedJpeg(bytes)(payload) : embedWebp(bytes, payload);
}
