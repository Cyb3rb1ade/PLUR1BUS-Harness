/** Raw uploads preserve channel bytes in a private namespace and share generated-output budgets. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MediaError, OutputStore } from "../src/index.ts";
import { makeLeakyPng, makeJpeg, riff, riffChunk } from "./adapters-fixtures.ts";

const PNG = makeLeakyPng();
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);
const code = (value: string) => (error: unknown) => error instanceof MediaError && error.code === value;

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), "media-upload-"));
  try {
    await run(join(directory, "outputs"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("uploads preserve raw bytes without invoking generation processing or generated-output listeners", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root, {
      embedMetadata: true,
      videoProcessor: async () => { throw new Error("raw uploads must not process video"); },
    });
    const generated: unknown[] = [];
    store.addListener({ onPut: manifest => generated.push(manifest) });
    for (const [kind, mimeType, data, format] of [
      ["image", "image/png", PNG, "png"],
      ["audio", "audio/wav", WAV, "wav"],
      ["video", "video/mp4", MP4, "mp4"],
    ] as const) {
      const uploaded = await store.putUploaded({ kind, mimeType, data, filename: "camera.png" });
      assert.match(uploaded.manifest.id, /^[a-f0-9-]{36}$/);
      assert.equal(uploaded.manifest.schema, "media.upload/1");
      assert.equal(uploaded.manifest.kind, kind);
      assert.equal(uploaded.manifest.mimeType, mimeType);
      assert.equal(uploaded.manifest.filename, "camera.png");
      assert.equal(uploaded.manifest.file.path, `0.${format}`);
      assert.equal(uploaded.manifest.file.format, format);
      assert.equal(uploaded.manifest.file.bytes, data.length);
      assert.equal(uploaded.manifest.file.sha256, createHash("sha256").update(data).digest("hex"));
      assert.deepEqual(await fs.readFile(uploaded.file), data);
      assert.deepEqual(await store.getUploaded(uploaded.manifest.id), uploaded);
      assert.equal(await store.get(uploaded.manifest.id), null);
      assert.equal("prompt" in uploaded.manifest, false);
      assert.equal("parameters" in uploaded.manifest, false);
      if (process.platform !== "win32") {
        for (const directory of [root, join(root, ".uploads"), join(root, ".uploads", uploaded.manifest.id)]) {
          assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        }
        assert.equal((await fs.stat(uploaded.file)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(join(root, ".uploads", uploaded.manifest.id, "manifest.json"))).mode & 0o777, 0o600);
      }
    }
    assert.deepEqual(generated, []);
  });
});

test("upload MIME and kind must match supported magic and authoritative nonempty bounded bytes", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const invalid = [
      { kind: "image", mimeType: "image/jpeg", data: PNG },
      { kind: "audio", mimeType: "image/png", data: PNG },
      { kind: "video", mimeType: "video/mp4", data: WAV },
      { kind: "image", mimeType: "image/svg+xml", data: Buffer.from("<svg/>") },
      { kind: "image", mimeType: "image/png", data: Buffer.from("not media") },
      { kind: "image", mimeType: "image/png", data: Buffer.alloc(0) },
      { kind: "document", mimeType: "image/png", data: PNG },
    ];
    for (const value of invalid) {
      await assert.rejects(store.putUploaded(value as Parameters<OutputStore["putUploaded"]>[0]),
        code("unsupported_parameter"));
    }
    await assert.rejects(store.putUploaded({
      kind: "image", mimeType: "image/png", data: Buffer.alloc(25 * 1024 * 1024 + 1),
    }), code("too_large"));
    assert.equal(await store.getUploaded("missing"), null);
  });
});

test("filenames cannot select paths or identifiers and duplicate filenames never replace an upload", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const first = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG,
      filename: "../../outside\\evil\u0000.png" });
    const second = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG,
      filename: "../../outside\\evil\u0000.png" });
    assert.notEqual(first.manifest.id, second.manifest.id);
    assert.equal(first.file, join(root, ".uploads", first.manifest.id, "0.png"));
    assert.doesNotMatch(first.manifest.filename ?? "", /[/\\\u0000-\u001f]/);
    assert.ok((first.manifest.filename ?? "").length <= 160);
    assert.deepEqual(await fs.readFile(first.file), PNG);
    await assert.rejects(store.getUploaded("../../outside"), code("unsupported_parameter"));
    await assert.rejects(store.deleteUploaded("../../outside"), code("unsupported_parameter"));
  });
});

test("uploads and generated images share quota in both directions and deletion releases capacity", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const uploaded = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const generated = await store.put("generated", { prompt: "tree" }, {
      files: [{ bytes: PNG, format: "png" }], metadata: { adapter: "fixture", model: "fixture", durationMs: 1 },
    });
    const limited = new OutputStore(root, { quotaBytes: 1 });
    await assert.rejects(limited.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }), code("quota"));
    await assert.rejects(limited.put("another", { prompt: "tree" }, {
      files: [{ bytes: PNG, format: "png" }], metadata: { adapter: "fixture", model: "fixture", durationMs: 1 },
    }), code("quota"));
    assert.deepEqual(await store.get("generated"), generated);
    await store.delete("generated");
    const quota = uploaded.manifest.file.bytes + Buffer.byteLength(JSON.stringify(uploaded.manifest));
    const oneOnly = new OutputStore(root, { quotaBytes: quota });
    await assert.rejects(oneOnly.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }), code("quota"));
    await store.deleteUploaded(uploaded.manifest.id);
    await oneOnly.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
  });
});

test("upload deletion and retention notify only upload listeners and preserve generated output contracts", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root, { retentionMs: 1000 });
    const deleted: string[] = [];
    const generatedDeleted: string[] = [];
    store.addListener({ onDelete: id => generatedDeleted.push(id), onDeleteUploaded: id => { deleted.push(id); } });
    const uploaded = await store.putUploaded({ kind: "audio", mimeType: "audio/wav", data: WAV });
    assert.equal(await store.prune(uploaded.manifest.createdAt + 999), 0);
    assert.equal(await store.prune(uploaded.manifest.createdAt + 1000), 1);
    assert.deepEqual(deleted, [uploaded.manifest.id]);
    assert.deepEqual(generatedDeleted, []);
    assert.equal(await store.getUploaded(uploaded.manifest.id), null);
    await store.deleteUploaded(uploaded.manifest.id);
    const next = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    await store.deleteUploaded(next.manifest.id);
    assert.equal(await store.getUploaded(next.manifest.id), null);
  });
});

test("failed atomic upload publication cleans private staging and releases its lock", async t => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const original = fs.rename;
    const rename = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[0]).includes(".stage-")) throw new Error("synthetic publication failure with private path");
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }),
        code("backend_unavailable"));
      assert.deepEqual((await fs.readdir(root)).sort(), [".upload-index", ".uploads"]);
      assert.deepEqual(await fs.readdir(join(root, ".upload-index")), [], "failed publication leaves no durable quota entry");
      assert.deepEqual(await fs.readdir(join(root, ".uploads")), []);
    } finally {
      rename.mock.restore();
      syncBuiltinESMExports();
    }
    await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
  });
});

test("upload readers fail closed on tampered manifests, byte hashes and symlink namespaces", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const manifestPath = join(root, ".uploads", upload.manifest.id, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ ...upload.manifest,
      file: { ...upload.manifest.file, path: "../../outside" } }));
    await assert.rejects(store.getUploaded(upload.manifest.id), code("backend_unavailable"));
    await fs.writeFile(manifestPath, JSON.stringify(upload.manifest));
    await fs.writeFile(upload.file, Buffer.from("corrupt"));
    await assert.rejects(store.getUploaded(upload.manifest.id), code("backend_unavailable"));
  });
  await withRoot(async root => {
    const outside = `${root}-outside`;
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, join(root, ".uploads"), process.platform === "win32" ? "junction" : "dir");
    try {
      const store = new OutputStore(root);
      await assert.rejects(store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }),
        code("backend_unavailable"));
      assert.deepEqual(await fs.readdir(outside), []);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("a published manifest with missing bytes is corruption rather than an absent upload", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    await fs.rm(upload.file);
    await assert.rejects(store.getUploaded(upload.manifest.id), code("backend_unavailable"));
    assert.ok(await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }));
  });
});

test("a quota that fits either media namespace separately cannot admit both", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const upload = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const generated = await store.put("generated", { prompt: "tree" }, {
      files: [{ bytes: PNG, format: "png" }], metadata: { adapter: "fixture", model: "fixture", durationMs: 1 },
    });
    const uploadSize = (await fs.stat(upload.file)).size
      + (await fs.stat(join(root, ".uploads", upload.manifest.id, "manifest.json"))).size;
    const generatedSize = (await fs.stat(join(root, generated.id, "0.png"))).size
      + (await fs.stat(join(root, generated.id, "manifest.json"))).size;
    await store.deleteUploaded(upload.manifest.id);
    await store.delete(generated.id);
    const limited = new OutputStore(root, { quotaBytes: Math.max(uploadSize, generatedSize) });
    const first = await limited.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    await assert.rejects(limited.put("generated", { prompt: "tree" }, {
      files: [{ bytes: PNG, format: "png" }], metadata: { adapter: "fixture", model: "fixture", durationMs: 1 },
    }), code("quota"));
    await limited.deleteUploaded(first.manifest.id);
    await limited.put("generated", { prompt: "tree" }, {
      files: [{ bytes: PNG, format: "png" }], metadata: { adapter: "fixture", model: "fixture", durationMs: 1 },
    });
    await assert.rejects(limited.putUploaded({ kind: "image", mimeType: "image/png", data: PNG }), code("quota"));
  });
});

test("concurrent uploads cannot overcommit quota across store instances", async () => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const first = await store.putUploaded({ kind: "image", mimeType: "image/png", data: PNG });
    const size = (await fs.stat(first.file)).size
      + (await fs.stat(join(root, ".uploads", first.manifest.id, "manifest.json"))).size;
    await store.deleteUploaded(first.manifest.id);
    const limited = () => new OutputStore(root, { quotaBytes: size });
    const outcomes = await Promise.allSettled([
      limited().putUploaded({ kind: "image", mimeType: "image/png", data: PNG }),
      limited().putUploaded({ kind: "image", mimeType: "image/png", data: PNG }),
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected" && code("quota")(result.reason)).length, 1);
    assert.equal((await fs.readdir(join(root, ".uploads"))).length, 1);
  });
});

test("an upload snapshots caller bytes before waiting for a busy store", async t => {
  await withRoot(async root => {
    const store = new OutputStore(root);
    const lock = join(root, ".lock");
    await fs.mkdir(lock, { recursive: true });
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const original = fs.mkdir;
    const mkdir = t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      try { return await original(...args); }
      catch (error) {
        if (String(args[0]) === lock && (error as NodeJS.ErrnoException).code === "EEXIST") {
          // Finish the failed mkdir before removing the directory: Windows can otherwise
          // report a deletion-in-progress error instead of the intended busy-lock result.
          entered.resolve();
          await released.promise;
        }
        throw error;
      }
    });
    syncBuiltinESMExports();
    try {
      const data = Buffer.from(PNG);
      const pending = store.putUploaded({ kind: "image", mimeType: "image/png", data });
      data.fill(0);
      await Promise.race([entered.promise, pending.then(() => assert.fail("upload bypassed the held lock"))]);
      await fs.rm(lock, { recursive: true });
      released.resolve();
      const upload = await pending;
      assert.deepEqual(await fs.readFile(upload.file), PNG);
      assert.deepEqual(await store.getUploaded(upload.manifest.id), upload);
    } finally {
      released.resolve();
      mkdir.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test("supported binary container headers select fixed extensions regardless of remote names", async () => {
  const ogg = (packet: Buffer) => {
    const header = Buffer.alloc(28);
    header.write("OggS");
    header[26] = 1;
    header[27] = packet.length;
    return Buffer.concat([header, packet]);
  };
  const m4a = Buffer.from(MP4);
  m4a.write("M4A ", 8);
  const mov = Buffer.from(MP4);
  mov.write("qt  ", 8);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const id3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(7), mp3]);
  await withRoot(async root => {
    const store = new OutputStore(root);
    for (const [kind, mimeType, data, extension] of [
      ["image", "image/jpeg", makeJpeg(), "jpeg"],
      ["image", "image/webp", riff([riffChunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]))]), "webp"],
      ["image", "image/gif", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00", "latin1"), "gif"],
      ["audio", "audio/x-wav", WAV, "wav"],
      ["audio", "audio/flac", Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(38)]), "flac"],
      ["audio", "audio/aac", Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0xff, 0xfc]), "aac"],
      ["audio", "audio/mpeg", mp3, "mp3"],
      ["audio", "audio/mp3", id3, "mp3"],
      ["audio", "audio/ogg", ogg(Buffer.from("OpusHead")), "ogg"],
      ["audio", "audio/ogg", ogg(Buffer.from("\x01vorbis")), "ogg"],
      ["audio", "audio/ogg", ogg(Buffer.from("\x7fFLAC")), "ogg"],
      ["audio", "audio/mp4", m4a, "m4a"],
      ["audio", "audio/x-m4a", m4a, "m4a"],
      ["audio", "audio/webm", webm, "webm"],
      ["video", "video/quicktime", mov, "mov"],
      ["video", "video/webm", webm, "webm"],
      ["video", "video/ogg", ogg(Buffer.from("\x80theora", "latin1")), "ogv"],
    ] as const) {
      const uploaded = await store.putUploaded({ kind, mimeType, data, filename: "remote.exe" });
      assert.equal(uploaded.manifest.file.path, `0.${extension}`);
      assert.deepEqual(await fs.readFile(uploaded.file), data);
      assert.deepEqual(await store.getUploaded(uploaded.manifest.id), uploaded);
    }
    for (const [kind, mimeType, data] of [
      ["audio", "audio/ogg", ogg(Buffer.from("\x80theora", "latin1"))],
      ["video", "video/ogg", ogg(Buffer.from("OpusHead"))],
      ["audio", "audio/mp4", MP4],
      ["video", "video/mp4", m4a],
      ["video", "video/webm", Buffer.from("not-webm")],
      ["audio", "audio/mpeg", Buffer.concat([Buffer.from("ID3"), Buffer.alloc(7)])],
      ["audio", "audio/mpeg", Buffer.from([0xff, 0xfb, 0xf0, 0])],
      ["image", "toString", PNG],
    ] as const) {
      await assert.rejects(store.putUploaded({ kind, mimeType, data }), code("unsupported_parameter"));
    }
  });
});
