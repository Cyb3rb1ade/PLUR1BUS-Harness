import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, HttpImageAdapter, MediaError } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64 } from './adapters-fixtures.ts';

const url = (bytes: Uint8Array) => `data:image/png;base64,${b64(bytes)}`;
behaviourSuite({
  id: 'openrouter', model: 'google/gemini-image-test', refusal: true, edit: {},
  respond: (_call, ctx) => ctx.refuse ? { status: 200, body: { choices: [{ finish_reason: 'content_filter' }] } } : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { images: [{ image_url: { url: url(ctx.bytes) } }] } }], usage: { cost: 0.04 } } },
});

const models = { data: [
  { id: 'google/gemini-image-test', name: 'Gemini', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] }, pricing: { image: '0.039' } },
  { id: 'acme/chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
] };

test('openrouter: image-output models come from the models endpoint, filtered and cached for the TTL', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, models));
  try {
    const a = new HttpImageAdapter({ id: 'openrouter', model: 'google/gemini-image-test', baseUrl: s.url });
    const list = await a.listModels(); assert.deepEqual(list.map(m => m.id), ['google/gemini-image-test']); assert.equal(list[0]!.edit, true); assert.equal(list[0]!.costPerImageUsd, 0.039);
    await a.listModels(); assert.equal(s.calls.length, 1); assert.equal(s.calls[0]!.path, '/models?output_modalities=image');
  } finally { await s.close(); }
  await assert.rejects(new HttpImageAdapter({ id: 'openai', model: 'm' }).listModels(), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
});

test('openrouter: cost comes from the usage field and reaches the result; unknown cost stays absent', async () => {
  let withCost = true;
  const s = await fakeServer((_c, res) => json(res, 200, { choices: [{ message: { images: [{ image_url: { url: url(png) } }] } }], ...(withCost ? { usage: { cost: 0.0312 } } : {}) }));
  try {
    const a = createAdapter({ id: 'openrouter', model: 'm', baseUrl: s.url });
    assert.equal((await a.generate({ prompt: 'x' })).metadata.costUsd, 0.0312);
    withCost = false; assert.equal('costUsd' in (await a.generate({ prompt: 'x' })).metadata, false);
    const two = await createAdapter({ id: 'openrouter', model: 'm', baseUrl: s.url }).generate({ prompt: 'x', n: 2 }); assert.equal(two.files.length, 2);
  } finally { await s.close(); }
});
