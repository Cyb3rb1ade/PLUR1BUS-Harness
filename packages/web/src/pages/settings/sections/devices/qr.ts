// Compact standalone QR code generator for pairing link display (ISO/IEC 18004).
// Generates SVG paths for Byte mode QR codes up to Version 40 with Error Correction Level M. Zero external dependencies.
import { h } from "preact";
import type { View } from "../../../../view.ts";
import { t } from "../../../../i18n.ts";

// GF(256) arithmetic with primitive polynomial 0x11D (285)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
}
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

// Version table for Level M (versions 1 to 40): [error correction codewords per block, blocks of group 1, data codewords of a group 1 block,
// blocks of group 2, data codewords of a group 2 block]. Group 2 blocks are one codeword longer.
const M_TABLE: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0], [28, 17, 46, 0, 0], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46], [28, 8, 47, 13, 48],
  [28, 19, 46, 4, 47], [28, 22, 45, 3, 46], [28, 3, 45, 23, 46], [28, 21, 45, 7, 46], [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47], [28, 10, 46, 23, 47], [28, 14, 46, 21, 47], [28, 14, 46, 23, 47], [28, 12, 47, 26, 48],
  [28, 6, 47, 34, 48], [28, 29, 46, 14, 47], [28, 13, 46, 32, 47], [28, 40, 47, 7, 48], [28, 18, 47, 31, 48],
];

/** Per version: [version, total data codewords, error correction codewords per block, number of blocks]. */
export const V_TABLE: readonly (readonly [number, number, number, number])[] = M_TABLE.map(([ec, n1, d1, n2, d2], i) => [i + 1, n1 * d1 + n2 * d2, ec, n1 + n2] as const);

/** Centres of the alignment patterns of a version (rows and columns alike): 6, then evenly spaced up to 7 modules from the far edge. */
export function alignmentCoords(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10, k = 1; k < count; k++, pos -= step) out.splice(1, 0, pos);
  return out;
}

function genPoly(deg: number): Uint8Array {
  let p = new Uint8Array([1]);
  for (let i = 0; i < deg; i++) {
    const next = new Uint8Array(p.length + 1);
    for (let j = 0; j < p.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(p[j]!, EXP[i]!);
      next[j + 1] = (next[j + 1] ?? 0) ^ p[j]!;
    }
    p = next;
  }
  return p;
}

/** `gen` is stored lowest degree first, the long division below walks the divisor from its highest degree down, hence the reversed index. */
export function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = genPoly(ecLen);
  const res = new Uint8Array(ecLen);
  for (const b of data) {
    const factor = b ^ (res[0] ?? 0);
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] = (res[i] ?? 0) ^ gfMul(gen[ecLen - 1 - i]!, factor);
  }
  return res;
}

/** Lengths of the data blocks of one version: the shorter blocks come first (group 1), the longer ones last (group 2). */
export function blockLengths(totalData: number, numBlocks: number): number[] {
  const short = Math.floor(totalData / numBlocks);
  const longer = totalData % numBlocks;
  return Array.from({ length: numBlocks }, (_, b) => (b < numBlocks - longer ? short : short + 1));
}

