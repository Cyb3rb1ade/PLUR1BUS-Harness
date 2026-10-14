// Settings > Devices: the pairing QR generator. Checked against published reference values (the "HELLO WORLD" 1-M example of the
// ISO/IEC 18004 tutorials, the version information table) and structural rules, since no decoder is a dependency of the package.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { blockLengths, generateQrMatrix, QR_MAX_BYTES, rsEncode, versionInfo } from "../src/pages/settings/sections/devices/qr.ts";

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
  test("text beyond the capacity of version 10 is refused instead of being cut off", () => {
    assert.doesNotThrow(() => generateQrMatrix(text(QR_MAX_BYTES)));
    assert.throws(() => generateQrMatrix(text(QR_MAX_BYTES + 1)), RangeError);
  });
});
