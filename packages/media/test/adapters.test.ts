import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter, MediaError, egressHosts, AdapterRegistry } from '../src/index.ts';
const b64 = Buffer.from('image').toString('base64');
const ids = ['openrouter', 'replicate', 'fal', 'together', 'openai', 'google', 'xai', 'draw-things'] as const;
async function server(body: unknown, status = 200, delay = 0) {
  const calls: { path: string; body: string; auth: string | undefined }[] = [];
  const s = createServer(async (req, res) => {
    let input = ''; for await (const b of req) input += b;
    calls.push({ path: req.url!, body: input, auth: req.headers.authorization });
    if (delay) await new Promise(r => setTimeout(r, delay));
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, calls, close: () => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }) };
}
function response(id: string) {
  if (id === 'openrouter') return { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }] };
  if (id === 'google') return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }] };
  if (id === 'replicate') return { id: 'prediction-1', status: 'succeeded', output: [`data:image/png;base64,${b64}`] };
  if (id === 'fal') return { request_id: 'request-1', status: 'COMPLETED', images: [{ url: `data:image/png;base64,${b64}` }] };
  if (id === 'draw-things') return { images: [b64] };
  return { data: [{ b64_json: b64 }] };
}
for (const id of ids) {
  test(`${id}: success and partial results use expected protocol`, async () => {
    const s = await server(response(id));
    try {
      const a = createAdapter({ id, model: 'test', baseUrl: s.url, pollMs: 1 });
      const checkpoints: unknown[] = [];
      const out = await a.generate({ prompt: 'tree', n: 2 }, { onCheckpoint: async t => { checkpoints.push(t); } });
      assert.equal(Buffer.from(out.files[0]!.bytes).toString(), 'image'); assert.equal(out.partial, !['openrouter', 'google'].includes(id));
      assert.equal(out.metadata.adapter, id); assert.equal(s.calls[0]!.auth, undefined);
      assert.match(s.calls[0]!.body, /tree/);
      if (id === 'replicate' || id === 'fal') assert.equal(checkpoints.length, 1);
    } finally { await s.close(); }
  });
  for (const [status, body, code] of [[400, { error: { code: 'content_policy_violation', message: 'secret-123' } }, 'content_policy'], [429, { error: 'secret-123' }, 'quota'], [413, {}, 'too_large'], [503, {}, 'backend_unavailable']] as const) {
    test(`${id}: ${code}, remote secrets never escape`, async () => {
      const s = await server(body, status);
      try { await assert.rejects(createAdapter({ id, model: 'test', baseUrl: s.url }).generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === code && !String(e).includes('secret-123')); } finally { await s.close(); }
    });
  }
  test(`${id}: timeout and abort`, async () => {
    const s = await server(response(id), 200, 100);
    try {
      await assert.rejects(createAdapter({ id, model: 'test', baseUrl: s.url, timeoutMs: 10 }).generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === 'timeout');
      const c = new AbortController(); c.abort('secret-123');
      await assert.rejects(createAdapter({ id, model: 'test', baseUrl: s.url }).generate({ prompt: 'tree' }, { signal: c.signal }), (e: unknown) => e instanceof MediaError && e.code === 'cancelled');
    } finally { await s.close(); }
  });
}
test('registry capability selection and egress are configuration driven', () => {
  const configs = [{ id: 'openai' as const, model: 'gpt-image-1' }, { id: 'draw-things' as const, model: 'sd', baseUrl: 'http://127.0.0.1:7860' }];
  const r = new AdapterRegistry(configs); assert.equal(r.select('inpaint', ['openai']).id, 'openai');
  assert.ok(egressHosts(configs).includes('api.openai.com'));
  assert.throws(() => r.select('upscale'));
  assert.throws(() => createAdapter({ id: 'draw-things', model: 'sd', baseUrl: 'https://example.com' }));
  assert.throws(() => createAdapter({ id: 'openai', model: 'sd', baseUrl: 'http://127.0.0.1:80', apiKey: 'secret-123' }));
});
for (const id of ['openai', 'google', 'openrouter', 'draw-things'] as const) {
  test(`${id}: edit references and capability refusals`, async () => {
    const s = await server(response(id)); const ref = { bytes: Buffer.from('reference'), format: 'png' as const };
    try {
      const a = createAdapter({ id, model: 'test', baseUrl: s.url });
      await a.edit({ prompt: 'edit tree', referenceImages: [ref], ...(id === 'openai' ? { mask: ref, format: 'jpeg' as const, size: { width: 1024, height: 1024 } } : {}) });
      assert.match(s.calls[0]!.path, id === 'openai' ? /images\/edits/ : id === 'draw-things' ? /img2img/ : id === 'google' ? /generateContent/ : /chat\/completions/);
      assert.match(s.calls[0]!.body, id === 'openai' ? /name="mask"/ : id === 'draw-things' ? /init_images/ : id === 'google' ? /inlineData/ : /image_url/);
      await assert.rejects(a.edit({ prompt: 'edit' })); await assert.rejects(a.generate({ prompt: 'tree', seed: NaN }));
      await assert.rejects(a.generate({ prompt: 'tree', referenceImages: [ref] }));
      if (id !== 'openai') await assert.rejects(a.edit({ prompt: 'edit', referenceImages: [ref], mask: ref }));
      if (id === 'draw-things') await assert.rejects(a.edit({ prompt: 'edit', referenceImages: [ref, ref] }));
      if (id === 'openai') await assert.rejects(a.generate({ prompt: 'tree', seed: 4 }));
    } finally { await s.close(); }
  });
}
test('polling restart, failures and cancellation never submit twice', async () => {
  for (const id of ['replicate', 'fal'] as const) {
    const s = await server(response(id));
    try {
      const a = createAdapter({ id, model: 'test', baseUrl: s.url });
      assert.ok(a.resume); await a.resume!({ prompt: 'tree' }, { resume: { id: 'existing', model: 'test' } });
      assert.ok(s.calls.every(c => !c.path.endsWith('predictions') && c.path !== '/test'));
      await assert.rejects(a.resume!({ prompt: 'tree' }, { resume: { id: '../bad', model: 'test' } }));
      await assert.rejects(a.resume!({ prompt: 'tree' }, { resume: { id: 'existing', model: 'different' } }));
      await assert.rejects(a.edit({ prompt: 'tree', referenceImages: [{ bytes: Buffer.from('ref'), format: 'png' }] }));
    } finally { await s.close(); }
    const pending = await server({ id: 'remote', request_id: 'remote', status: 'IN_PROGRESS' });
    try {
      const c = new AbortController();
      const a = createAdapter({ id, model: 'test', baseUrl: pending.url, pollMs: 1 });
      await assert.rejects(a.generate({ prompt: 'tree' }, { signal: c.signal, onProgress: p => { if (p.fraction === 0.5) c.abort(); } }), (e: unknown) => e instanceof MediaError && e.code === 'cancelled');
      assert.ok(pending.calls.some(c => c.path.endsWith('/cancel')));
    } finally { await pending.close(); }
    const failed = await server({ status: 'failed', error: 'content policy secret-123' });
    try { await assert.rejects(createAdapter({ id, model: 'test', baseUrl: failed.url }).resume!({ prompt: 'tree' }, { resume: { id: 'existing', model: 'test' } }), (e: unknown) => e instanceof MediaError && e.code === 'content_policy'); } finally { await failed.close(); }
  }
});
test('empty, invalid and moderated success responses fail closed', async () => {
  for (const [id, body] of [['openai', {}], ['replicate', { id: 12 }], ['fal', { has_nsfw_concepts: [true], request_id: 'one', status: 'COMPLETED' }], ['google', { candidates: [{ finishReason: 'SAFETY' }] }], ['openrouter', { choices: [{ finish_reason: 'content_filter' }] }]] as const) {
    const s = await server(body); try { await assert.rejects(createAdapter({ id, model: 'test', baseUrl: s.url }).generate({ prompt: 'tree' }), MediaError); } finally { await s.close(); }
  }
});
test('download URLs never receive authorization, deny redirects and unlisted hosts', async () => {
  let url = ''; const calls: string[] = [];
  const s = createServer(async (req, res) => {
    calls.push(req.url!); assert.equal(req.headers.authorization, undefined);
    if (req.url === '/images/generations') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ url: `${url}/image` }] })); }
    else { res.setHeader('content-type', 'image/jpeg'); res.end('image'); }
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try { const out = await createAdapter({ id: 'openai', model: 'test', baseUrl: url }).generate({ prompt: 'tree' }); assert.equal(out.files[0]!.format, 'jpeg'); assert.equal(calls.length, 2); } finally { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  const blocked = await server({ data: [{ url: 'https://unlisted.invalid/image?secret=123' }] });
  try { await assert.rejects(createAdapter({ id: 'openai', model: 'test', baseUrl: blocked.url }).generate({ prompt: 'tree' }), MediaError); } finally { await blocked.close(); }
});
test('request fields map to provider-specific schemas', async () => {
  for (const id of ['together', 'draw-things', 'fal', 'replicate', 'xai', 'google', 'openrouter'] as const) {
    const s = await server(response(id));
    try {
      const a = createAdapter({ id, model: 'test', baseUrl: s.url });
      await a.generate({ prompt: 'tree', ...(id === 'together' || id === 'draw-things' || id === 'fal' ? { size: { width: 512, height: 512 }, seed: 42, steps: 4, guidance: 3 } : id === 'replicate' ? { seed: 42, steps: 4, aspect: '1:1', format: 'png' as const } : { aspect: '16:9' }), ...(id === 'together' ? { negativePrompt: 'fog', format: 'jpeg' as const } : {}) });
      const body = JSON.parse(s.calls[0]!.body) as Record<string, unknown>;
      if (id === 'together') { assert.equal(body.response_format, 'base64'); assert.equal(body.guidance_scale, 3); }
      if (id === 'fal') { assert.equal(body.enable_safety_checker, true); assert.deepEqual(body.image_size, { width: 512, height: 512 }); }
      if (id === 'replicate') assert.equal((body.input as Record<string, unknown>).num_outputs, 1);
      if (id === 'draw-things') assert.equal(body.cfg_scale, 3);
    } finally { await s.close(); }
  }
});
test('registry fallback stops on moderation and keeps configuration order', async () => {
  const down = await server({}, 503); const ok = await server(response('together')); const policy = await server({ error: { code: 'content_policy' } }, 400);
  try {
    const r = new AdapterRegistry([{ id: 'openai', model: 'test', baseUrl: down.url }, { id: 'together', model: 'test', baseUrl: ok.url }]);
    assert.equal((await r.generate({ prompt: 'tree' }, ['missing', 'openai', 'together'])).metadata.adapter, 'together');
    assert.equal(r.capabilities().openai!.inpaint, true);
    await assert.rejects(r.generate({ prompt: 'tree' }, []));
    assert.throws(() => new AdapterRegistry([{ id: 'openai', model: 'a' }, { id: 'openai', model: 'b' }]));
    const p = new AdapterRegistry([{ id: 'openai', model: 'test', baseUrl: policy.url }, { id: 'together', model: 'test', baseUrl: ok.url }]);
    const count = ok.calls.length; await assert.rejects(p.generate({ prompt: 'tree' }, ['openai', 'together'])); assert.equal(ok.calls.length, count);
    assert.deepEqual(egressHosts([{ id: 'coreml-local', model: 'sd', helperPath: process.execPath }]), []);
  } finally { await down.close(); await ok.close(); await policy.close(); }
});
for (const id of ['google', 'openrouter'] as const) {
  test(`${id}: batch returns partial transport results, but never bypasses moderation`, async () => {
    for (const policy of [false, true]) {
      let calls = 0;
      const s = createServer(async (req, res) => {
        for await (const _chunk of req) { /* drain body */ }
        calls++;
        res.writeHead(calls === 1 ? 200 : policy ? 400 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(calls === 1 ? response(id) : policy ? { error: { code: 'content_policy' } } : {}));
      });
      await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      try {
        const a = createAdapter({ id, model: 'test', baseUrl: url });
        if (policy) await assert.rejects(a.generate({ prompt: 'tree', n: 2 }), (e: unknown) => e instanceof MediaError && e.code === 'content_policy');
        else { const out = await a.generate({ prompt: 'tree', n: 2 }); assert.equal(out.partial, true); assert.equal(out.files.length, 1); }
        assert.equal(calls, 2);
      } finally { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
    }
  });
}
test('xAI moderation flags and Gemini image safety reasons are policy failures', async () => {
  for (const [id, body] of [['xai', { data: [{ b64_json: b64, respect_moderation: false }] }], ['google', { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }]] as const) {
    const s = await server(body); try { await assert.rejects(createAdapter({ id, model: 'test', baseUrl: s.url }).generate({ prompt: 'tree' }), (e: unknown) => e instanceof MediaError && e.code === 'content_policy'); } finally { await s.close(); }
  }
});
test('nested size fields cannot override provider model or safety settings', async () => {
  for (const id of ['together', 'draw-things'] as const) {
    const s = await server(response(id));
    const size = { width: 512, height: 512, disable_safety_checker: true, model: 'injected-model' };
    try { await assert.rejects(createAdapter({ id, model: 'test', baseUrl: s.url }).generate({ prompt: 'tree', size }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter'); assert.equal(s.calls.length, 0); }
    finally { await s.close(); }
  }
});
