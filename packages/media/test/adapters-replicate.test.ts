import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, MediaError } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64, makeLeakyPng } from './adapters-fixtures.ts';
import type { RecordedCall } from './adapters-fixtures.ts';

const schemaOf = (props: Record<string, unknown>) => ({ components: { schemas: { Input: { properties: props } } } });
const PROPS = { prompt: { type: 'string' }, seed: { type: 'integer' }, image: { type: 'string' }, mask: { type: 'string' }, num_outputs: { maximum: 4 }, output_format: { enum: ['webp', 'jpg', 'png'] } };
const modelDoc = (props: Record<string, unknown> = PROPS) => ({ latest_version: { id: 'ver1', openapi_schema: schemaOf(props) } });
const isSchema = (c: RecordedCall) => c.method === 'GET' && /^\/models\/[^/]+\/[^/]+(\/versions\/\w+)?$/.test(c.path);

behaviourSuite({
  id: 'replicate', model: 'acme/painter', refusal: true, urlOutput: true, edit: {}, mask: true,
  respond: (call, ctx) => {
    if (isSchema(call)) return { status: 200, body: modelDoc() };
    if (ctx.refuse) return { status: 200, body: { id: 'p1', status: 'failed', error: 'content policy violation secret-123' } };
    return { status: 200, body: { id: 'p1', status: 'succeeded', output: [ctx.asUrl ? ctx.url : `data:image/png;base64,${b64(ctx.bytes)}`] } };
  },
});

test('replicate: create → poll → output reports queued/running/downloading progress and a durable checkpoint', async () => {
  const states = ['starting', 'processing', 'succeeded']; let polls = 0;
  const s = await fakeServer((c, res) => {
    if (isSchema(c)) return json(res, 200, modelDoc());
    if (c.method === 'POST') return json(res, 201, { id: 'p1', status: 'starting' });
    const status = states[Math.min(polls++, 2)];
    json(res, 200, { id: 'p1', status, ...(status === 'succeeded' ? { output: [`data:image/png;base64,${b64(png)}`] } : {}) });
  });
  try {
    const progress: [number, string | undefined][] = []; const tokens: unknown[] = [];
    const a = createAdapter({ id: 'replicate', model: 'acme/painter', baseUrl: s.url, pollMs: 1 });
    const out = await a.generate({ prompt: 'tree', seed: 4 }, { onProgress: p => { progress.push([p.fraction, p.stage]); }, onCheckpoint: async t => { tokens.push(t); } });
    assert.equal(out.files.length, 1); assert.deepEqual(tokens, [{ id: 'p1', model: 'acme/painter' }]);
    assert.deepEqual(progress.map(p => p[1]), ['running', 'queued', 'running', 'downloading']);
    assert.deepEqual(JSON.parse(s.calls.find(c => c.method === 'POST')!.body), { input: { prompt: 'tree', seed: 4 } });
  } finally { await s.close(); }
});

test('replicate: aborting a running prediction calls the cancel endpoint and reports cancelled', async () => {
  const s = await fakeServer((c, res) => isSchema(c) ? json(res, 200, modelDoc()) : c.path.endsWith('/cancel') ? json(res, 200, { id: 'p1', status: 'canceled' }) : json(res, c.method === 'POST' ? 201 : 200, { id: 'p1', status: 'processing' }));
  try {
    const c = new AbortController();
    const a = createAdapter({ id: 'replicate', model: 'acme/painter', baseUrl: s.url, pollMs: 1 });
    await assert.rejects(a.generate({ prompt: 'tree' }, { signal: c.signal, onProgress: p => { if (p.stage === 'running' && p.fraction === 0.5) c.abort(); } }), (e: unknown) => e instanceof MediaError && e.code === 'cancelled');
    assert.ok(s.calls.some(x => x.method === 'POST' && x.path === '/predictions/p1/cancel'));
  } finally { await s.close(); }
});

test('replicate: edit maps reference and mask onto the model\'s own input names, EXIF-free', async () => {
  const s = await fakeServer((c, res) => isSchema(c) ? json(res, 200, modelDoc()) : json(res, 200, { id: 'p1', status: 'succeeded', output: [`data:image/png;base64,${b64(png)}`] }));
  try {
    await createAdapter({ id: 'replicate', model: 'acme/painter', baseUrl: s.url }).edit({ prompt: 'snow', n: 2, format: 'jpeg', referenceImages: [{ bytes: makeLeakyPng(), format: 'png' }], mask: { bytes: png, format: 'png' } });
    const post = s.calls.find(c => c.method === 'POST')!; assert.equal(post.path, '/models/acme/painter/predictions');
    const input = JSON.parse(post.body).input as Record<string, unknown>;
    assert.equal(input.num_outputs, 2); assert.equal(input.output_format, 'jpg'); assert.match(String(input.image), /^data:image\/png;base64,/); assert.match(String(input.mask), /^data:image\/png;base64,/);
  } finally { await s.close(); }
});

test('replicate: a pinned owner/name:version uses the version document and the generic predictions endpoint', async () => {
  const s = await fakeServer((c, res) => c.path === '/models/acme/painter/versions/abc123' ? json(res, 200, { id: 'abc123', openapi_schema: schemaOf(PROPS) }) : json(res, 200, { id: 'p1', status: 'succeeded', output: [`data:image/png;base64,${b64(png)}`] }));
  try {
    await createAdapter({ id: 'replicate', model: 'acme/painter:abc123', baseUrl: s.url }).generate({ prompt: 'tree' });
    const post = s.calls.find(c => c.method === 'POST')!; assert.equal(post.path, '/predictions'); assert.deepEqual(JSON.parse(post.body), { version: 'abc123', input: { prompt: 'tree' } });
  } finally { await s.close(); }
});

test('replicate: parameters the model does not declare are refused before submission; the schema is fetched once', async () => {
  const s = await fakeServer((c, res) => isSchema(c) ? json(res, 200, modelDoc({ prompt: {} })) : json(res, 200, { id: 'p1', status: 'succeeded', output: [`data:image/png;base64,${b64(png)}`] }));
  try {
    const a = createAdapter({ id: 'replicate', model: 'acme/painter', baseUrl: s.url });
    await assert.rejects(a.generate({ prompt: 'tree', seed: 1 }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
    await assert.rejects(a.edit({ prompt: 'tree', referenceImages: [{ bytes: png, format: 'png' }] }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
    await a.generate({ prompt: 'tree' });
    assert.equal(s.calls.filter(isSchema).length, 1); assert.equal(s.calls.filter(c => c.method === 'POST').length, 1);
  } finally { await s.close(); }
});

test('replicate: a failed schema lookup is not cached, and a model without a published schema uses the FLUX schnell profile', async () => {
  let fail = true;
  const s = await fakeServer((c, res) => isSchema(c) ? (fail ? json(res, 500, {}) : json(res, 200, { latest_version: {} })) : json(res, 200, { id: 'p1', status: 'succeeded', output: [`data:image/png;base64,${b64(png)}`] }));
  try {
    const a = createAdapter({ id: 'replicate', model: 'acme/painter', baseUrl: s.url, retry: { maxAttempts: 1 } });
    await assert.rejects(a.generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === 'backend_unavailable');
    fail = false; await a.generate({ prompt: 'tree', steps: 4 });
    assert.deepEqual(JSON.parse(s.calls.find(c => c.method === 'POST')!.body).input, { prompt: 'tree', num_inference_steps: 4, output_format: 'png', num_outputs: 1 });
    await assert.rejects(a.edit({ prompt: 'x', referenceImages: [{ bytes: png, format: 'png' }] }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
  } finally { await s.close(); }
});
