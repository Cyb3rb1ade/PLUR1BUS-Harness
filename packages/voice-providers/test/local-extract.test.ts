// F7: hostile archives through the REAL system tar, size caps, https-only URLs and the atomic directory swap.
// Archives are built in fresh temp directories and never executed. No network: a loopback server serves the bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, link, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadModel, isInstalled, tarExtract } from "../src/local/download.ts";
import type { CatalogModel } from "../src/local/catalog.ts";
import { isVoiceProviderError } from "../src/errors.ts";
import { startFakeVendor } from "./helpers/fake-vendor.ts";
import { modelBytes, sha256 } from "./helpers/fake-engine.ts";

const haveTar = spawnSync("tar", ["--version"]).status === 0;
const win = process.platform === "win32";
const tarOpts = { skip: haveTar ? false : "system tar is not available" };
const linkOpts = { skip: !haveTar ? "system tar is not available" : win ? "symlinks and hardlinks need privileges on win32" : false };

async function tmp(prefix = "voice-x-"): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

/** Build a .tar.bz2 from `args` (paths relative to cwd unless -P is used). */
function buildArchive(out: string, cwd: string, members: string[], extra: string[] = []): void {
  const r = spawnSync("tar", ["-cjf", out, ...extra, ...members], { cwd });
  assert.equal(r.status, 0, `tar create failed: ${r.stderr}`);
}

async function serve(files: Record<string, Uint8Array | Buffer>, chunked = false) {
  const v = await startFakeVendor({ http: (req, res) => {
    const d = files[req.url.slice(1)];
    if (!d) { res.statusCode = 404; res.end(); return; }
    if (chunked) { res.writeHead(200); res.write(Buffer.from(d)); res.end(); return; }
    res.writeHead(200, { "content-length": d.length });
    res.end(Buffer.from(d));
  } });
  return v;
}

function archiveModel(url: string, archive: Uint8Array, id = "arch", extra: Partial<CatalogModel["download"][number]> = {}): CatalogModel {
  return { id, kind: "tts", engine: "vits", displayName: "Arch", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url, sha256: sha256(archive), sizeBytes: archive.byteLength, archive: "tar.bz2", stripComponents: 1, ...extra }], roles: { model: "m.onnx" } };
}
function plainModel(url: string, bytes: Uint8Array, id = "plain", sizeBytes: number | null = bytes.byteLength): CatalogModel {
  return { id, kind: "tts", engine: "vits", displayName: "Plain", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url, sha256: sha256(bytes), sizeBytes, path: "m.bin" }], roles: { model: "m.bin" } };
}
const downloadFailed = (e: unknown) => isVoiceProviderError(e) && e.code === "download_failed";

async function assertNothingInstalled(dir: string, m: CatalogModel): Promise<void> {
  assert.equal(await isInstalled(dir, m), false);
  await assert.rejects(stat(join(dir, m.id)));
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith(".staging")), [], "staging is cleaned up");
}

