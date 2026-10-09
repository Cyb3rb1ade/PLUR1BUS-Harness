import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, MediaError } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64 } from './adapters-fixtures.ts';

behaviourSuite({
  id: 'xai', model: 'grok-image-test', refusal: true, urlOutput: true,
  respond: (_call, ctx) => ({ status: 200, body: { data: [{ ...(ctx.asUrl ? { url: ctx.url } : { b64_json: b64(ctx.bytes) }), ...(ctx.refuse ? { respect_moderation: false } : {}) }] } }),
});

test('xai: image generation endpoint; edit is a false capability and is refused', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, { data: [{ b64_json: b64(png) }] }));
  try {
    const a = createAdapter({ id: 'xai', model: 'grok-image-test', baseUrl: s.url });
    assert.deepEqual(a.capabilities(), { generate: true, edit: false, inpaint: false });
    await a.generate({ prompt: 'tree', n: 2, aspect: '1:1' });
    assert.deepEqual(JSON.parse(s.calls[0]!.body), { model: 'grok-image-test', prompt: 'tree', n: 2, response_format: 'b64_json', aspect_ratio: '1:1' });
    await assert.rejects(a.edit({ prompt: 'x', referenceImages: [{ bytes: png, format: 'png' }] }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
  } finally { await s.close(); }
});
