import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaError } from '../src/index.ts';
import { parseModelRef, parseInputSchema, mapReplicateInput } from '../src/adapters/replicate-schema.ts';
import { ModelCatalog, parseImageModels } from '../src/adapters/openrouter-models.ts';
import { probeDrawThings } from '../src/adapters/drawthings-probe.ts';
import { Limiter } from '../src/adapters/_shared/limiter.ts';
import { verifyOutput } from '../src/adapters/_shared/images.ts';
import { makePng, makeJpeg, fakeServer, json } from './adapters-fixtures.ts';

const ref = { bytes: makePng(), format: 'png' as const };
const modelJson = (props: Record<string, unknown>) => ({ latest_version: { id: 'v1', openapi_schema: { components: { schemas: { Input: { properties: props } } } } } });

test('Replicate model references: owner/name with an optional pinned version', () => {
  assert.deepEqual(parseModelRef('black-forest-labs/flux-schnell'), { owner: 'black-forest-labs', name: 'flux-schnell' });
  assert.deepEqual(parseModelRef('acme/model:abc123'), { owner: 'acme', name: 'model', version: 'abc123' });
  for (const bad of ['test', 'a/b/c', 'a/b:', ':v', 'a/b:v:w', '../x', 'a/ b']) assert.equal(parseModelRef(bad), undefined, bad);
});

test('input schema is read from model and version documents; missing schemas are undefined', () => {
  assert.deepEqual(Object.keys(parseInputSchema(modelJson({ prompt: { type: 'string' } }))!), ['prompt']);
  assert.deepEqual(Object.keys(parseInputSchema({ openapi_schema: { components: { schemas: { Input: { properties: { seed: {} } } } } } })!), ['seed']);
  for (const none of [{}, { latest_version: {} }, { latest_version: { openapi_schema: { components: { schemas: { Input: {} } } } } }, { id: 'prediction-1', status: 'succeeded' }]) assert.equal(parseInputSchema(none as never), undefined);
});

test('request fields map onto whatever names the model declares', () => {
  const flux = parseInputSchema(modelJson({ prompt: {}, seed: {}, num_inference_steps: { maximum: 50 }, guidance: {}, aspect_ratio: { enum: ['1:1', '16:9'] }, num_outputs: { maximum: 4 }, output_format: { enum: ['webp', 'jpg', 'png'] }, image: { type: 'string', format: 'uri' }, mask: {} }))!;
  assert.deepEqual(mapReplicateInput({ prompt: 'p', seed: 5, steps: 4, guidance: 2, aspect: '16:9', n: 2, format: 'jpeg' }, flux, false), { prompt: 'p', seed: 5, num_inference_steps: 4, guidance: 2, aspect_ratio: '16:9', num_outputs: 2, output_format: 'jpg' });
  const edit = mapReplicateInput({ prompt: 'p', referenceImages: [ref], mask: ref }, flux, true) as { image: string; mask: string };
  assert.match(edit.image, /^data:image\/png;base64,/); assert.match(edit.mask, /^data:image\/png;base64,/);
  const sd = parseInputSchema(modelJson({ prompt: {}, negative_prompt: {}, width: {}, height: {}, guidance_scale: {}, steps: {}, input_images: { type: 'array', items: { type: 'string' } }, mask_image: {} }))!;
  assert.deepEqual(mapReplicateInput({ prompt: 'p', negativePrompt: 'fog', size: { width: 512, height: 768 }, guidance: 7, steps: 20 }, sd, false), { prompt: 'p', negative_prompt: 'fog', width: 512, height: 768, guidance_scale: 7, steps: 20 });
  const many = mapReplicateInput({ prompt: 'p', referenceImages: [ref, ref], mask: ref }, sd, true) as { input_images: string[]; mask_image: string };
  assert.equal(many.input_images.length, 2); assert.match(many.mask_image, /^data:/);
});

