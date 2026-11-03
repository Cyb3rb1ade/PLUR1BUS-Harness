/** Maintenance reads bounded metadata only and never turns transient read failures into deletion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OutputStore, MediaError, CORRUPT_UPLOAD_GRACE_MS } from "../src/index.ts";
import { makePng } from "./adapters-fixtures.ts";

const PNG = makePng();
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);
const code = (error: unknown) => error instanceof MediaError && error.code === "backend_unavailable";

async function withRoot(run: (root: string) => Promise<void>) {
  const home = await fs.mkdtemp(join(tmpdir(), "media-prune-metadata-"));
  try { await run(join(home, "outputs")); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

async function ageUpload(directory: string) {
  const at = (Date.now() - 2 * CORRUPT_UPLOAD_GRACE_MS) / 1000;
  for (const file of await fs.readdir(directory)) await fs.utimes(join(directory, file), at, at);
  await fs.utimes(directory, at, at);
}

for (const method of ["prune", "recoverStaging"] as const) {
  test(`${method} retains same-size bit rot without payload reads, while getUploaded refuses its hash`, async t => {
    await withRoot(async root => {
      const store = new OutputStore(root);
      const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      await fs.writeFile(upload.file, Buffer.alloc(PNG.length, 1));
      await ageUpload(join(root, ".uploads", upload.manifest.id));
      const deleted: string[] = [];
      store.addListener({ onDeleteUploaded(id) { deleted.push(id); } });
      const original = fs.readFile;
      let payloadReads = 0;
      const reader = t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === upload.file) payloadReads++;
        return original(...args);
      });
      syncBuiltinESMExports();
      try {
        const result = await store[method]();
        if (method === "prune") assert.equal(result, 0);
        assert.equal(payloadReads, 0, "maintenance must not load or hash payload bytes");
        assert.deepEqual(deleted, []);
      } finally { reader.mock.restore(); syncBuiltinESMExports(); }
      await assert.rejects(store.getUploaded(upload.manifest.id), code);
    });
  });
}

for (const failure of ["EIO", "EACCES", "EMFILE"] as const) {
  for (const method of ["prune", "recoverStaging"] as const) {
    test(`${method} skips ${failure} metadata reads without deleting bytes or invoking owner cleanup, then retries`, async () => {
      await withRoot(async root => {
        const store = new OutputStore(root);
        const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
        const directory = join(root, ".uploads", upload.manifest.id);
        const manifestPath = join(directory, "manifest.json");
        await ageUpload(directory);
        const deleted: string[] = [], warnings: string[] = [];
        store.addListener({ onDeleteUploaded(id) { deleted.push(id); }, onUploadStorageUnavailable() { warnings.push("storage-unavailable"); } });
        let reads = 0;
        store.options.readUploadManifest = async path => {
          reads++;
          assert.equal(path, manifestPath);
          throw Object.assign(new Error("PRIVATE filesystem path and content must not escape"), { code: failure });
        };
        await store[method]();
        assert.equal(reads, 1);
        assert.deepEqual(deleted, [], "an I/O error is not evidence of corruption");
        assert.deepEqual(warnings, ["storage-unavailable"]);
        assert.deepEqual(await fs.readFile(upload.file), PNG);
        store.options.readUploadManifest = path => fs.readFile(path, "utf8");
        await fs.writeFile(manifestPath, "invalid-json");
        await ageUpload(directory);
        await store[method]();
        assert.deepEqual(deleted, [upload.manifest.id], "the next run still removes proven stale corruption");
        assert.equal(await store.getUploaded(upload.manifest.id), null);
      });
    });
  }
}

test("a concurrent upload enters a nearly full store during metadata-only prune with a 200ms lock wait", { timeout: 10_000 }, async t => {
  await withRoot(async root => {
    const setup = new OutputStore(root);
    const payload = Buffer.alloc(4 * 1024 * 1024);
    WAV.copy(payload);
    const existing = [];
    for (let i = 0; i < 4; i++) existing.push(await setup.putUploaded({ kind: "audio", mimeType: "audio/wav", data: payload }));
    const used = existing.reduce((sum, item) => sum + item.manifest.file.bytes + Buffer.byteLength(JSON.stringify(item.manifest)), 0);
    const quota = used + 4096;
    assert.ok(used / quota > 0.99, "the fixture is nearly full without writing about a GiB");
    let entered!: () => void, release!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const store = new OutputStore(root, { quotaBytes: quota, lockWaitMs: 200, readUploadManifest: async path => {
      if (first) { first = false; entered(); await gate; }
      return fs.readFile(path, "utf8");
    } });
    const original = fs.readFile, paths = new Set(existing.map(upload => upload.file));
    let payloadReads = 0;
    const reader = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (paths.has(String(args[0]))) {
        payloadReads++;
        // A slow payload device exposes the old held-lock hash scan deterministically.
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const pruning = store.prune();
      await admitted;
      const putting = new OutputStore(root, { quotaBytes: quota, lockWaitMs: 200 }).putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      release();
      const [pruneResult, putResult] = await Promise.allSettled([pruning, putting]);
      assert.equal(pruneResult.status, "fulfilled");
      assert.equal(putResult.status, "fulfilled", "metadata maintenance cannot consume the upload lock budget");
      assert.equal(payloadReads, 0);
    } finally { release(); reader.mock.restore(); syncBuiltinESMExports(); }
  });
});
