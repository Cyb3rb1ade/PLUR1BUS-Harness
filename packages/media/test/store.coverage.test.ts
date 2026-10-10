import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { OutputStore, MediaError } from '../src/index.ts';
import type { ImageRequest, ImageResult } from '../src/index.ts';

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('png-bytes-for-store-tests');
const JPEG = Buffer.from('jpeg-bytes-for-store-tests');

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'media-store-cov-'));
  try { return await fn(join(root, 'outputs')); } finally { await rm(root, { recursive: true, force: true }); }
}
function result(files: ImageResult['files'], extra: Partial<ImageResult> = {}): ImageResult {
  return { files, metadata: { adapter: 'fake', model: 'm', durationMs: 1 }, ...extra };
}
const request: ImageRequest = { prompt: 'a lighthouse at dusk' };

test('constructor refuses a negative, infinite or non-numeric quota or retention, and accepts zero', () => {
  for (const options of [{ quotaBytes: -1 }, { retentionMs: -5 }, { quotaBytes: Number.NaN }, { retentionMs: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => new OutputStore('/unused', options), code('unsupported_parameter'), JSON.stringify(options));
  }
  assert.doesNotThrow(() => new OutputStore('/unused', { quotaBytes: 0, retentionMs: 0 }));
  assert.equal(new OutputStore('/unused').root, '/unused');
});

test('put writes a manifest with hashes, sizes and nulls for absent seed and cost, and get reads it back', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const manifest = await store.put('job-1', request, result([{ bytes: PNG, format: 'png' }, { bytes: JPEG, format: 'jpeg' }]));
    assert.equal(manifest.schema, 'media.output/1');
    assert.deepEqual(manifest.files, [
      { path: '0.png', sha256: sha(PNG), bytes: PNG.length, format: 'png' },
      { path: '1.jpeg', sha256: sha(JPEG), bytes: JPEG.length, format: 'jpeg' },
    ]);
    assert.deepEqual(manifest.metadata, { adapter: 'fake', model: 'm', durationMs: 1, seed: null, costUsd: null, origin: 'unknown' });
    assert.equal(manifest.partial, false);
    assert.deepEqual(manifest.referenceHashes, []);
    assert.equal('maskHash' in manifest, false);
    assert.deepEqual(Buffer.from(await readFile(join(root, 'job-1', '0.png'))), PNG);
    assert.deepEqual(await store.get('job-1'), manifest);
  });
});

test('put keeps reported seed, cost, origin and partial, hashes references and mask, and drops them from parameters', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const req: ImageRequest = { prompt: 'p', n: 2, seed: 9, referenceImages: [{ bytes: PNG, format: 'png' }], mask: { bytes: JPEG, format: 'jpeg' } };
    const manifest = await store.put('job-2', req, result([{ bytes: PNG, format: 'png' }], { partial: true, metadata: { adapter: 'fake', model: 'm', durationMs: 7, seed: 9, costUsd: 0.02, origin: 'cloud' } }));
    assert.equal(manifest.partial, true);
    assert.deepEqual(manifest.metadata, { adapter: 'fake', model: 'm', durationMs: 7, seed: 9, costUsd: 0.02, origin: 'cloud' });
    assert.deepEqual(manifest.referenceHashes, [sha(PNG)]);
    assert.equal(manifest.maskHash, sha(JPEG));
    assert.equal('referenceImages' in manifest.parameters, false);
    assert.equal('mask' in manifest.parameters, false);
    assert.deepEqual(manifest.parameters, { prompt: 'p', n: 2, seed: 9 });
  });
});

test('put refuses bad ids, invalid requests, empty results, unknown formats and empty bytes before writing', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const ok = result([{ bytes: PNG, format: 'png' }]);
    await assert.rejects(store.put('../escape', request, ok), code('unsupported_parameter'));
    await assert.rejects(store.put('bad id', request, ok), code('unsupported_parameter'));
    await assert.rejects(store.put('ok-1', { prompt: '   ' }, ok), code('unsupported_parameter'));
    await assert.rejects(store.put('ok-2', request, result([])), code('invalid_response'));
    await assert.rejects(store.put('ok-3', request, result([{ bytes: PNG, format: 'gif' as 'png' }])), code('invalid_response'));
    await assert.rejects(store.put('ok-4', request, result([{ bytes: new Uint8Array(0), format: 'png' }])), code('invalid_response'));
    assert.equal(await store.get('ok-1'), null);
  });
});