test('fields the model cannot take, values outside its declared range, and unknown enums are refused before submission', () => {
  const minimal = parseInputSchema(modelJson({ prompt: {}, aspect_ratio: { enum: ['1:1'] }, num_inference_steps: { maximum: 4 }, image: {} }))!;
  const refuse = (req: Parameters<typeof mapReplicateInput>[0], edit = false) => assert.throws(() => mapReplicateInput(req, minimal, edit), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter');
  refuse({ prompt: 'p', seed: 1 }); refuse({ prompt: 'p', n: 2 }); refuse({ prompt: 'p', guidance: 3 }); refuse({ prompt: 'p', negativePrompt: 'x' });
  refuse({ prompt: 'p', size: { width: 64, height: 64 } }); refuse({ prompt: 'p', aspect: '16:9' }); refuse({ prompt: 'p', steps: 9 }); refuse({ prompt: 'p', format: 'webp' });
  refuse({ prompt: 'p', referenceImages: [ref, ref] }, true); refuse({ prompt: 'p', referenceImages: [ref], mask: ref }, true);
  assert.throws(() => mapReplicateInput({ prompt: 'p' }, parseInputSchema(modelJson({ text: {} }))!, false), MediaError);
});

const modelList = { data: [
  { id: 'google/gemini-image', name: 'Gemini Image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] }, pricing: { prompt: '0', image: '0.039' } },
  { id: 'acme/text-only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  { id: 'acme/draw', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  { id: 5 }, null, { id: 'broken' },
] };

test('OpenRouter model list keeps image-output models and derives edit support from input modalities', () => {
  const models = parseImageModels(modelList);
  assert.deepEqual(models.map(m => [m.id, m.edit]), [['google/gemini-image', true], ['acme/draw', false]]);
  assert.equal(models[0]!.costPerImageUsd, 0.039); assert.equal(models[1]!.costPerImageUsd, undefined);
  assert.deepEqual(parseImageModels({}), []);
});

test('the catalog caches for its TTL, refreshes after it, and a failed refresh keeps the last good list', async () => {
  let now = 1000; let calls = 0; let fail = false;
  const catalog = new ModelCatalog(async () => { calls++; if (fail) throw new MediaError('backend_unavailable'); return modelList; }, { ttlMs: 60_000, now: () => now });
  const signal = new AbortController().signal;
  assert.equal((await catalog.list(signal)).length, 2); await catalog.list(signal); assert.equal(calls, 1);
  now += 59_999; await catalog.list(signal); assert.equal(calls, 1);
  now += 2; fail = true; assert.equal((await catalog.list(signal)).length, 2); assert.equal(calls, 2); // stale list survives an outage
  assert.equal((await catalog.find('acme/draw', signal))?.edit, false); assert.equal(await catalog.find('nope', signal), undefined);
  catalog.invalidate(); await assert.rejects(catalog.list(signal), MediaError);
  assert.throws(() => new ModelCatalog(async () => ({}), { ttlMs: 0 }), MediaError);
});

test('Draw Things probe distinguishes running, API off and not installed without touching the network twice', async () => {
  const s = await fakeServer((_c, res) => json(res, 200, { model: 'sd.ckpt' }));
  try { assert.deepEqual(await probeDrawThings(s.url, { appInstalled: () => true, platform: 'darwin' }), { state: 'running' }); } finally { await s.close(); }
  const closed = await fakeServer((_c, res) => json(res, 200, {})); const dead = closed.url; await closed.close();
  assert.deepEqual(await probeDrawThings(dead, { appInstalled: () => true, platform: 'darwin' }), { state: 'api_off', reason: 'drawthings_api_off' });
  assert.deepEqual(await probeDrawThings(dead, { appInstalled: () => false, platform: 'darwin' }), { state: 'not_installed', reason: 'drawthings_not_installed' });
  assert.deepEqual(await probeDrawThings('http://192.168.1.50:7860', { appInstalled: () => false, platform: 'darwin', fetch: async () => { throw new Error('refused'); } }), { state: 'api_off', reason: 'drawthings_api_off' }); // a remote host cannot be "not installed" here
  const server500 = await fakeServer((_c, res) => json(res, 500, {}));
  try { assert.equal((await probeDrawThings(server500.url, { appInstalled: () => true, platform: 'darwin' })).state, 'running'); } finally { await server500.close(); }
});

test('the limiter runs at most N jobs and releases on failure and on abort while waiting', async () => {
  const limiter = new Limiter(2); let active = 0; let peak = 0; const gates: (() => void)[] = [];
  const job = (fail = false) => limiter.run(new AbortController().signal, async () => { active++; peak = Math.max(peak, active); await new Promise<void>(r => gates.push(r)); active--; if (fail) throw new Error('boom'); });
  const settledP = Promise.allSettled([job(), job(true), job(), job()]);
  await new Promise(r => setImmediate(r)); assert.equal(active, 2); assert.equal(gates.length, 2);
  gates.shift()!(); await new Promise(r => setImmediate(r)); gates.shift()!(); await new Promise(r => setImmediate(r)); gates.splice(0).forEach(g => g());
  const settled = await settledP; assert.equal(settled.filter(s => s.status === 'rejected').length, 1); assert.equal(peak, 2);
  const one = new Limiter(1); const c = new AbortController(); let release!: () => void;
  const holder = one.run(new AbortController().signal, () => new Promise<void>(r => { release = r; }));
  const waiting = one.run(c.signal, async () => 'never'); c.abort();
  await assert.rejects(waiting, (e: unknown) => e instanceof MediaError && e.code === 'cancelled'); release(); await holder;
  assert.equal(await one.run(new AbortController().signal, async () => 'free'), 'free');
  assert.throws(() => new Limiter(0), MediaError); assert.throws(() => new Limiter(1.5), MediaError);
});

test('provider output is verified by magic bytes, the declared type is not trusted', () => {
  assert.deepEqual(verifyOutput({ bytes: makeJpeg(), format: 'png' }).format, 'jpeg');
  for (const bad of [Buffer.from('image'), Buffer.alloc(0), Buffer.from('<html>error</html>'), Buffer.from('GIF89a....')]) assert.throws(() => verifyOutput({ bytes: bad, format: 'png' }), (e: unknown) => e instanceof MediaError && e.code === 'invalid_response');
});
