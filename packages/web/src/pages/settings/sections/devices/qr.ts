// Compact standalone QR code generator for pairing link display (ISO/IEC 18004).
// Generates SVG paths for Byte mode QR codes up to Version 10 with Error Correction Level M. Zero external dependencies.
import { h } from "preact";
import type { View } from "../../../../view.ts";

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

// Version table for Level M: [version, totalDataBytes, ecBytesPerBlock, blocks]
const V_TABLE = [
  [1, 16, 10, 1],
  [2, 28, 16, 1],
  [3, 44, 26, 1],
  [4, 64, 18, 2],
  [5, 86, 24, 2],
  [6, 108, 16, 4],
  [7, 124, 18, 4],
  [8, 154, 22, 4],
  [9, 182, 22, 5],
  [10, 216, 26, 5],
] as const;

const ALIGN_COORDS: Record<number, number[]> = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

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

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = genPoly(ecLen);
  const res = new Uint8Array(ecLen);
  for (const b of data) {
    const factor = b ^ (res[0] ?? 0);
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] = (res[i] ?? 0) ^ gfMul(gen[i]!, factor);
  }
  return res;
}

export function generateQrMatrix(text: string): { size: number; path: string } {
  const utf8 = new TextEncoder().encode(text);
  const vInfo = V_TABLE.find(([v, dataCap]) => {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    return utf8.length <= dataCap - Math.ceil(headerBits / 8);
  }) ?? V_TABLE[V_TABLE.length - 1]!;

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

  const blockSize = Math.floor(totalData / numBlocks);
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = b < totalData % numBlocks ? blockSize + 1 : blockSize;
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

  const coords = ALIGN_COORDS[version] ?? [];
  for (const r of coords) {
    for (const c of coords) {
      if (matrix[r]![c] !== null) continue;
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
        if (matrix[r]![c] === null) {
          const bit = bitIdx < allBits.length ? allBits[bitIdx++]! : 0;
          matrix[r]![c] = bit ^ ((r + c) % 2 === 0 ? 1 : 0);
        }
      }
    }
    upwards = !upwards;
  }

  const format = 0b101010000010010; // Level M + Mask 0
  for (let i = 0; i < 15; i++) {
    const bit = (format >> (14 - i)) & 1;
    if (i < 6) matrix[8]![i] = bit;
    else if (i === 6) matrix[8]![7] = bit;
    else if (i === 7) matrix[8]![8] = bit;
    else if (i === 8) matrix[7]![8] = bit;
    else matrix[14 - i]![8] = bit;
    if (i < 8) matrix[size - 1 - i]![8] = bit;
    else matrix[8]![size - 15 + i] = bit;
  }

  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c] === 1) path += `M${c},${r}h1v1h-1z `;
    }
  }

  return { size, path: path.trim() };
}

export function QrCodeView({ text, label }: { text: string; label?: string }): View {
  const { size, path } = generateQrMatrix(text);
  return h("div", { class: "pairing-qr" },
    h("svg", {
      viewBox: `0 0 ${size} ${size}`,
      role: "img",
      "aria-label": label ?? "QR Code",
      width: "256",
      height: "256",
    },
      h("path", { d: path, fill: "currentColor" })));
}
