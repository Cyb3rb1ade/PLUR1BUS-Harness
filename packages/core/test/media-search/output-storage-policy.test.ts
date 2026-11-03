import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMediaOutputStore, MEDIA_OUTPUT_QUOTA_BYTES, MEDIA_OUTPUT_RETENTION_MS } from "../../src/media-output-store.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);

test("the production store has a finite shared quota and retention", async () => {
  const home = await mkdtemp(join(tmpdir(), "media-storage-policy-"));
  try {
    const store = createMediaOutputStore(home);
    assert.equal(store.options.quotaBytes, MEDIA_OUTPUT_QUOTA_BYTES);
    assert.equal(store.options.retentionMs, MEDIA_OUTPUT_RETENTION_MS);
    assert.equal(store.root, join(home, "media", "outputs"));
    assert.ok(Number.isFinite(store.options.quotaBytes));
    assert.ok(Number.isFinite(store.options.retentionMs));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("production retention removes raw media and its private owner metadata together", async () => {
  const home = await mkdtemp(join(tmpdir(), "media-storage-owner-"));
  try {
    const store = createMediaOutputStore(home);
    const upload = await store.putUploaded({ kind: "audio", mimeType: "audio/wav", data: WAV });
    const owner = join(home, "media", "owners", `${upload.manifest.id}.json`);
    await mkdir(join(home, "media", "owners"), { recursive: true });
    await writeFile(owner, JSON.stringify({ agentId: "main", userId: "private-person", chatKind: "direct", owner: "user:private-person" }));
    assert.equal(await store.prune(upload.manifest.createdAt + MEDIA_OUTPUT_RETENTION_MS), 1);
    assert.equal(await store.getUploaded(upload.manifest.id), null);
    await assert.rejects(readFile(owner), { code: "ENOENT" });
    await store.deleteUploaded(upload.manifest.id);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("production maintenance logs a stable storage warning and preserves private ownership until a later retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "media-storage-unavailable-"));
  try {
    const warnings: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const store = createMediaOutputStore(home, { warn(message, fields) { warnings.push({ message, fields }); } });
    const upload = await store.putUploaded({ kind: "audio", mimeType: "audio/wav", data: WAV });
    const directory = join(store.root, ".uploads", upload.manifest.id);
    const manifestPath = join(directory, "manifest.json");
    const owner = join(home, "media", "owners", `${upload.manifest.id}.json`);
    await mkdir(join(home, "media", "owners"), { recursive: true });
    const ownerText = JSON.stringify({ agentId: "main", userId: "PRIVATE-PERSON", chatKind: "direct", owner: deriveUserPrincipal("PRIVATE-PERSON") });
    await writeFile(owner, ownerText);
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await utimes(upload.file, old, old);
    await utimes(manifestPath, old, old);
    await utimes(directory, old, old);
    let unavailable = true, reads = 0;
    store.options.readUploadManifest = async path => {
      assert.equal(path, manifestPath);
      reads++;
      if (unavailable) throw Object.assign(new Error("PRIVATE-CONTENT, file PRIVATE-PATH"), { code: "EIO", path: "PRIVATE-PATH" });
      return readFile(path, "utf8");
    };
    assert.equal(await store.prune(), 0);
    assert.equal(reads, 1, "the metadata read failure must actually be injected");
    assert.deepEqual(await readFile(upload.file), WAV);
    assert.equal(await readFile(owner, "utf8"), ownerText);
    assert.deepEqual(warnings, [{ message: "media upload storage unavailable", fields: { code: "storage-unavailable" } }]);
    assert.equal(JSON.stringify(warnings).includes("PRIVATE"), false);
    unavailable = false;
    assert.equal(await store.prune(upload.manifest.createdAt + MEDIA_OUTPUT_RETENTION_MS), 1);
    assert.equal(reads, 2);
    assert.equal(await store.getUploaded(upload.manifest.id), null);
    await assert.rejects(readFile(owner), { code: "ENOENT" });
    assert.equal(warnings.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
