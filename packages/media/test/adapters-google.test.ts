import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, MediaError } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64 } from './adapters-fixtures.ts';

const ok = (bytes: Uint8Array) => ({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: b64(bytes) } }] } }] });
behaviourSuite({
  id: 'google', model: 'gemini-image-test', refusal: true, edit: {},
  respond: (_call, ctx) => ctx.refuse ? { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } } : { status: 200, body: ok(ctx.bytes) },
});

test('google: Gemini generateContent with image output and an input image for edits', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, ok(png)));
  try {
    const a = createAdapter({ id: 'google', model: 'gemini-image-test', baseUrl: s.url });
    await a.generate({ prompt: 'tree', aspect: '16:9' });
    assert.equal(s.calls[0]!.path, '/models/gemini-image-test:generateContent');
    assert.deepEqual(JSON.parse(s.calls[0]!.body).generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } });
    await a.edit({ prompt: 'snow', referenceImages: [{ bytes: png, format: 'png' }] });
    assert.equal(JSON.parse(s.calls[1]!.body).contents[0].parts[1].inlineData.mimeType, 'image/png');
    assert.equal(a.capabilities().inpaint, false);
  } finally { await s.close(); }
});

test('google: finishReason IMAGE_SAFETY on a later batch item stops the batch and returns nothing', async () => {
  let n = 0;
  const s = await fakeServer((_c, res) => json(res, 200, ++n === 1 ? ok(png) : { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }));
  try { await assert.rejects(createAdapter({ id: 'google', model: 'm', baseUrl: s.url }).generate({ prompt: 'x', n: 2 }), (e: unknown) => e instanceof MediaError && e.code === 'content_policy'); assert.equal(n, 2); } finally { await s.close(); }
});
