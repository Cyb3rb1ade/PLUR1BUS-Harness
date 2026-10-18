// Pixel diff for the golden set (D100 §5), with Node built-ins only (node:zlib). Byte-identical PNGs are not stable across Chrome
// versions or machines (rasteriser and PNG encoder changes), so the golden set compares decoded pixels against a documented
// threshold instead: a pixel counts as different when any channel deviates by more than CHANNEL_TOLERANCE (of 255), and a
// page fails when more than MAX_DIFF_RATIO of its pixels differ or when its dimensions change. See docs/documents.md.

import { inflateSync } from "node:zlib";

/** Per-channel tolerance (0-255): absorbs anti-aliasing and colour-management noise, far below any real colour change. */
export const CHANNEL_TOLERANCE = 8;
/** Maximum share of differing pixels per page (0.1 %). A moved line of text or box is well above this. */
export const MAX_DIFF_RATIO = 0.001;

export interface Pixels { readonly width: number; readonly height: number; readonly rgba: Uint8Array }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit, non-interlaced greyscale/RGB/RGBA/grey+alpha PNG (what Chrome emits) to RGBA. */
export function decodePng(data: Uint8Array): Pixels {
  const buf = Buffer.from(data);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]!; colorType = body[9]!; interlace = body[12]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || depth !== 8 || interlace !== 0 || width === 0 || height === 0) throw new Error(`unsupported PNG (colorType=${colorType} depth=${depth} interlace=${interlace})`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG data length mismatch");
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0, b = prev[x]!, c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, i = x * channels;
      if (channels === 1 || channels === 2) { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[i]!; rgba[o + 3] = channels === 2 ? cur[i + 1]! : 255; }
      else { rgba[o] = cur[i]!; rgba[o + 1] = cur[i + 1]!; rgba[o + 2] = cur[i + 2]!; rgba[o + 3] = channels === 4 ? cur[i + 3]! : 255; }
    }
    cur.copy(prev);
  }
  return { width, height, rgba };
}

export interface PngDiff { readonly ok: boolean; readonly sizeMismatch: boolean; readonly differing: number; readonly total: number; readonly ratio: number }

/** Compare two PNGs against the documented threshold. */
export function diffPng(reference: Uint8Array, current: Uint8Array, opts: { tolerance?: number; maxRatio?: number } = {}): PngDiff {
  const tolerance = opts.tolerance ?? CHANNEL_TOLERANCE, maxRatio = opts.maxRatio ?? MAX_DIFF_RATIO;
  const a = decodePng(reference), b = decodePng(current);
  if (a.width !== b.width || a.height !== b.height) return { ok: false, sizeMismatch: true, differing: Math.max(a.width * a.height, b.width * b.height), total: a.width * a.height, ratio: 1 };
  const total = a.width * a.height;
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (Math.abs(a.rgba[o]! - b.rgba[o]!) > tolerance || Math.abs(a.rgba[o + 1]! - b.rgba[o + 1]!) > tolerance || Math.abs(a.rgba[o + 2]! - b.rgba[o + 2]!) > tolerance || Math.abs(a.rgba[o + 3]! - b.rgba[o + 3]!) > tolerance) differing++;
  }
  const ratio = differing / total;
  return { ok: ratio <= maxRatio, sizeMismatch: false, differing, total, ratio };
}