test('a second put with the same id is refused and the first manifest is untouched', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const first = await store.put('same', request, result([{ bytes: PNG, format: 'png' }]));
    await assert.rejects(store.put('same', { prompt: 'other' }, result([{ bytes: JPEG, format: 'jpeg' }])), code('unsupported_parameter'));
    assert.deepEqual(await store.get('same'), first);
  });
});

test('a lock directory already present makes writes fail as backend_unavailable', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    await mkdir(join(root, '.lock'), { recursive: true });
    await assert.rejects(store.put('locked', request, result([{ bytes: PNG, format: 'png' }])), code('backend_unavailable'));
    await assert.rejects(store.delete('locked'), code('backend_unavailable'));
    await assert.rejects(store.prune(), code('backend_unavailable'));
  });
});

test('get returns null for a missing id and refuses an unsafe id', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    assert.equal(await store.get('never-written'), null);
    await assert.rejects(store.get('a/b'), code('unsupported_parameter'));
    await assert.rejects(store.get(''), code('unsupported_parameter'));
  });
});

test('get rethrows I/O errors that are not "missing", such as a file where the job directory should be', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'blocked'), 'not a directory');
    await assert.rejects(store.get('blocked'), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOTDIR');
  });
});

test('delete removes a stored job, is idempotent for an unknown id, and refuses an unsafe id', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    await store.put('gone', request, result([{ bytes: PNG, format: 'png' }]));
    await store.delete('gone');
    assert.equal(await store.get('gone'), null);
    await store.delete('gone');
    await assert.rejects(store.delete('../gone'), code('unsupported_parameter'));
    assert.equal((await readdir(root)).includes('.lock'), false); // lock released after the delete
  });
});

test('prune without a retention window removes nothing; with one, it removes only jobs at or past the window', async () => {
  await withRoot(async root => {
    const keeper = new OutputStore(root);
    const oldJob = await keeper.put('old', request, result([{ bytes: PNG, format: 'png' }]));
    assert.equal(await keeper.prune(oldJob.createdAt + 10 ** 9), 0);
    const windowed = new OutputStore(root, { retentionMs: 1000 });
    assert.equal(await windowed.prune(oldJob.createdAt + 999), 0);
    assert.notEqual(await keeper.get('old'), null);
    assert.equal(await windowed.prune(oldJob.createdAt + 1000), 1);
    assert.equal(await keeper.get('old'), null);
  });
});

test('prune skips hidden entries such as the lock and staging directories', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root, { retentionMs: 1 });
    await mkdir(join(root, '.stage-0000'), { recursive: true });
    await store.put('fresh', request, result([{ bytes: PNG, format: 'png' }]));
    assert.equal(await store.prune(Date.now() + 10_000), 1);
    assert.ok((await readdir(root)).includes('.stage-0000'));
  });
});

test('recoverStaging creates a missing root and removes only the lock and UUID-named staging directories', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    await store.recoverStaging();
    await store.put('kept', request, result([{ bytes: PNG, format: 'png' }]));
    await mkdir(join(root, '.lock'));
    await mkdir(join(root, '.stage-0123abcd-ef01-2345-6789-abcdef012345'));
    await mkdir(join(root, '.stage-NOT-HEX'));
    await mkdir(join(root, 'unrelated'));
    await store.recoverStaging();
    const names = (await readdir(root)).sort();
    assert.deepEqual(names, ['.stage-NOT-HEX', 'kept', 'unrelated']);
    assert.notEqual(await store.get('kept'), null);
  });
});

test('a very large job id at the 100-character limit is accepted; 101 characters is refused', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const id = 'x'.repeat(100);
    const manifest = await store.put(id, request, result([{ bytes: PNG, format: 'png' }]));
    assert.equal(manifest.id, id);
    await assert.rejects(store.put('y'.repeat(101), request, result([{ bytes: PNG, format: 'png' }])), code('unsupported_parameter'));
  });
});
