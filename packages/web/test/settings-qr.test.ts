// Settings > Devices: the pairing QR generator. Checked against published reference values (the "HELLO WORLD" 1-M example of the
// ISO/IEC 18004 tutorials, the version information table) and structural rules, since no decoder is a dependency of the package.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alignmentCoords, blockLengths, formatBits, generateQrMatrix, QR_MAX_BYTES, rsEncode, V_TABLE, versionInfo } from "../src/pages/settings/sections/devices/qr.ts";

const cells = (path: string): Set<string> => new Set([...path.matchAll(/M(\d+),(\d+)h/g)].map((m) => `${m[2]},${m[1]}`));
const text = (n: number): string => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join("");

describe("pairing QR generator", () => {
  test("error correction codewords match the reference example (version 1-M, 10 EC codewords)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    assert.deepEqual([...rsEncode(new Uint8Array(data), 10)], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
  test("version information of versions 7 to 10 matches the standard's table", () => {
    assert.deepEqual([7, 8, 9, 10].map(versionInfo), [0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
  });
  test("the shorter data blocks come first, the longer ones last", () => {
    assert.deepEqual(blockLengths(154, 4), [38, 38, 39, 39]);
    assert.deepEqual(blockLengths(182, 5), [36, 36, 36, 37, 37]);
    assert.deepEqual(blockLengths(216, 5), [43, 43, 43, 43, 44]);
    assert.deepEqual(blockLengths(124, 4), [31, 31, 31, 31]);
  });
  test("from version 7 the alignment patterns on the timing lines are drawn", () => {
    const { size, path } = generateQrMatrix(text(120));
    assert.equal(size, 45);
    const on = cells(path);
    // centre of the pattern at (row 6, column 22) and its dark ring; the light ring in between
    assert.ok(on.has("6,22") && on.has("4,20") && on.has("8,24"), "dark centre and ring");
    assert.ok(!on.has("5,21") && !on.has("7,23"), "light ring");
    assert.ok(on.has("22,6") && on.has("20,4"), "mirrored pattern at (22, 6)");
  });
  test("from version 7 the version information is written twice", () => {
    const { size, path } = generateQrMatrix(text(120));
    const on = cells(path);
    const info = versionInfo(7);
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1 ? true : false;
      assert.equal(on.has(`${size - 11 + (i % 3)},${Math.floor(i / 3)}`), bit, `bottom left bit ${i}`);
      assert.equal(on.has(`${Math.floor(i / 3)},${size - 11 + (i % 3)}`), bit, `top right bit ${i}`);
    }
  });
  test("text beyond the capacity of version 40 is refused instead of being cut off; the capacity is what pairing.qr accepts", () => {
    assert.equal(QR_MAX_BYTES, 2331);
    assert.equal(generateQrMatrix(text(QR_MAX_BYTES)).size, 177);
    assert.throws(() => generateQrMatrix(text(QR_MAX_BYTES + 1)), RangeError);
  });
  test("every version from 1 to 40 is in the table, and the codewords add up to the symbol's data capacity", () => {
    assert.deepEqual(V_TABLE.map((r) => r[0]), Array.from({ length: 40 }, (_, i) => i + 1));
    for (const [v, data, ec, blocks] of V_TABLE) {
      // Raw modules of a symbol (ISO/IEC 18004, Nayuki's closed form) without the function patterns, by 8 bits to a codeword.
      let raw = (16 * v + 128) * v + 64;
      if (v >= 2) { const a = Math.floor(v / 7) + 2; raw -= (25 * a - 10) * a - 55; if (v >= 7) raw -= 36; }
      assert.equal(data + ec * blocks, Math.floor(raw / 8), `version ${v}`);
    }
  });
  test("alignment pattern centres of versions 14, 21, 32, 36 and 40 match the standard's table", () => {
    assert.deepEqual(alignmentCoords(1), []);
    assert.deepEqual(alignmentCoords(7), [6, 22, 38]);
    assert.deepEqual(alignmentCoords(14), [6, 26, 46, 66]);
    assert.deepEqual(alignmentCoords(21), [6, 28, 50, 72, 94]);
    assert.deepEqual(alignmentCoords(32), [6, 34, 60, 86, 112, 138]);
    assert.deepEqual(alignmentCoords(36), [6, 24, 50, 76, 102, 128, 154]);
    assert.deepEqual(alignmentCoords(40), [6, 30, 58, 86, 114, 142, 170]);
  });
  test("version information of versions 11, 21, 31 and 40 matches the standard's table", () => {
    assert.deepEqual([11, 21, 31, 40].map(versionInfo), [0x0bbf6, 0x15683, 0x1f250, 0x28c69]);
  });
  test("format information of level M with each of the eight masks matches the standard's table", () => {
    assert.deepEqual(Array.from({ length: 8 }, (_, m) => formatBits(m).toString(2).padStart(15, "0")), [
      "101010000010010", "101000100100101", "101111001111100", "101101101001011",
      "100010111111001", "100000011001110", "100111110010111", "100101010100000"]);
  });
  test("a long link yields a symbol of the matching version, with the three finder patterns", () => {
    const { size, path } = generateQrMatrix(`https://harness.example/pair#${text(1200)}`);
    assert.equal(size, 17 + 4 * 29);
    const on = cells(path);
    for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) assert.ok(on.has(`${r},${c}`) && on.has(`${r + 3},${c + 3}`) && !on.has(`${r + 1},${c + 1}`), `finder at ${r},${c}`);
  });
});
