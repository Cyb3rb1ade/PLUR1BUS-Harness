import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withShell } from "./browser-harness.ts";

type Frame = { name: string; size: number; png: Buffer };
const iconDirectory = fileURLToPath(new URL("../../src-tauri/icons/", import.meta.url));

function pngSize(bytes: Buffer): number {
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  const width = bytes.readUInt32BE(16);
  assert.equal(bytes.readUInt32BE(20), width);
  return width;
}

function icoFrames(bytes: Buffer): Frame[] {
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = bytes[entry] || 256;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    const png = bytes.subarray(offset, offset + length);
    assert.equal(pngSize(png), size);
    frames.push({ name: `ico-${size}`, size, png });
  }
  return frames;
}

function icnsFrames(bytes: Buffer): Frame[] {
  assert.equal(bytes.subarray(0, 4).toString(), "icns");
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const frames: Frame[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const kind = bytes.subarray(offset, offset + 4).toString();
    const length = bytes.readUInt32BE(offset + 4);
    const png = bytes.subarray(offset + 8, offset + length);
    frames.push({ name: `icns-${kind}`, size: pngSize(png), png });
    offset += length;
  }
  return frames;
}

test("every bundled icon frame uses red 1 below 48 and ringed P1B from 48", async () => {
  const frames: Frame[] = [];
  for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256]] as Array<[string, number]>) {
    const png = await readFile(`${iconDirectory}/${name}`);
    assert.equal(pngSize(png), size);
    frames.push({ name, size, png });
  }
  frames.push(...icoFrames(await readFile(`${iconDirectory}/icon.ico`)));
  frames.push(...icnsFrames(await readFile(`${iconDirectory}/icon.icns`)));
  assert.deepEqual(frames.filter(f => f.name.startsWith("ico-")).map(f => f.size), [16, 20, 24, 32, 40, 48, 64, 256]);
  assert.deepEqual(frames.filter(f => f.name.startsWith("icns-")).map(f => f.size), [16, 32, 64, 128, 256, 512, 1024, 32, 64, 256, 512]);
  await withShell(async page => {
    for (const frame of frames) {
      const colors = await page.evaluate(async base64 => {
        const img = new Image();
        img.src = `data:image/png;base64,${base64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        const pixels = context.getImageData(0, 0, img.width, img.height).data;
        const opaque = new Set<string>();
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255) opaque.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        return [...opaque];
      }, frame.png.toString("base64"));
      assert.ok(colors.includes("229,72,77"), `${frame.name}: red 1`);
      if (frame.size < 48) assert.deepEqual(colors, ["229,72,77"], `${frame.name}: no plate or ring`);
      else for (const color of ["246,244,240", "15,122,128", "184,39,122"]) assert.ok(colors.includes(color), `${frame.name}: ${color}`);
    }
  });
});
