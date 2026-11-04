// SPDX-License-Identifier: Apache-2.0
// Local q8 oracle: production catalogue pins, Rust tensors and independent PIL pixels.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const core = createRequire(join(request.repository, 'packages/core/package.json'));
const engine = createRequire(core.resolve('@cyb3rb1ade/plur1bus-memory/package.json'));
const entry = engine.resolve('onnxruntime-node');
assert.equal(JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8')).version,
  '1.30.0', 'oracle must use pinned ORT');
const ort = engine('onnxruntime-node');
for (const file of request.pins) {
  const path = join(request.directory, file.path);
  assert.equal((await stat(path)).size, file.bytes, `size: ${file.path}`);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), file.sha256,
    `SHA256: ${file.path}`);
}
const session = name => ort.InferenceSession.create(join(request.directory, 'onnx', name), {
  executionProviders: ['cpu'], intraOpNumThreads: 4, interOpNumThreads: 1, executionMode: 'sequential',
});
const f32 = async path => {
  const b = await readFile(path); assert.equal(b.length % 4, 0);
  return Float32Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
};
const float = (v, d) => new ort.Tensor('float32', Float32Array.from(v), d);
const integer = (v, d) => new ort.Tensor('int64', BigInt64Array.from(v, BigInt), d);
function cosine(a, b) {
  assert.equal(a.length, b.length); assert.ok(a.length);
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    assert.ok(Number.isFinite(a[i]) && Number.isFinite(b[i]));
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  assert.ok(aa > 0 && bb > 0); return dot / Math.sqrt(aa * bb);
}
const vision = await session('vision_encoder_quantized.onnx');
const audio = await session('audio_encoder_quantized.onnx');
const fusion = await session('model_quantized.onnx');
try {
  async function fuse(kind, features) {
    const rows = features.length / 512; assert.ok(Number.isInteger(rows) && rows > 0);
    // Pinned model BOS/media/EOS IDs; no ordinary text-tokenizer truncation.
    const [begin, soft, end] = kind === 'image' ? [255999, 258880, 258882] : [256000, 258881, 258883];
    const ids = [2, begin, ...Array(rows).fill(soft), end, 1];
    const inputs = { input_ids: integer(ids, [1, ids.length]),
      attention_mask: integer(ids.map(() => 1), [1, ids.length]) };
    for (const m of ['image', 'video', 'audio'])
      inputs[`${m}_features`] = float(m === kind ? features : [], [m === kind ? rows : 0, 512]);
    return (await fusion.run(inputs)).sentence_embedding.data;
  }
  const results = [];
  for (const c of request.cases) {
    const inputs = pixels => ({ pixel_values: float(pixels, [1, c.maxPatches, 768]),
      pixel_position_ids: integer(c.positions, [1, c.maxPatches, 2]) });
    const same = (await vision.run(inputs(await f32(c.pixels)))).image_features.data;
    const sameFinal = await fuse('image', same);
    const rgb = await readFile(c.resized);
    assert.equal(rgb.length, c.targetWidth * c.targetHeight * 3);
    const pixels = new Float32Array(c.maxPatches * 768); let at = 0;
    for (let y = 0; y < c.targetHeight; y += 16)
      for (let x = 0; x < c.targetWidth; x += 16)
        for (let dy = 0; dy < 16; dy++)
          for (let dx = 0; dx < 16; dx++)
            for (let ch = 0; ch < 3; ch++)
              pixels[at++] = rgb[((y + dy) * c.targetWidth + x + dx) * 3 + ch] / 255;
    const pil = (await vision.run(inputs(pixels))).image_features.data;
    const pilFinal = await fuse('image', pil);
    results.push({ name: c.name,
      sameInputFeatureCosine: cosine(same, await f32(c.features)),
      sameInputFinalCosine: cosine(sameFinal, await f32(c.vector)),
      sameDecodedFinalCosine: cosine(pilFinal, await f32(c.sameDecodedVector)),
      endToEndFinalCosine: cosine(pilFinal, await f32(c.vector)) });
  }
  const a = request.audio;
  const values = await audio.run({ input_features: float(await f32(a.features), [1, a.frames, 128]),
    input_features_mask: new ort.Tensor('bool', Uint8Array.from(a.mask, Number), [1, a.frames]) });
  const features = values.audio_features.data;
  process.stdout.write(JSON.stringify({ cases: results, audio: {
    featureCosine: cosine(features, await f32(a.encoderFeatures)),
    finalCosine: cosine(await fuse('audio', features), await f32(a.vector)),
    maskType: audio.inputMetadata.find(x => x.name === 'input_features_mask').type,
  } }));
} finally {
  await vision.release(); await audio.release(); await fusion.release();
}
