import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutputStore, FileJobPersistence, JobRunner, MediaError, validateRequest, failure, estimateCost } from '../src/index.ts';
import type { ImageAdapter, ImageRequest } from '../src/index.ts';
import { embedPng } from '../src/png.ts';
const req = { prompt: '🌳 tree' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=', 'base64');
const result = { files: [{ bytes: png, format: 'png' as const }], metadata: { adapter: 'fake', model: 'sd', seed: 42, costUsd: 0, durationMs: 1 } };
async function setup(adapter: ImageAdapter) { const root = await mkdtemp(join(tmpdir(), 'media-life-')); const persistence = new FileJobPersistence(join(root, 'jobs')); const store = new OutputStore(join(root, 'store')); return { root, persistence, store, runner: new JobRunner(persistence, store, [adapter]) }; }
const adapter: ImageAdapter = { id: 'fake', capabilities: () => ({ generate: true, edit: true, inpaint: true }), generate: async () => result, edit: async () => result };
test('PNG UTF-8 metadata opt-in, precedence, unchanged default, retention and hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-png-')); const store = new OutputStore(root, { embedMetadata: true, retentionMs: 10 });
  const ref = { bytes: png, format: 'png' as const };
  const off = await store.put('off', { ...req, referenceImages: [ref], mask: ref, embedMetadata: false }, result, true);
  assert.deepEqual(await readFile(join(root, 'off', '0.png')), png); assert.equal(off.referenceHashes[0], off.maskHash);
  const on = await store.put('on', req, result, true); const bytes = await readFile(join(root, 'on', '0.png'));
  assert.ok(bytes.includes(Buffer.from(req.prompt))); assert.notEqual(on.files[0]!.sha256, off.files[0]!.sha256);
  await store.put('agent-off', req, result, false); assert.deepEqual(await readFile(join(root, 'agent-off', '0.png')), png);
  assert.equal(await store.prune(Date.now() + 100), 3); assert.equal(await store.get('off'), null);
  assert.throws(() => embedPng(Buffer.from('bad'), {})); assert.throws(() => embedPng(png.subarray(0, 20), {}));
  await assert.rejects(store.put('../escape', req, result));
  await assert.rejects(store.put('empty', req, { ...result, files: [] }));
  await assert.rejects(store.put('jpeg', req, { ...result, files: [{ bytes: png, format: 'jpeg' }] }));
  assert.throws(() => new OutputStore(root, { quotaBytes: -1 }));
});
test('quota concurrency cannot overcommit; recovery removes staging and stale lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-concurrent-')); const store = new OutputStore(root);
  const outcomes = await Promise.allSettled([store.put('a', req, result), store.put('b', req, result)]); assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  await mkdir(join(root, '.stage-abcd')); await mkdir(join(root, '.lock')); await store.recoverStaging();
  assert.equal((await readdir(root)).length, 1);
});
test('restart resumes a durable provider ID without generate; output replay is idempotent', async () => {
  let submissions = 0; let resumes = 0;
  const a: ImageAdapter = { ...adapter, generate: async () => { submissions++; return result; }, resume: async (_r, c) => { resumes++; assert.equal(c.resume!.id, 'prediction'); await c.onProgress?.({ fraction: 0.5 }); return result; } };
  const s = await setup(a); const job = await s.runner.enqueue('fake', req); job.state = 'running'; job.checkpoint = { id: 'prediction', model: 'sd' }; await s.persistence.put(job);
  const release = await s.persistence.claim(job.id); await assert.rejects(s.runner.run(job.id)); await s.persistence.recoverClaims();
  await s.runner.recover(); assert.equal(resumes, 1); assert.equal(submissions, 0);
  const saved = (await s.persistence.get(job.id))!; saved.state = 'running'; await s.persistence.put(saved); await s.runner.recover(); assert.equal(resumes, 1);
  await release(); assert.equal((await s.persistence.get(job.id))!.state, 'succeeded');
});
test('unresumable running jobs fail without resubmission; queued jobs recover; bytes roundtrip', async () => {
  const s = await setup(adapter); const r = { ...req, referenceImages: [{ bytes: Buffer.from('ref'), format: 'png' as const }], mask: { bytes: new Uint8Array([1, 2]), format: 'png' as const } };
  const job = await s.runner.enqueue('fake', r); const loaded = (await s.persistence.get(job.id))!;
  assert.equal(Buffer.from(loaded.request.referenceImages![0]!.bytes).toString(), 'ref'); assert.deepEqual([...loaded.request.mask!.bytes], [1, 2]);
  loaded.state = 'running'; await s.persistence.put(loaded); await s.runner.recover(); assert.equal((await s.persistence.get(job.id))!.error, 'interrupted');
  const queued = await s.runner.enqueue('fake', req, 'edit'); await s.runner.recover(); assert.equal((await s.persistence.get(queued.id))!.state, 'succeeded');
  await assert.rejects(s.runner.enqueue('missing', req)); assert.equal(await s.persistence.get('missing'), null);
});
test('queued and running cancellation, progress and checkpoints', async () => {
  let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
  const a: ImageAdapter = { ...adapter, generate: async (_r, c) => { await c!.onCheckpoint!({ id: 'checkpoint', model: 'sd' }); await c!.onProgress!({ fraction: 0.2 }); ready(); await new Promise<void>((_r, reject) => c!.signal!.addEventListener('abort', () => reject(new Error('secret')), { once: true })); return result; } };
  const s = await setup(a); const queued = await s.runner.enqueue('fake', req); await s.runner.cancel(queued.id); assert.equal((await s.persistence.get(queued.id))!.state, 'cancelled');
  const running = await s.runner.enqueue('fake', req); const execution = s.runner.run(running.id); await started; await s.runner.cancel(running.id); await execution;
  const saved = (await s.persistence.get(running.id))!; assert.equal(saved.state, 'cancelled'); assert.equal(saved.checkpoint!.id, 'checkpoint'); assert.equal(saved.progress.fraction, 0.2);
  await s.runner.cancel('missing');
});
test('invalid progress and backend failures are stable codes; budget settles', async () => {
  for (const thrown of [new Error('secret'), new MediaError('content_policy')]) {
    const s = await setup({ ...adapter, generate: async () => { throw thrown; } }); const job = await s.runner.enqueue('fake', req); await s.runner.run(job.id);
    assert.ok(!(JSON.stringify(await s.persistence.get(job.id))).includes('secret'));
  }
  const s = await setup({ ...adapter, generate: async (_r, c) => { await c!.onProgress!({ fraction: 2 }); return result; } });
  const j = await s.runner.enqueue('fake', req); await s.runner.run(j.id); assert.equal((await s.persistence.get(j.id))!.error, 'invalid_response');
  const settled: (number | null)[] = []; const ok = await setup(adapter); const runner = new JobRunner(ok.persistence, ok.store, [adapter], { reserve: async () => {}, settle: async (_id, cost) => { settled.push(cost); } });
  const job = await runner.enqueue('fake', req); await runner.run(job.id); assert.deepEqual(settled, [0]);
});
test('request bounds and error normalization', () => {
  for (const r of [{ prompt: '' }, { ...req, n: 0 }, { ...req, n: 1.5 }, { ...req, steps: 0 }, { ...req, guidance: NaN }, { ...req, format: 'gif' }, { ...req, size: { width: 9000, height: 1 } }, { prompt: 'x'.repeat(32001) }]) assert.throws(() => validateRequest(r as ImageRequest), MediaError);
  const c = new AbortController(); c.abort(); assert.equal(failure('secret', c.signal).code, 'cancelled');
  assert.equal(failure(new DOMException('', 'TimeoutError')).code, 'timeout'); assert.equal(failure('secret').code, 'backend_unavailable');
  assert.equal(estimateCost({ ...req, n: 2 }, { id: 'together', model: 'stabilityai/stable-diffusion-xl-base-1.0' }).usd, 0.0038);
});
