import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { test } from "node:test";
import { CHANNEL_TOLERANCE, decodePng, diffPng, MAX_DIFF_RATIO } from "../scripts/png-diff.ts";

const W = 794, H = 1123;

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}
/** Minimal RGBA encoder (filter 0 on even rows, Sub on odd rows, so both paths of the decoder run). */
function encode(rgba: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1), sub = y % 2 === 1; raw[o] = sub ? 1 : 0;
    for (let x = 0; x < w * 4; x++) raw[o + 1 + x] = (rgba[y * w * 4 + x]! - (sub && x >= 4 ? rgba[y * w * 4 + x - 4]! : 0)) & 0xff;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A white page with a few "text line" bars and a box; `dx` shifts the box horizontally. */
function page(opts: { dx?: number; noise?: number } = {}): Buffer {
  const px = new Uint8Array(W * H * 4).fill(255);
  const rect = (x0: number, y0: number, w: number, h: number, v: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = v; }
  };
  for (let i = 0; i < 12; i++) rect(60, 80 + i * 24, 500 - (i % 3) * 40, 10, 40);
  rect(560 + (opts.dx ?? 0), 100, 150, 90, 120);
  if (opts.noise) for (let i = 0; i < W * H * 4; i += 4) { px[i] = Math.min(255, px[i]! + opts.noise); }
  return encode(px, W, H);
}

test("decodes a PNG with Sub-filtered rows", () => {
  const p = decodePng(page());
  assert.equal(p.width, W); assert.equal(p.height, H);
  assert.deepEqual([...p.rgba.subarray((100 * W + 600) * 4, (100 * W + 600) * 4 + 4)], [120, 120, 120, 255]);
});

test("identical pages pass", () => {
  const r = diffPng(page(), page());
  assert.equal(r.ok, true); assert.equal(r.differing, 0);
});

test("sub-tolerance rendering noise on every pixel still passes", () => {
  assert.equal(diffPng(page(), page({ noise: 0 })).ok, true);
  const r = diffPng(page(), page({ noise: CHANNEL_TOLERANCE - 1 }));
  assert.equal(r.ok, true);
});

test("counter-example: an element moved by 12 px turns the diff red", () => {
  const r = diffPng(page(), page({ dx: 12 }));
  assert.equal(r.ok, false);
  assert.ok(r.ratio > MAX_DIFF_RATIO, `ratio ${r.ratio}`);
});

test("counter-example: a colour change above the tolerance on one page-wide channel fails", () => {
  assert.equal(diffPng(page(), page({ noise: CHANNEL_TOLERANCE + 20 })).ok, false);
});

test("a dimension change fails regardless of content", () => {
  const small = encode(new Uint8Array(10 * 10 * 4).fill(255), 10, 10);
  const r = diffPng(page(), small);
  assert.equal(r.ok, false); assert.equal(r.sizeMismatch, true);
});
