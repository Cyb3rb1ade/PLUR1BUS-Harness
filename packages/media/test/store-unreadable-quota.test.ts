/** An inaccessible neighbor retains its durable quota/retention metadata across store restarts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MediaError, OutputStore } from '../src/index.ts';
import { makePng } from './adapters-fixtures.ts';

const PNG = makePng();
const quota = (error: unknown) => error instanceof MediaError && error.code === 'quota';

for (const unavailable of ['payload', 'manifest', 'directory'] as const) {
  test(`permanent ${unavailable} EACCES uses stored bytes, reports no content and expires after restart`, async t => {
    const home = await fs.mkdtemp(join(tmpdir(), 'media-unreadable-'));
    try {
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      const root = join(home, 'outputs');
      const initial = new OutputStore(root);
      const old = await initial.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG });
      const directory = join(root, '.uploads', old.manifest.id);
      const indexPath = join(root, '.upload-index', `${old.manifest.id}.json`);
      const bytes = PNG.length + Buffer.byteLength(JSON.stringify(old.manifest));
      const entry = unavailable === 'payload' ? old.file : unavailable === 'manifest' ? join(directory, 'manifest.json') : directory;
      const originalStat = fs.lstat, originalRead = fs.readFile;
      const denied = () => { throw Object.assign(new Error('PRIVATE storage details'), { code: 'EACCES' }); };
      let payloadReads = 0;
      const stat = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => String(args[0]) === entry ? denied() : originalStat(...args));
      const reader = t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === old.file) payloadReads++;
        return String(args[0]) === entry ? denied() : originalRead(...args);
      });
      syncBuiltinESMExports();
      try {
        const limited = new OutputStore(root, { quotaBytes: bytes * 2 - 1, retentionMs: 1_000 });
        await assert.rejects(limited.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG }), quota,
          'the unreadable upload still consumes its saved quota after a restart');
        const store = new OutputStore(root, { quotaBytes: bytes * 3, retentionMs: 1_000 });
        const warnings: unknown[][] = [], deleted: string[] = [], corruption: unknown[] = [];
        store.addListener({ onUploadStorageUnavailable(...args: unknown[]) { warnings.push(args); },
          async onDeleteUploaded(id) {
            assert.equal(id, old.manifest.id);
            assert.ok(await originalStat(old.file), 'owner cleanup precedes byte deletion');
            await new Promise(resolve => setTimeout(resolve, 5));
            deleted.push(id);
          }, onCorruptUploadRemoved(id) { corruption.push(id); } });
        assert.equal(await store.prune(old.manifest.createdAt + 999), 0);
        const saved = JSON.parse(await originalRead(indexPath, 'utf8'));
        assert.equal(saved.bytes, bytes);
        assert.equal(saved.createdAt, old.manifest.createdAt);
        assert.equal(saved.unavailable, true);
        now += 500;
        const newer = await store.putUploaded({ kind: 'image', mimeType: 'image/png', data: PNG });
        assert.equal(await store.prune(old.manifest.createdAt + 1_000), 1);
        assert.deepEqual(deleted, [old.manifest.id]);
        assert.deepEqual(corruption, [], 'retention is not a claim of payload corruption');
        assert.ok(warnings.length >= 1);
        assert.ok(warnings.every(args => args.length === 0), 'no path, id or raw error leaves the warning hook');
        assert.equal(payloadReads, 0, 'quota and retention never read or hash the payload');
        await assert.rejects(originalStat(indexPath), { code: 'ENOENT' });
        assert.ok(await store.getUploaded(newer.manifest.id));
      } finally { stat.mock.restore(); reader.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(await new OutputStore(root).getUploaded(old.manifest.id), null);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}
