import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adapterConfigsFromSettings, DEFAULT_MODELS, createAdapter, egressHosts } from '../src/index.ts';

const KEY = 'dummy-test-secret-not-a-real-key';
const secrets = (map: Record<string, string>) => async (ref: string) => map[ref];

test('everything is off until configured: no settings, no adapters', async () => {
  assert.deepEqual(await adapterConfigsFromSettings(undefined, secrets({})), { configs: [], skipped: [] });
  assert.deepEqual((await adapterConfigsFromSettings({ adapters: {} }, secrets({}))).configs, []);
});

test('a remote adapter turns on when its key reference resolves, and enabled=false always wins', async () => {
  const settings = { adapters: { openai: { apiKeyRef: 'media/openai' }, google: { apiKeyRef: 'media/google', enabled: false }, fal: { apiKeyRef: 'media/missing' }, xai: { enabled: true } } };
  const { configs, skipped } = await adapterConfigsFromSettings(settings, secrets({ 'media/openai': KEY, 'media/google': KEY }));
  assert.deepEqual(configs.map(c => c.id), ['openai']);
  assert.deepEqual(skipped, [{ id: 'google', reason: 'disabled' }, { id: 'xai', reason: 'no_key' }, { id: 'fal', reason: 'key_unresolved' }]);
  const openai = configs[0] as { apiKey?: string; model: string }; assert.equal(openai.apiKey, KEY); assert.equal(openai.model, DEFAULT_MODELS.openai);
  assert.equal(JSON.stringify(skipped).includes(KEY), false); assert.equal(JSON.stringify(skipped).includes('media/'), false);
});

test('model, endpoint, timeout and concurrency are passed through; blank secrets count as unresolved', async () => {
  const { configs, skipped } = await adapterConfigsFromSettings({ adapters: { replicate: { apiKeyRef: 'r', model: 'acme/painter:abc', baseUrl: 'https://api.replicate.com/v1', timeoutMs: 30000, maxConcurrent: 3 }, together: { apiKeyRef: 't' } } }, secrets({ r: KEY, t: '   ' }));
  assert.deepEqual(configs, [{ id: 'replicate', model: 'acme/painter:abc', apiKey: KEY, baseUrl: 'https://api.replicate.com/v1', timeoutMs: 30000, maxConcurrent: 3 }]);
  assert.deepEqual(skipped, [{ id: 'together', reason: 'key_unresolved' }]);
});

test('Draw Things: host and port become the base URL; a non-loopback host needs allowLan; no key is ever attached', async () => {
  const on = (drawthings: Record<string, unknown>) => adapterConfigsFromSettings({ adapters: { drawthings } }, secrets({}));
  assert.deepEqual((await on({ enabled: true, model: 'sd.ckpt' })).configs, [{ id: 'draw-things', model: 'sd.ckpt', baseUrl: 'http://127.0.0.1:7860' }]);
  assert.deepEqual((await on({ enabled: true, model: 'sd.ckpt', host: 'localhost', port: 8000 })).configs, [{ id: 'draw-things', model: 'sd.ckpt', baseUrl: 'http://localhost:8000' }]);
  assert.deepEqual((await on({ enabled: true, model: 'm', host: '::1' })).configs[0], { id: 'draw-things', model: 'm', baseUrl: 'http://[::1]:7860' });
  assert.deepEqual((await on({ enabled: true, model: 'm', host: '100.64.0.9' })).skipped, [{ id: 'draw-things', reason: 'lan_not_allowed' }]);
  const lan = await on({ enabled: true, model: 'm', host: '192.168.1.50', allowLan: true, apiKeyRef: 'ignored' }); assert.deepEqual(lan.configs, [{ id: 'draw-things', model: 'm', baseUrl: 'http://192.168.1.50:7860', allowLan: true }]);
  assert.deepEqual((await on({ enabled: true })).skipped, [{ id: 'draw-things', reason: 'no_model' }]); assert.deepEqual((await on({ model: 'm' })).skipped, [{ id: 'draw-things', reason: 'disabled' }]);
});

test('Core ML: binary, modelsDir and computeUnits map onto the adapter; "auto" leaves the choice to the helper', async () => {
  const on = (coreml: Record<string, unknown>) => adapterConfigsFromSettings({ adapters: { coreml } }, secrets({}));
  assert.deepEqual((await on({ enabled: true, binary: '/opt/media-coreml', model: 'sd-split', modelsDir: '/models', computeUnits: 'cpuAndGPU', scheduler: 'dpmpp', timeoutMs: 60000 })).configs, [{ id: 'coreml-local', model: 'sd-split', helperPath: '/opt/media-coreml', modelDir: '/models', computeUnits: 'cpuAndGPU', scheduler: 'dpmpp', timeoutMs: 60000 }]);
  assert.deepEqual((await on({ enabled: true, binary: '/b', model: 'm', computeUnits: 'auto' })).configs, [{ id: 'coreml-local', model: 'm', helperPath: '/b' }]);
  assert.deepEqual((await on({ enabled: true, model: 'm' })).skipped, [{ id: 'coreml-local', reason: 'no_binary' }]); assert.deepEqual((await on({ enabled: true, binary: '/b' })).skipped, [{ id: 'coreml-local', reason: 'no_model' }]);
});

test('the produced configs build adapters and an egress inventory that lists only what is enabled', async () => {
  const { configs } = await adapterConfigsFromSettings({ adapters: { openai: { apiKeyRef: 'o' }, fal: { apiKeyRef: 'f' }, drawthings: { enabled: true, model: 'm' }, coreml: { enabled: true, binary: process.execPath, model: 'sd' } } }, secrets({ o: KEY, f: KEY }));
  assert.deepEqual(configs.map(c => createAdapter(c).id), ['openai', 'fal', 'draw-things', 'coreml-local']);
  assert.deepEqual(egressHosts(configs), ['127.0.0.1', 'api.openai.com', 'queue.fal.run'].sort());
});

test('shipped defaults: the schema and the code name the same default models, and each is a plausible id', () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../config-schema/schema/config.schema.json', import.meta.url)), 'utf8')) as { properties: { media: { properties: { adapters: { properties: Record<string, { properties: Record<string, { default?: unknown }> }> } } } } };
  const adapters = schema.properties.media.properties.adapters.properties;
  for (const [id, model] of Object.entries(DEFAULT_MODELS)) { assert.equal(adapters[id]!.properties.model!.default, model, id); assert.match(model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,120}$/); }
  assert.equal(adapters.drawthings!.properties.model!.default, undefined); assert.equal(adapters.coreml!.properties.model!.default, undefined);
  assert.deepEqual(Object.keys(adapters).sort(), ['coreml', 'drawthings', 'fal', 'google', 'openai', 'openrouter', 'replicate', 'together', 'xai']);
});
