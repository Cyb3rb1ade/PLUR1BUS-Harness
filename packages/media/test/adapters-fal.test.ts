import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, MediaError } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64, makeLeakyPng } from './adapters-fixtures.ts';

const MODEL = 'fal-ai/flux-lora/inpainting';
behaviourSuite({
  id: 'fal', model: MODEL, refusal: true, urlOutput: true, edit: {}, mask: true,
  respond: (call, ctx) => {
    if (call.method === 'POST') return { status: 200, body: { request_id: 'r1', status: 'IN_QUEUE' } };
    if (call.path.endsWith('/status')) return { status: 200, body: { status: 'COMPLETED' } };
    return { status: 200, body: { images: [{ url: ctx.asUrl ? ctx.url : `data:image/png;base64,${b64(ctx.bytes)}` }], ...(ctx.refuse ? { has_nsfw_concepts: [true] } : {}) } };
  },
});

test('fal: submit → status → result reports queued then running progress and a checkpoint', async () => {
  const statuses = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']; let polls = 0;
  const s = await fakeServer((c, res) => {
    if (c.method === 'POST') return json(res, 200, { request_id: 'r1' });
    if (c.path.endsWith('/status')) return json(res, 200, { status: statuses[Math.min(polls++, 2)] });
    json(res, 200, { images: [{ url: `data:image/png;base64,${b64(png)}` }] });
  });
  try {
    const progress: (string | undefined)[] = []; const tokens: unknown[] = [];
    const out = await createAdapter({ id: 'fal', model: MODEL, baseUrl: s.url, pollMs: 1 }).generate({ prompt: 'tree' }, { onProgress: p => { progress.push(p.stage); }, onCheckpoint: async t => { tokens.push(t); } });
    assert.equal(out.files.length, 1); assert.deepEqual(tokens, [{ id: 'r1', model: MODEL }]); assert.deepEqual(progress, ['running', 'queued', 'running', 'downloading']);
    assert.deepEqual(s.calls.map(c => `${c.method} ${c.path}`), [`POST /${MODEL}`, `GET /${MODEL}/requests/r1/status`, `GET /${MODEL}/requests/r1/status`, `GET /${MODEL}/requests/r1/status`, `GET /${MODEL}/requests/r1`]);
  } finally { await s.close(); }
});

test('fal: aborting a queued job sends the cancel request and reports cancelled', async () => {
  const s = await fakeServer((c, res) => c.method === 'POST' || c.method === 'PUT' ? json(res, 200, { request_id: 'r1' }) : json(res, 200, { status: 'IN_PROGRESS' }));
  try {
    const c = new AbortController();
    await assert.rejects(createAdapter({ id: 'fal', model: MODEL, baseUrl: s.url, pollMs: 1 }).generate({ prompt: 'tree' }, { signal: c.signal, onProgress: p => { if (p.fraction === 0.5) c.abort(); } }), (e: unknown) => e instanceof MediaError && e.code === 'cancelled');
    assert.ok(s.calls.some(x => x.method === 'PUT' && x.path === `/${MODEL}/requests/r1/cancel`));
  } finally { await s.close(); }
});

test('fal: edit models receive image_url and mask_url as data URIs without metadata; extra references are refused', async () => {
  const s = await fakeServer((c, res) => c.method === 'POST' ? json(res, 200, { request_id: 'r1' }) : c.path.endsWith('/status') ? json(res, 200, { status: 'COMPLETED' }) : json(res, 200, { images: [{ url: `data:image/png;base64,${b64(png)}` }] }));
  try {
    const a = createAdapter({ id: 'fal', model: MODEL, baseUrl: s.url, pollMs: 1 });
    assert.deepEqual(a.capabilities(), { generate: true, edit: true, inpaint: true });
    await a.edit({ prompt: 'snow', seed: 3, referenceImages: [{ bytes: makeLeakyPng(), format: 'png' }], mask: { bytes: png, format: 'png' } });
    const body = JSON.parse(s.calls[0]!.body) as Record<string, unknown>;
    assert.match(String(body.image_url), /^data:image\/png;base64,/); assert.match(String(body.mask_url), /^data:image\/png;base64,/); assert.equal(body.seed, 3); assert.equal(body.enable_safety_checker, true);
    const before = s.calls.length;
    await assert.rejects(a.edit({ prompt: 'x', referenceImages: [{ bytes: png, format: 'png' }, { bytes: png, format: 'png' }] }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter'); assert.equal(s.calls.length, before);
    await a.generate({ prompt: 'plain' }); assert.equal('image_url' in JSON.parse(s.calls[before]!.body), false);
  } finally { await s.close(); }
});
