import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputStore, FileJobPersistence, JobRunner, MediaError, estimateCost, metadataEnabled, MEDIA_GENERATE, MEDIA_EDIT } from '../src/index.ts';
import type { ImageAdapter } from '../src/index.ts';
const req = { prompt: 'a tree', n: 1 };
const result = { files: [{ bytes: Buffer.from('image'), format: 'png' as const }], metadata: { adapter: 'fake', model: 'test', durationMs: 4 } };
const fake: ImageAdapter = { id: 'fake', capabilities: () => ({ generate: true, edit: false, inpaint: false }), generate: async () => result, edit: async () => { throw new MediaError('unsupported_parameter'); } };
test('capability names and metadata precedence', () => {
  assert.equal(MEDIA_GENERATE, 'media.generate'); assert.equal(MEDIA_EDIT, 'media.edit');
  assert.equal(metadataEnabled({}), false); assert.equal(metadataEnabled({ global: true, agent: false }), false);
  assert.equal(metadataEnabled({ global: false, agent: false, call: true }), true);
});
test('unknown model price is unknown, local price is zero', () => {
  assert.equal(estimateCost(req, { id: 'unknown', model: 'unknown' }).usd, null);
  assert.equal(estimateCost(req, { id: 'coreml-local', model: 'any' }).usd, 0);
});
test('store writes manifest and enforces quota atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-store-')); const store = new OutputStore(root, { quotaBytes: 10000 });
  const manifest = await store.put('job1', req, result);
  assert.equal(manifest.prompt, req.prompt); assert.match(manifest.files[0]!.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(join(root, 'job1', '0.png'))).toString(), 'image');
  const tiny = new OutputStore(root, { quotaBytes: 1 });
  await assert.rejects(tiny.put('job2', req, result), (e: unknown) => e instanceof MediaError && e.code === 'quota');
  assert.deepEqual((await readdir(root)).sort(), ['job1']);
});
test('job succeeds, persists, and rejects duplicate execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-jobs-')); const persistence = new FileJobPersistence(join(root, 'jobs'));
  const runner = new JobRunner(persistence, new OutputStore(join(root, 'outputs')), [fake]);
  const job = await runner.enqueue('fake', req); await runner.run(job.id);
  assert.equal((await persistence.get(job.id))!.state, 'succeeded');
  await assert.rejects(runner.run(job.id));
});
test('budget refusal prevents provider calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-budget-'));
  const runner = new JobRunner(new FileJobPersistence(join(root, 'jobs')), new OutputStore(join(root, 'outputs')), [fake], { reserve: async () => { throw new MediaError('quota'); }, settle: async () => {} });
  const job = await runner.enqueue('fake', req); await runner.run(job.id);
  assert.equal((await runner.persistence.get(job.id))!.error, 'quota');
});
