import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, HttpImageAdapter, MediaError } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64 } from './adapters-fixtures.ts';

behaviourSuite({
  id: 'draw-things', model: 'sd_v1.5_f16.ckpt', edit: {},
  respond: (_call, ctx) => ({ status: 200, body: { images: [b64(ctx.bytes)] } }),
});

test('draw-things: A1111-compatible txt2img/img2img; masks are refused because the app ignores them', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, { images: [b64(png)] }));
  try {
    const a = createAdapter({ id: 'draw-things', model: 'sd.ckpt', baseUrl: s.url });
    assert.deepEqual(a.capabilities(), { generate: true, edit: true, inpaint: false });
    await a.generate({ prompt: 'tree', negativePrompt: 'fog', size: { width: 512, height: 512 }, seed: 1, steps: 8, guidance: 5, n: 2 });
    assert.equal(s.calls[0]!.path, '/sdapi/v1/txt2img'); assert.deepEqual(JSON.parse(s.calls[0]!.body), { model: 'sd.ckpt', prompt: 'tree', negative_prompt: 'fog', batch_size: 2, width: 512, height: 512, seed: 1, steps: 8, cfg_scale: 5 });
    await a.edit({ prompt: 'snow', referenceImages: [{ bytes: png, format: 'png' }] });
    assert.equal(s.calls[1]!.path, '/sdapi/v1/img2img'); assert.equal(JSON.parse(s.calls[1]!.body).init_images.length, 1);
  } finally { await s.close(); }
});

test('draw-things: an unreachable API is reported as API-off or not-installed with a hint, never as a bare failure', async () => {
  const gone = await fakeServer((_c, res) => json(res, 200, {})); const url = gone.url; await gone.close();
  await assert.rejects(createAdapter({ id: 'draw-things', model: 'm', baseUrl: url }).generate({ prompt: 'x' }), (e: unknown) => {
    assert.ok(e instanceof MediaError); assert.equal(e.code, 'backend_unavailable');
    assert.match((e as { reason?: string }).reason ?? '', /^drawthings_(api_off|not_installed)$/); assert.match(e.message, /Draw Things/); return true;
  });
  const up = await fakeServer((_c, res) => json(res, 200, {}));
  try { assert.deepEqual(await new HttpImageAdapter({ id: 'draw-things', model: 'm', baseUrl: up.url }).probe(), { state: 'running' }); } finally { await up.close(); }
  await assert.rejects(new HttpImageAdapter({ id: 'openai', model: 'm' }).probe(), MediaError);
});

test('draw-things: a LAN or Tailscale host needs an explicit opt-in, never takes a key, and shows up as the result origin', async () => {
  assert.throws(() => createAdapter({ id: 'draw-things', model: 'm', baseUrl: 'http://192.168.1.50:7860' }), MediaError);
  assert.throws(() => createAdapter({ id: 'draw-things', model: 'm', baseUrl: 'http://192.168.1.50:7860', allowLan: true, apiKey: 'dummy' }), MediaError);
  assert.throws(() => createAdapter({ id: 'draw-things', model: 'm', baseUrl: 'https://example.com', allowLan: true }), MediaError);
  const lan = createAdapter({ id: 'draw-things', model: 'm', baseUrl: 'http://192.168.1.50:7860', allowLan: true }); assert.equal(lan.id, 'draw-things');
});
