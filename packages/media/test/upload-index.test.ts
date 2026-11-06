/** Accounting recovery uses bounded metadata, preserves unknown bytes and never follows index symlinks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputStore, MediaError } from '../src/index.ts';
import { UploadIndex } from '../src/upload-index.ts';
import { makePng } from './adapters-fixtures.ts';

const PNG = makePng();
async function withRoot(run: (root: string) => Promise<void>) {
  const home = await fs.mkdtemp(join(tmpdir(), 'media-index-'));
  try { await run(join(home, 'outputs')); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('legacy uploads are indexed lazily and vanished publication records are removed during recovery', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const upload = await store.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG });
    const index = new UploadIndex(root);
    await index.remove(upload.manifest.id);
    await store.recoverStaging();
    assert.deepEqual(await index.read(upload.manifest.id), { schema: 'media.upload-index/1',
      bytes: PNG.length + Buffer.byteLength(JSON.stringify(upload.manifest)), createdAt: upload.manifest.createdAt, unavailable: false });
    await fs.rm(join(root, '.uploads', upload.manifest.id), { recursive: true });
    await store.recoverStaging();
    assert.equal(await index.read(upload.manifest.id), null);
  });
});

test('an unindexed inaccessible legacy tree reserves the maximum admitted bytes instead of zero', async t => {
  await withRoot(async root => {
    const upload = await new OutputStore(root).putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG });
    const index = new UploadIndex(root);
    await index.remove(upload.manifest.id);
    const directory = join(root, '.uploads', upload.manifest.id), original = fs.lstat;
    const stat = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === directory) throw Object.assign(new Error('PRIVATE'), { code: 'EACCES' });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const store = new OutputStore(root, { quotaBytes: 1024 });
      await assert.rejects(store.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG }),
        error => error instanceof MediaError && error.code === 'quota');
      const record = await index.read(upload.manifest.id);
      assert.equal(record?.bytes, 25 * 1024 * 1024 + 4096);
      assert.equal(record?.unavailable, true);
    } finally { stat.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('malformed accounting is repaired only from readable metadata and healthy maintenance clears a warning', async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const upload = await store.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG });
    const index = new UploadIndex(root), path = join(index.root, `${upload.manifest.id}.json`);
    for (const text of ['invalid', 'x'.repeat(513), JSON.stringify({ schema: 'media.upload-index/1', createdAt: -1, bytes: 1, unavailable: false })]) {
      await fs.writeFile(path, text);
      await assert.rejects(index.read(upload.manifest.id));
      await store.prune();
      assert.equal((await index.read(upload.manifest.id))?.bytes, PNG.length + Buffer.byteLength(JSON.stringify(upload.manifest)));
    }
    const valid = (await index.read(upload.manifest.id))!;
    await index.write(upload.manifest.id, { ...valid, unavailable: true });
    await store.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG });
    assert.equal((await index.read(upload.manifest.id))?.unavailable, true, 'a stat-only quota scan cannot clear a read failure');
    await store.prune();
    assert.equal((await index.read(upload.manifest.id))?.unavailable, false);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(index.root)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    }
  });
});

test('index symlinks are refused without reading or replacing the external target', async () => {
  await withRoot(async root => {
    await fs.mkdir(root);
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    const index = new UploadIndex(root);
    await fs.symlink(outside, index.root, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(index.read('upload'));
    await assert.rejects(index.write('upload', { schema: 'media.upload-index/1', createdAt: 1, bytes: 1, unavailable: false }));
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.rm(index.root);
    await fs.mkdir(index.root);
    const target = join(outside, 'record');
    await fs.writeFile(target, 'PRIVATE');
    await fs.symlink(target, join(index.root, 'upload.json'));
    await assert.rejects(index.read('upload'));
    assert.equal(await fs.readFile(target, 'utf8'), 'PRIVATE');
  });
});