/** The 18 version information bits of versions 7 and up: 6 version bits plus a BCH(18,6) remainder. */
export function versionInfo(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** The longest text (bytes) the generator can encode: version 40, level M (the length pairing.qr accepts). */
export const QR_MAX_BYTES = 2331;

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The 15 format information bits for error correction level M and a mask: 5 data bits plus a BCH(15,5) remainder, XORed with 0x5412. */
export function formatBits(mask: number): number {
  const data = mask; // level M is 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function writeFormat(m: number[][], size: number, format: number): void {
  for (let i = 0; i < 15; i++) {
    const bit = (format >> (14 - i)) & 1;
    if (i < 6) m[8]![i] = bit;
    else if (i === 6) m[8]![7] = bit;
    else if (i === 7) m[8]![8] = bit;
    else if (i === 8) m[7]![8] = bit;
    else m[14 - i]![8] = bit;
    if (i < 8) m[size - 1 - i]![8] = bit;
    else m[8]![size - 15 + i] = bit;
  }
}

/** The four penalty rules of ISO/IEC 18004 (runs, 2x2 blocks, finder-like patterns, dark/light balance); lower is better. */
export function penalty(m: number[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => number): void => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    if (run >= 5) score += 3 + (run - 5);
    for (let i = 0; i + 11 <= n; i++) {
      let a = true, b = true;
      for (let k = 0; k < 11; k++) {
        if (get(i + k) !== FINDER_A[k]) a = false;
        if (get(i + k) !== FINDER_B[k]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  };
  for (let r = 0; r < n; r++) line((i) => m[r]![i]!);
  for (let c = 0; c < n; c++) line((i) => m[i]![c]!);
  let dark = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      dark += m[r]![c]!;
      if (r + 1 < n && c + 1 < n && m[r]![c] === m[r]![c + 1] && m[r]![c] === m[r + 1]![c] && m[r]![c] === m[r + 1]![c + 1]) score += 3;
    }
  }
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}
const FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

export function generateQrMatrix(text: string): { size: number; path: string } {
  const utf8 = new TextEncoder().encode(text);
  const vInfo = V_TABLE.find(([v, dataCap]) => {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    return utf8.length <= dataCap - Math.ceil(headerBits / 8);
  });
  // Beyond version 40 there is no code: refuse instead of cutting the data off.
  if (!vInfo) throw new RangeError("QR text too long");

  const [version, totalData, ecPerBlock, numBlocks] = vInfo;
  const size = 17 + 4 * version;

  const bits: number[] = [];
  const pushBits = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(utf8.length, version < 10 ? 8 : 16);
  for (const b of utf8) pushBits(b, 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    dataBytes.push(b);
  }
  const pad = [0xec, 0x11];
  let padIdx = 0;
  while (dataBytes.length < totalData) dataBytes.push(pad[padIdx++ % 2]!);

  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const len of blockLengths(totalData, numBlocks)) {
    const block = new Uint8Array(dataBytes.slice(offset, offset + len));
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += len;
  }

  const interleaved: number[] = [];
  const maxBlockLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (const b of blocks) if (i < b.length) interleaved.push(b[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) interleaved.push(ec[i]!);
  }

  const matrix: (number | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));

  const placeFinder = (r: number, c: number): void => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const nr = r + y, nc = c + x;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
          matrix[nr]![nc] = (y >= 0 && y <= 6 && (x === 0 || x === 6)) ||
                            (x >= 0 && x <= 6 && (y === 0 || y === 6)) ||
                            (y >= 2 && y <= 4 && x >= 2 && x <= 4) ? 1 : 0;
        }
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    if (matrix[6]![i] === null) matrix[6]![i] = i % 2 === 0 ? 1 : 0;
    if (matrix[i]![6] === null) matrix[i]![6] = i % 2 === 0 ? 1 : 0;
  }

  const coords = alignmentCoords(version);
  for (const r of coords) {
    for (const c of coords) {
      // Skip the places next to a finder pattern; the ones on the timing lines (6,22 and 22,6 from version 7 on) are real.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          matrix[r + y]![c + x] = Math.max(Math.abs(y), Math.abs(x)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  matrix[4 * version + 9]![8] = 1; // dark module

  for (let i = 0; i <= 8; i++) {
    if (matrix[8]![i] === null) matrix[8]![i] = 0;
    if (matrix[i]![8] === null) matrix[i]![8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (matrix[8]![size - 1 - i] === null) matrix[8]![size - 1 - i] = 0;
    if (matrix[size - 1 - i]![8] === null) matrix[size - 1 - i]![8] = 0;
  }

  if (version >= 7) {
    const info = versionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      matrix[size - 11 + (i % 3)]![Math.floor(i / 3)] = bit;
      matrix[Math.floor(i / 3)]![size - 11 + (i % 3)] = bit;
    }
  }

  const reserved = matrix.map((row) => row.map((v) => v !== null));
  const allBits: number[] = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i--) allBits.push((byte >> i) & 1);
  }
  let bitIdx = 0;
  let upwards = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    const rows = upwards ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i);
    for (const r of rows) {
      for (const c of [right, right - 1]) {
        if (matrix[r]![c] === null) matrix[r]![c] = bitIdx < allBits.length ? allBits[bitIdx++]! : 0;
      }
    }
    upwards = !upwards;
  }

  // Try the eight masks and keep the one with the lowest penalty: a fixed mask can leave runs and finder-like patterns that scanners reject.
  let best: number[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = matrix.map((row, r) => row.map((v, c) => (reserved[r]![c] ? (v as number) : (v as number) ^ (MASKS[mask]!(r, c) ? 1 : 0))));
    writeFormat(grid, size, formatBits(mask));
    const score = penalty(grid);
    if (score < bestScore) { bestScore = score; best = grid; }
  }
  const final = best!;

  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (final[r]![c] === 1) path += `M${c},${r}h1v1h-1z `;
    }
  }

  return { size, path: path.trim() };
}

export function QrCodeView({ text, label }: { text: string; label?: string }): View {
  let code: { size: number; path: string };
  try { code = generateQrMatrix(text); } catch { return h("p", { class: "field-hint", role: "note" }, t("devices.pair.tooLong")); }
  const { size, path } = code;
  return h("div", { class: "pairing-qr" },
    h("svg", {
      viewBox: `0 0 ${size} ${size}`,
      role: "img",
      "aria-label": label ?? "QR Code",
      width: String(Math.max(256, size * 4)),
      height: String(Math.max(256, size * 4)),
    },
      h("path", { d: path, fill: "currentColor" })));
}
