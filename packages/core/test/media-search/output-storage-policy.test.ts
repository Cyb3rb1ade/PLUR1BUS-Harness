import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMediaOutputStore, MEDIA_OUTPUT_QUOTA_BYTES, MEDIA_OUTPUT_RETENTION_MS } from "../../src/media-output-store.ts";

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
