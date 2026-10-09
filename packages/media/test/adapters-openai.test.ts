import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../src/index.ts';
import { behaviourSuite, png } from './adapters-suite.ts';
import { fakeServer, json, b64, makeJpeg } from './adapters-fixtures.ts';

behaviourSuite({
  id: 'openai', model: 'gpt-image-1', refusal: true, urlOutput: true, edit: {}, mask: true,
  respond: (_call, ctx) => ctx.refuse ? { status: 400, body: { error: { code: 'content_policy_violation', message: 'secret-123' } } } : { status: 200, body: { data: [ctx.asUrl ? { url: ctx.url } : { b64_json: b64(ctx.bytes) }] } },
});

test('openai: generate and masked edit use the Images API shapes', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, { data: [{ b64_json: b64(png) }] }));
  try {
    const a = createAdapter({ id: 'openai', model: 'gpt-image-1', baseUrl: s.url });
    await a.generate({ prompt: 'tree', size: { width: 1024, height: 1024 }, format: 'jpeg', n: 2 });
    assert.equal(s.calls[0]!.path, '/images/generations');
    assert.deepEqual(JSON.parse(s.calls[0]!.body), { model: 'gpt-image-1', prompt: 'tree', n: 2, output_format: 'jpeg', size: '1024x1024' });
    await a.edit({ prompt: 'snow', referenceImages: [{ bytes: png, format: 'png' }, { bytes: makeJpeg(), format: 'jpeg' }], mask: { bytes: png, format: 'png' } });
    const edit = s.calls[1]!; assert.equal(edit.path, '/images/edits'); assert.match(edit.headers['content-type']!, /^multipart\/form-data/);
    assert.equal((edit.body.match(/name="image\[\]"/g) ?? []).length, 2); assert.match(edit.body, /name="mask"; filename="mask\.png"/);
    assert.equal(a.capabilities().inpaint, true);
  } finally { await s.close(); }
});
