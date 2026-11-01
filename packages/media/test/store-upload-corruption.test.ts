/** Corrupt upload isolation, conservative quota accounting and awaited owner cleanup. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaError, OutputStore } from "../src/index.ts";
import { makePng } from "./adapters-fixtures.ts";

const PNG = makePng();
const GRACE_MS = 60 * 60 * 1000;
const generated = { files: [{ bytes: PNG, format: "png" as const }], metadata: { adapter: "fixture", model: "fixture", durationMs: 1 } };
const code = (value: string) => (error: unknown) => error instanceof MediaError && error.code === value;

async function withStore(run: (store: OutputStore) => Promise<void>) {
  const home = await fs.mkdtemp(join(tmpdir(), "media-corrupt-"));
  try { await run(new OutputStore(join(home, "outputs"))); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

async function ageTree(path: string, at: number): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isDirectory()) for (const name of await fs.readdir(path)) await ageTree(join(path, name), at);
  if (stat.isSymbolicLink()) await fs.lutimes(path, at / 1000, at / 1000);
  else await fs.utimes(path, at / 1000, at / 1000);
}

for (const damage of ["missing-manifest", "bad-manifest", "truncated", "wrong-hash"] as const) {
  test(`a ${damage} upload does not block new uploads, generated images or pruning`, async () => {
    await withStore(async store => {
      const bad = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      const directory = join(store.root, ".uploads", bad.manifest.id);
      const manifest = join(directory, "manifest.json");
      if (damage === "missing-manifest") await fs.rm(manifest);
      if (damage === "bad-manifest") await fs.writeFile(manifest, "not JSON");
      if (damage === "truncated") await fs.writeFile(bad.file, PNG.subarray(0, 3));
      if (damage === "wrong-hash") await fs.writeFile(bad.file, Buffer.alloc(PNG.length, 0));
      await assert.rejects(store.getUploaded(bad.manifest.id), code("backend_unavailable"));
      const good = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      await store.put("generated", { prompt: "tree" }, generated);
      assert.equal(await store.prune(), 0, "fresh corruption is retained during its grace period");
      assert.ok(await store.getUploaded(good.manifest.id));
      assert.ok(await store.get("generated"));
    });
  });
}

test("corrupt quota accounting charges actual nested bytes instead of manifest declarations", async () => {
  await withStore(async store => {
    const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const directory = join(store.root, ".uploads", upload.manifest.id);
    const manifestPath = join(directory, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ ...upload.manifest, file: { ...upload.manifest.file, bytes: 1 } }));
    await fs.mkdir(join(directory, "nested"));
    const extra = Buffer.alloc(2048, 1);
    await fs.writeFile(join(directory, "nested", "unlisted.bin"), extra);
    const actual = PNG.length + extra.length + (await fs.stat(manifestPath)).size;
    const probe = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const incoming = PNG.length + (await fs.stat(join(store.root, ".uploads", probe.manifest.id, "manifest.json"))).size;
    await store.deleteUploaded(probe.manifest.id);
    const limited = new OutputStore(store.root, { quotaBytes: actual + incoming - 1 });
    await assert.rejects(limited.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }), code("quota"));
    const exact = new OutputStore(store.root, { quotaBytes: actual + incoming });
    assert.ok(await exact.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }));
  });
});

for (const sweep of ["prune", "recoverStaging"] as const) {
  test(`${sweep} removes stale corrupt uploads with both observer hooks while retaining healthy ones`, async () => {
    await withStore(async store => {
      const bad = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      const good = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      await fs.writeFile(bad.file, Buffer.alloc(PNG.length, 0));
      await ageTree(join(store.root, ".uploads", bad.manifest.id), Date.now() - GRACE_MS - 10_000);
      const deleted: string[] = [], corrupted: (string | undefined)[] = [];
      store.addListener({ onDeleteUploaded(id) { deleted.push(id); }, onCorruptUploadRemoved(id) { corrupted.push(id); } });
      if (sweep === "prune") assert.equal(await store.prune(), 1);
      else await store.recoverStaging();
      assert.equal(await store.getUploaded(bad.manifest.id), null);
      assert.ok(await store.getUploaded(good.manifest.id));
      assert.deepEqual(deleted, [bad.manifest.id]);
      assert.deepEqual(corrupted, [bad.manifest.id]);
    });
  });
}

test("a recently changed child extends the corruption grace period beyond an old directory mtime", async () => {
  await withStore(async store => {
    const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const directory = join(store.root, ".uploads", upload.manifest.id);
    await fs.rm(join(directory, "manifest.json"));
    const now = Date.now();
    await ageTree(directory, now - 2 * GRACE_MS);
    await fs.utimes(upload.file, now / 1000, now / 1000);
    const latest = (await fs.lstat(upload.file)).mtimeMs;
    assert.equal(await store.prune(latest + GRACE_MS - 1), 0);
    assert.equal(await store.prune(latest + GRACE_MS), 1);
  });
});

test("upload accounting and corrupt cleanup never follow an external directory symlink", async () => {
  await withStore(async store => {
    const outside = `${store.root}-outside`;
    await fs.mkdir(outside, { recursive: true });
    const secret = Buffer.alloc(128 * 1024, 7);
    await fs.writeFile(join(outside, "private.bin"), secret);
    const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const directory = join(store.root, ".uploads", upload.manifest.id);
    await fs.rm(join(directory, "manifest.json"));
    await fs.symlink(outside, join(directory, "outside"), process.platform === "win32" ? "junction" : "dir");
    const limited = new OutputStore(store.root, { quotaBytes: 32 * 1024 });
    assert.ok(await limited.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }));
    await ageTree(directory, Date.now() - GRACE_MS - 10_000);
    assert.equal(await limited.prune(), 1);
    assert.deepEqual(await fs.readFile(join(outside, "private.bin")), secret);
  });
});

for (const operation of ["deleteUploaded", "prune", "recoverStaging"] as const) {
  test(`${operation} awaits upload cleanup and preserves an entry for retry when cleanup fails`, async () => {
    await withStore(async original => {
      const store = new OutputStore(original.root, { retentionMs: 0 });
      const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
      if (operation === "recoverStaging") {
        await fs.rm(join(store.root, ".uploads", upload.manifest.id, "manifest.json"));
        await ageTree(join(store.root, ".uploads", upload.manifest.id), Date.now() - GRACE_MS - 10_000);
      }
      let began!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { began = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      let otherObserverRan = 0, cleanupStarted = false;
      const cleanup = blocked.then(() => { throw new Error("private cleanup path must not escape"); });
      void cleanup.catch(() => {}); // The old unawaited implementation must fail assertions rather than leak a rejection.
      const unlisten = store.addListener({ onDeleteUploaded() { cleanupStarted = true; began(); return cleanup; } });
      store.addListener({ async onDeleteUploaded() { otherObserverRan++; } });
      const invoke = () => operation === "deleteUploaded" ? store.deleteUploaded(upload.manifest.id) : store[operation]();
      const outcome = invoke().then(() => null, (error: unknown) => error);
      try {
        await Promise.race([entered, outcome]);
        assert.equal(cleanupStarted, true);
        assert.ok(await fs.lstat(join(store.root, ".uploads", upload.manifest.id)), "bytes stay until owner cleanup completes");
      } finally { release(); }
      const error = await outcome;
      assert.ok(code("backend_unavailable")(error));
      assert.equal((error as Error).message, "Media operation failed: backend_unavailable");
      assert.equal(otherObserverRan, 1, "one failing observer does not skip the remaining cleanup");
      assert.ok(await fs.lstat(join(store.root, ".uploads", upload.manifest.id)));
      unlisten();
      await invoke();
      assert.equal(await store.getUploaded(upload.manifest.id), null);
      assert.equal(otherObserverRan, 2);
    });
  });
}
