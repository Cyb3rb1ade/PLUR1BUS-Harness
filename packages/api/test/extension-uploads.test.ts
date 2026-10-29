import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ExtensionUploads } from "../src/extension-uploads.ts";

const ct = "multipart/form-data; boundary=upload-boundary";
const multipart = (bytes: Buffer) =>
  Buffer.concat([
    Buffer.from(
      '--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="../private.p1x"\r\nContent-Type: application/octet-stream\r\n\r\n',
    ),
    bytes,
    Buffer.from("\r\n--upload-boundary--\r\n"),
  ]);
async function* pieces(bytes: Buffer, size = 1) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
async function fixture(t: import("node:test").TestContext, maxBytes = 1024) {
  const home = await mkdtemp(join(tmpdir(), "extensions-upload-"));
  let now = 10_000;
  const uploads = new ExtensionUploads({ home, now: () => now, maxBytes: () => maxBytes });
  t.after(async () => {
    uploads.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    uploads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("streamed multipart preserves binary/false boundaries and publishes only opaque owner-bound metadata", async (t) => {
  const { home, uploads } = await fixture(t);
  const bytes = Buffer.from(
    "\u0000payload\r\n--upload-boundaryX\u00ff\r\n--upload-boundary--X\r\n--upload-boundary--\rX",
    "utf8",
  );
  const result = await uploads.receive(pieces(multipart(bytes)), ct, "alice");
  assert.deepEqual(Object.keys(result).sort(), ["expiresAt", "sha256", "uploadId"]);
  assert.match(result.uploadId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.expiresAt, 610_000);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  const path = join(home, "run", "uploads", result.uploadId);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(JSON.parse(await readFile(path + ".json", "utf8")), {
    version: 1,
    userId: "alice",
    expiresAt: result.expiresAt,
    sha256: result.sha256,
    size: bytes.length,
  });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(home));
});
test("oversize, malformed, multiple-part and aborted streams leave no staged bytes or metadata", async (t) => {
  const { home, uploads } = await fixture(t, 8);
  for (const bytes of [
    multipart(Buffer.alloc(9)),
    multipart(Buffer.from("x")).subarray(0, -8),
    Buffer.from(
      '--upload-boundary\r\nContent-Disposition: form-data; name="path"\r\n\r\n/x\r\n--upload-boundary--\r\n',
    ),
    Buffer.from(
      '--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nx\r\n--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="b"\r\n\r\ny\r\n--upload-boundary--\r\n',
    ),
  ]) {
    await assert.rejects(uploads.receive(pieces(bytes), ct, "alice"));
    assert.deepEqual(await readdir(join(home, "run", "uploads")), []);
  }
  async function* aborted() {
    yield multipart(Buffer.from("x")).subarray(0, -8);
    throw new Error("connection gone");
  }
  await assert.rejects(uploads.receive(aborted(), ct, "alice"));
  assert.deepEqual(await readdir(join(home, "run", "uploads")), []);
});
test("expiry cleanup removes an unclaimed upload but preserves a supervisor's claimed upload", async (t) => {
  const { home, uploads, advance } = await fixture(t);
  const expired = await uploads.receive(pieces(multipart(Buffer.from("a"))), ct, "alice");
  const claimed = await uploads.receive(pieces(multipart(Buffer.from("b"))), ct, "bob");
  const { rename } = await import("node:fs/promises");
  await rename(
    join(home, "run", "uploads", claimed.uploadId + ".json"),
    join(home, "run", "uploads", `.${claimed.uploadId}.claim-${"a".repeat(32)}.json`),
  );
  advance(600_000);
  await uploads.cleanup();
  await assert.rejects(readFile(join(home, "run", "uploads", expired.uploadId)));
  assert.deepEqual(await readFile(join(home, "run", "uploads", claimed.uploadId)), Buffer.from("b"));
  advance(600_000);
  await uploads.cleanup();
  await assert.rejects(readFile(join(home, "run", "uploads", claimed.uploadId)));
});
