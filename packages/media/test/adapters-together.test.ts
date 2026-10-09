import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64 } from './adapters-fixtures.ts';

behaviourSuite({
  id: 'together', model: 'black-forest-labs/FLUX.1-schnell', urlOutput: true, refusal: true,
  respond: (_call, ctx) => ctx.refuse ? { status: 400, body: { error: { message: 'blocked by safety system' } } } : { status: 200, body: { data: [ctx.asUrl ? { url: ctx.url } : { b64_json: b64(ctx.bytes) }] } },
});

test('together: images API request carries size, seed, steps, guidance and negative prompt', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, { data: [{ b64_json: b64(png) }] }));
  try {
    await createAdapter({ id: 'together', model: 'black-forest-labs/FLUX.1-schnell', baseUrl: s.url }).generate({ prompt: 'tree', size: { width: 512, height: 512 }, seed: 9, steps: 4, guidance: 3, negativePrompt: 'fog', format: 'jpeg' });
    assert.deepEqual(JSON.parse(s.calls[0]!.body), { model: 'black-forest-labs/FLUX.1-schnell', prompt: 'tree', n: 1, response_format: 'base64', output_format: 'jpeg', width: 512, height: 512, seed: 9, steps: 4, guidance_scale: 3, negative_prompt: 'fog' });
  } finally { await s.close(); }
});