test("a benign archive extracts through the real tar with strip-components and is installed", tarOpts, async () => {
  const work = await tmp();
  const dir = await tmp();
  try {
    await mkdir(join(work, "pkg"), { recursive: true });
    await writeFile(join(work, "pkg", "m.onnx"), "weights");
    buildArchive(join(work, "a.tar.bz2"), work, ["pkg"]);
    const bytes = await readFile(join(work, "a.tar.bz2"));
    const v = await serve({ "a.tar.bz2": bytes });
    try {
      const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes);
      await downloadModel(m, { modelsDir: dir });
      assert.equal(await readFile(join(dir, "arch", "m.onnx"), "utf8"), "weights");
      assert.equal(await isInstalled(dir, m), true);
    } finally { await v.close(); }
  } finally { await rm(work, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("an absolute-path member never lands outside the staging directory", tarOpts, async () => {
  const work = await tmp();
  const dir = await tmp();
  const outside = await tmp("voice-outside-");
  try {
    const target = join(outside, "abs.txt");
    await writeFile(target, "evil");
    buildArchive(join(work, "a.tar.bz2"), work, [target], ["-P"]);
    await rm(target);
    const bytes = await readFile(join(work, "a.tar.bz2"));
    const v = await serve({ "a.tar.bz2": bytes });
    try {
      const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes, "abs", { stripComponents: 0 });
      await downloadModel(m, { modelsDir: dir }).catch((e) => assert.ok(downloadFailed(e), String(e)));
      await assert.rejects(stat(target), "the absolute path was not recreated");
    } finally { await v.close(); }
  } finally { for (const d of [work, dir, outside]) await rm(d, { recursive: true, force: true }); }
});

test("a ../ traversal member is refused and nothing is written beside the models directory", tarOpts, async () => {
  const work = await tmp();
  const base = await tmp();
  const dir = join(base, "models");
  try {
    await mkdir(dir);
    await mkdir(join(work, "inner"));
    await writeFile(join(work, "evil.txt"), "evil");
    buildArchive(join(work, "a.tar.bz2"), join(work, "inner"), ["../evil.txt"], ["-P"]);
    const bytes = await readFile(join(work, "a.tar.bz2"));
    const v = await serve({ "a.tar.bz2": bytes });
    try {
      const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes, "trav", { stripComponents: 0 });
      await downloadModel(m, { modelsDir: dir }).catch((e) => assert.ok(downloadFailed(e), String(e)));
      await assert.rejects(stat(join(dir, "evil.txt")));
      await assert.rejects(stat(join(base, "evil.txt")));
      assert.equal(await isInstalled(dir, m), false);
    } finally { await v.close(); }
  } finally { await rm(work, { recursive: true, force: true }); await rm(base, { recursive: true, force: true }); }
});

test("a symlink member pointing outside is rejected after extraction and nothing is installed", linkOpts, async () => {
  const work = await tmp();
  const dir = await tmp();
  try {
    await mkdir(join(work, "pkg"));
    await writeFile(join(work, "pkg", "m.onnx"), "w");
    await symlink(tmpdir(), join(work, "pkg", "link"));
    buildArchive(join(work, "a.tar.bz2"), work, ["pkg"]);
    const bytes = await readFile(join(work, "a.tar.bz2"));
    const v = await serve({ "a.tar.bz2": bytes });
    try {
      const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes);
      await assert.rejects(downloadModel(m, { modelsDir: dir }), (e) => downloadFailed(e) && /unsafe/.test((e as Error).message) && !/link/.test((e as Error).message));
      await assertNothingInstalled(dir, m);
    } finally { await v.close(); }
  } finally { await rm(work, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("a hardlink member is rejected after extraction", linkOpts, async () => {
  const work = await tmp();
  const dir = await tmp();
  try {
    await mkdir(join(work, "pkg"));
    await writeFile(join(work, "pkg", "m.onnx"), "w");
    await link(join(work, "pkg", "m.onnx"), join(work, "pkg", "alias.onnx"));
    buildArchive(join(work, "a.tar.bz2"), work, ["pkg"]);
    const bytes = await readFile(join(work, "a.tar.bz2"));
    const v = await serve({ "a.tar.bz2": bytes });
    try {
      const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes);
      await assert.rejects(downloadModel(m, { modelsDir: dir }), (e) => downloadFailed(e) && /unsafe/.test((e as Error).message));
      await assertNothingInstalled(dir, m);
    } finally { await v.close(); }
  } finally { await rm(work, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("an archive that expands past the size cap is rejected (compression bomb)", tarOpts, async () => {
  const work = await tmp();
  const dir = await tmp();
  try {
    await mkdir(join(work, "pkg"));
    await writeFile(join(work, "pkg", "m.onnx"), Buffer.alloc(200_000));
    buildArchive(join(work, "a.tar.bz2"), work, ["pkg"]);
    const bytes = await readFile(join(work, "a.tar.bz2"));
    assert.ok(bytes.byteLength < 2000, "the fixture really is highly compressed");
    const v = await serve({ "a.tar.bz2": bytes });
    try {
      const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes);
      await assert.rejects(downloadModel(m, { modelsDir: dir, maxBytes: 5000 }), downloadFailed);
      await assertNothingInstalled(dir, m);
    } finally { await v.close(); }
  } finally { await rm(work, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("a corrupt archive makes the real tar fail and the error is a plain download_failed without command line or stderr", tarOpts, async () => {
  const dir = await tmp();
  const bytes = modelBytes(3, 400);
  const v = await serve({ "a.tar.bz2": bytes });
  try {
    const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes);
    await assert.rejects(downloadModel(m, { modelsDir: dir }), (e) => downloadFailed(e) && !/tar -|bzip|--strip/i.test((e as Error).message));
    await assertNothingInstalled(dir, m);
    await assert.rejects(tarExtract(join(dir, "missing.tar.bz2"), join(dir, "out"), { format: "tar.bz2", stripComponents: 0 }), downloadFailed);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the audit also covers an injected extractor: symlinks, too many entries", { skip: win ? "symlinks need privileges on win32" : false }, async () => {
  const dir = await tmp();
  const bytes = modelBytes(5, 300);
  const v = await serve({ "a.tar.bz2": bytes });
  try {
    const m = archiveModel(`${v.httpUrl}/a.tar.bz2`, bytes);
    await assert.rejects(downloadModel(m, { modelsDir: dir, extract: async (_a, dest) => { await writeFile(join(dest, "m.onnx"), "x"); await symlink("/", join(dest, "root")); } }), downloadFailed);
    await assertNothingInstalled(dir, m);
    await assert.rejects(downloadModel(m, { modelsDir: dir, maxEntries: 3, extract: async (_a, dest) => { for (let i = 0; i < 5; i++) await writeFile(join(dest, `f${i}`), "x"); } }), downloadFailed);
    await assertNothingInstalled(dir, m);
    await downloadModel(m, { modelsDir: dir, extract: async (_a, dest) => { await mkdir(join(dest, "sub")); await writeFile(join(dest, "sub", "m.onnx"), "x"); } });
    assert.equal(await isInstalled(dir, m), true);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("download URLs must be https (plain http only to loopback); nothing is fetched otherwise", async () => {
  const dir = await tmp();
  try {
    const bytes = modelBytes(1, 100);
    const m = plainModel("http://models.example.invalid/m.bin", bytes);
    await assert.rejects(downloadModel(m, { modelsDir: dir, fetch: async () => { throw new Error("must not fetch"); } }), (e) => isVoiceProviderError(e) && e.code === "config");
    const ok = plainModel("https://models.example.invalid/m.bin", bytes);
    let fetched = 0;
    await downloadModel(ok, { modelsDir: dir, fetch: async () => { fetched++; return new Response(Buffer.from(bytes), { headers: { "content-length": String(bytes.length) } }); } });
    assert.equal(fetched, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a redirect to plain http is refused", async () => {
  const dir = await tmp();
  try {
    const bytes = modelBytes(1, 100);
    const m = plainModel("https://models.example.invalid/m.bin", bytes);
    const res = new Response(Buffer.from(bytes));
    Object.defineProperty(res, "url", { value: "http://elsewhere.example.invalid/m.bin" });
    await assert.rejects(downloadModel(m, { modelsDir: dir, fetch: async () => res }), downloadFailed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("size caps: a body larger than the catalog size, or than maxBytes when the size is unknown, is cut off", async () => {
  const dir = await tmp();
  const big = modelBytes(9, 5000);
  const v = await serve({ "big.bin": big });
  const vc = await serve({ "big.bin": big }, true);
  try {
    // Content-Length already over the catalog size.
    const small = plainModel(`${v.httpUrl}/big.bin`, big, "cap1", 1000);
    await assert.rejects(downloadModel(small, { modelsDir: dir }), (e) => downloadFailed(e) && /exceeds size limit/.test((e as Error).message));
    // No Content-Length (chunked): caught while streaming, partial removed.
    const chunked = plainModel(`${vc.httpUrl}/big.bin`, big, "cap2", 1000);
    await assert.rejects(downloadModel(chunked, { modelsDir: dir }), (e) => downloadFailed(e) && /exceeds size limit/.test((e as Error).message));
    await assert.rejects(stat(join(dir, ".downloads", "cap2", "0.part")));
    // Unknown catalog size: maxBytes applies.
    const unknown = plainModel(`${v.httpUrl}/big.bin`, big, "cap3", null);
    await assert.rejects(downloadModel(unknown, { modelsDir: dir, maxBytes: 2000 }), (e) => downloadFailed(e) && /exceeds size limit/.test((e as Error).message));
    await downloadModel(unknown, { modelsDir: dir, maxBytes: 6000 });
    assert.equal(await isInstalled(dir, unknown), true);
  } finally { await v.close(); await vc.close(); await rm(dir, { recursive: true, force: true }); }
});

test("atomic swap: a failed reinstall keeps the previous version; a good one replaces it without leftovers", async () => {
  const dir = await tmp();
  const v1 = modelBytes(1, 400);
  const v2 = modelBytes(2, 500);
  const srv = await serve({ "v1.bin": v1, "v2.bin": v2 });
  try {
    const m1 = plainModel(`${srv.httpUrl}/v1.bin`, v1, "swap");
    const m2 = plainModel(`${srv.httpUrl}/v2.bin`, v2, "swap");
    await downloadModel(m1, { modelsDir: dir });
    assert.equal(await isInstalled(dir, m1), true);

    // The second rename (staging -> dir) fails: the old directory is put back.
    await assert.rejects(downloadModel(m2, { modelsDir: dir, rename: async (from, to) => { if (from.includes(".staging-")) throw new Error("EPERM"); const { rename } = await import("node:fs/promises"); await rename(from, to); } }), downloadFailed);
    assert.equal(await isInstalled(dir, m1), true, "the previous version survived");
    assert.deepEqual([...(await readFile(join(dir, "swap", "m.bin")))], [...v1]);
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".old-") || n.startsWith(".staging")), []);

    await downloadModel(m2, { modelsDir: dir });
    assert.equal(await isInstalled(dir, m2), true);
    assert.deepEqual([...(await readFile(join(dir, "swap", "m.bin")))], [...v2]);
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".old-")), []);
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});

test("leftovers of a crashed swap are recovered: a missing model directory is restored, a stale one removed", async () => {
  const dir = await tmp();
  const v1 = modelBytes(1, 400);
  const srv = await serve({ "v1.bin": v1 });
  try {
    const m1 = plainModel(`${srv.httpUrl}/v1.bin`, v1, "rec");
    await downloadModel(m1, { modelsDir: dir });
    const { rename } = await import("node:fs/promises");
    await rename(join(dir, "rec"), join(dir, "rec.old-4242"));
    await downloadModel(m1, { modelsDir: dir, fetch: async () => { throw new Error("must not fetch"); } });
    assert.equal(await isInstalled(dir, m1), true, "restored from the aside copy");
    await mkdir(join(dir, "rec.old-9999"));
    await downloadModel(m1, { modelsDir: dir, fetch: async () => { throw new Error("must not fetch"); } });
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".old-")), []);
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});
