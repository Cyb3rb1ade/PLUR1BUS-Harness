import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createAdapter, AdapterRegistry, egressHosts, estimateCost, MediaError } from '../src/index.ts';
import type { AdapterConfig } from '../src/index.ts';
import { ADAPTER_PROFILES, adapterProfile } from '../src/adapters/capabilities.ts';
import { makePng } from './adapters-fixtures.ts';

const KEY = 'dummy-test-secret-not-a-real-key';
const configs: AdapterConfig[] = [
  { id: 'openai', model: 'gpt-image-1', apiKey: KEY }, { id: 'google', model: 'gemini-image-test', apiKey: KEY }, { id: 'xai', model: 'grok-image-test', apiKey: KEY },
  { id: 'openrouter', model: 'google/gemini-image-test', apiKey: KEY }, { id: 'replicate', model: 'acme/painter', apiKey: KEY }, { id: 'fal', model: 'fal-ai/flux/schnell', apiKey: KEY },
  { id: 'together', model: 'black-forest-labs/FLUX.1-schnell', apiKey: KEY }, { id: 'draw-things', model: 'sd.ckpt' },
  { id: 'coreml-local', model: 'sd', helperPath: process.execPath, platform: { os: 'darwin', arch: 'arm64' } },
];
const png = { bytes: makePng(), format: 'png' as const };

test('every registered adapter satisfies the ImageAdapter contract', async () => {
  const registry = new AdapterRegistry(configs); assert.deepEqual(Object.keys(registry.capabilities()).sort(), configs.map(c => c.id).sort());
  for (const config of configs) {
    const adapter = createAdapter(config); const caps = adapter.capabilities();
    assert.equal(adapter.id, config.id); assert.equal(adapter.model, config.model);
    for (const key of ['generate', 'edit', 'inpaint'] as const) assert.equal(typeof caps[key], 'boolean', `${adapter.id}.${key}`);
    assert.equal(caps.generate, true); assert.ok(!caps.inpaint || caps.edit, `${adapter.id}: inpaint implies edit`);
    for (const method of ['generate', 'edit'] as const) assert.equal(typeof adapter[method], 'function');
    // Invalid input fails with a stable code before any I/O (none of these hosts is reachable in this test).
    await assert.rejects(adapter.generate({ prompt: '   ' }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter', adapter.id);
    await assert.rejects(adapter.edit({ prompt: 'x' }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter', `${adapter.id}: edit needs a reference`);
    if (!caps.edit) await assert.rejects(adapter.edit({ prompt: 'x', referenceImages: [png] }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter', `${adapter.id}: edit=false refuses`);
    if (!caps.inpaint) await assert.rejects(adapter.edit({ prompt: 'x', referenceImages: [png], mask: png }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter', `${adapter.id}: inpaint=false refuses masks`);
    // Only provider-side jobs that are polled can be resumed; for every other adapter a resume token is refused, never submitted again.
    if (!['replicate', 'fal'].includes(adapter.id) && adapter.resume) await assert.rejects(adapter.resume({ prompt: 'x' }, { resume: { id: 'job-1', model: adapter.model! } }), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_parameter', `${adapter.id}: resume refused`);
    if (['replicate', 'fal'].includes(adapter.id)) assert.equal(typeof adapter.resume, 'function', `${adapter.id}: polled adapters resume`);
    assert.equal(inspect(adapter, { depth: 10 }).includes(KEY), false); assert.equal(JSON.stringify(adapter).includes(KEY), false);
  }
});

test('capability flags, static profiles and the egress inventory agree', () => {
  for (const config of configs) {
    const adapter = createAdapter(config); const caps = adapter.capabilities(); const profile = adapterProfile(adapter.id)!;
    assert.ok(profile, `${adapter.id} has a profile`); assert.equal(profile.id, adapter.id);
    assert.equal(caps.edit, profile.references > 0, `${adapter.id}: edit <=> reference input`); assert.equal(caps.inpaint, profile.mask, `${adapter.id}: inpaint <=> mask`);
    assert.equal(profile.location === 'local', ['draw-things', 'coreml-local'].includes(adapter.id)); assert.ok(profile.maxImages >= 1 && profile.maxImages <= 10);
  }
  assert.deepEqual(Object.keys(ADAPTER_PROFILES).sort(), configs.map(c => c.id).sort());
  const hosts = egressHosts(configs); assert.ok(hosts.includes('api.openai.com') && hosts.includes('queue.fal.run') && hosts.includes('openrouter.ai'));
});

test('cost estimates: local adapters are free, priced models are known, everything else is unknown rather than invented', () => {
  const req = { prompt: 'x', n: 2 };
  assert.equal(estimateCost(req, { id: 'draw-things', model: 'sd.ckpt' }).usd, 0); assert.equal(estimateCost(req, { id: 'coreml-local', model: 'sd' }).usd, 0);
  for (const id of ['google', 'xai', 'openrouter', 'replicate', 'fal']) assert.equal(estimateCost(req, { id, model: 'unlisted-model' }).usd, null, id);
});
