import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadModel, isInstalled, type DownloadProgress } from "../src/local/download.ts";
import { loadCatalog, type CatalogModel } from "../src/local/catalog.ts";
import { isVoiceProviderError } from "../src/errors.ts";
import { startFakeVendor } from "./helpers/fake-vendor.ts";
import { modelBytes, sha256, testCatalogOverride, testFiles } from "./helpers/fake-engine.ts";

async function tmp(): Promise<string> { return mkdtemp(join(tmpdir(), "voice-dl-")); }

interface ServerOpts { ignoreRange?: boolean; cutAfter?: number; corrupt?: boolean }
async function server(files: Record<string, Uint8Array>, opts: ServerOpts = {}) {
  const log: Array<{ url: string; range: string | undefined }> = [];
  let cutDone = false;
  const v = await startFakeVendor({ http: async (req, res) => {
    const name = req.url.slice(1);
    const data = files[name];
    log.push({ url: name, range: req.headers.range });
    if (!data) { res.statusCode = 404; res.end(); return; }
    let start = 0;
    const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
    if (m && !opts.ignoreRange) start = Number(m[1]);
    const body = Buffer.from(opts.corrupt ? data.map((b) => b ^ 1) : data).subarray(start);
    if (start > 0) res.writeHead(206, { "content-length": body.length, "content-range": `bytes ${start}-${data.length - 1}/${data.length}` });
    else res.writeHead(200, { "content-length": body.length });
    if (opts.cutAfter !== undefined && !cutDone) {
      cutDone = true;
      await new Promise<void>((r) => res.write(body.subarray(0, opts.cutAfter), () => r()));
      res.socket!.end();
      return;
    }
    res.end(body);
  } });
  return { v, log };
}

function modelOf(base: string, files: Record<string, Uint8Array>, id = "t-stt-de"): CatalogModel {
  return loadCatalog(testCatalogOverride(base, files)).models[id]!;
}

test("download writes the verified file, reports monotonic progress, marks the model complete, and is idempotent", async () => {
  const files = testFiles();
  const { v, log } = await server(files);
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    const seen: DownloadProgress[] = [];
    const out = await downloadModel(m, { modelsDir: dir, onProgress: (p) => seen.push(p) });
    assert.deepEqual([...(await readFile(join(out, "t-stt-de.bin")))], [...files["t-stt-de.bin"]!]);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((p, i) => i === 0 || p.receivedBytes >= seen[i - 1]!.receivedBytes));
    assert.equal(seen.at(-1)!.receivedBytes, files["t-stt-de.bin"]!.byteLength);
    assert.equal(seen.at(-1)!.totalBytes, files["t-stt-de.bin"]!.byteLength);
    assert.equal(await isInstalled(dir, m), true);
    assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith(".staging")), []);
    await downloadModel(m, { modelsDir: dir });
    assert.equal(log.length, 1, "an installed model is not fetched again");
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an interrupted download fails with download_failed and a retry completes it", async () => {
  const files = testFiles();
  const { v } = await server(files, { cutAfter: 1200 });
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    await assert.rejects(downloadModel(m, { modelsDir: dir }), (e) => isVoiceProviderError(e) && e.code === "download_failed");
    assert.equal(await isInstalled(dir, m), false);
    await downloadModel(m, { modelsDir: dir });
    assert.deepEqual([...(await readFile(join(dir, m.id, "t-stt-de.bin")))], [...files["t-stt-de.bin"]!]);
    assert.equal(await isInstalled(dir, m), true);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("resume: an existing partial is hashed, continued with a Range request, and the whole file verifies", async () => {
  const files = testFiles();
  const { v, log } = await server(files);
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    await mkdir(join(dir, ".downloads", m.id), { recursive: true });
    await writeFile(join(dir, ".downloads", m.id, "0.part"), files["t-stt-de.bin"]!.subarray(0, 1200));
    const seen: DownloadProgress[] = [];
    await downloadModel(m, { modelsDir: dir, onProgress: (p) => seen.push(p) });
    assert.equal(log.length, 1);
    assert.equal(log[0]!.range, "bytes=1200-");
    assert.ok(seen[0]!.receivedBytes > 1200, "progress counts the resumed bytes");
    assert.deepEqual([...(await readFile(join(dir, m.id, "t-stt-de.bin")))], [...files["t-stt-de.bin"]!]);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a partial that is already complete is verified without another request", async () => {
  const files = testFiles();
  const { v, log } = await server(files);
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    await mkdir(join(dir, ".downloads", m.id), { recursive: true });
    await writeFile(join(dir, ".downloads", m.id, "0.part"), files["t-stt-de.bin"]!);
    await downloadModel(m, { modelsDir: dir });
    assert.equal(log.length, 0);
    assert.equal(await isInstalled(dir, m), true);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a server that ignores Range restarts from byte zero and still verifies", async () => {
  const files = testFiles();
  const { v } = await server(files, { ignoreRange: true });
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    await mkdir(join(dir, ".downloads", m.id), { recursive: true });
    await writeFile(join(dir, ".downloads", m.id, "0.part"), files["t-stt-de.bin"]!.subarray(0, 500));
    await downloadModel(m, { modelsDir: dir });
    assert.deepEqual([...(await readFile(join(dir, m.id, "t-stt-de.bin")))], [...files["t-stt-de.bin"]!]);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a checksum mismatch discards the download and nothing is installed", async () => {
  const files = testFiles();
  const { v } = await server(files, { corrupt: true });
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    await assert.rejects(downloadModel(m, { modelsDir: dir }), (e) => isVoiceProviderError(e) && e.code === "checksum_mismatch");
    assert.equal(await isInstalled(dir, m), false);
    await assert.rejects(stat(join(dir, ".downloads", m.id, "0.part")));
    await assert.rejects(stat(join(dir, m.id)));
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a corrupt stale partial is also caught (resume hashes the bytes already on disk)", async () => {
  const files = testFiles();
  const { v } = await server(files);
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    await mkdir(join(dir, ".downloads", m.id), { recursive: true });
    await writeFile(join(dir, ".downloads", m.id, "0.part"), modelBytes(99, 700));
    await assert.rejects(downloadModel(m, { modelsDir: dir }), (e) => isVoiceProviderError(e) && e.code === "checksum_mismatch");
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("non-commercial or unconfirmed licences are refused before any request unless confirmed", async () => {
  const files = testFiles();
  const { v, log } = await server(files);
  const dir = await tmp();
  try {
    const nc = modelOf(v.httpUrl, files, "t-tts-de-nc");
    await assert.rejects(downloadModel(nc, { modelsDir: dir }), (e) => isVoiceProviderError(e) && e.code === "licence_required" && /NON-COMMERCIAL/.test(e.message));
    assert.equal(log.length, 0);
    await downloadModel(nc, { modelsDir: dir, acceptedLicences: ["t-tts-de-nc@CC-BY-NC"] });
    assert.equal(log.length, 1);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("unpinned or URL-less catalog entries refuse to download", async () => {
  const dir = await tmp();
  try {
    const c = loadCatalog({});
    await assert.rejects(downloadModel(c.models["kokoro-multi"]!, { modelsDir: dir, fetch: async () => { throw new Error("must not fetch"); } }), (e) => isVoiceProviderError(e) && e.code === "catalog" && /sha256/.test(e.message));
    const kroko = { ...c.models["kroko-de"]!, licence: { ...c.models["kroko-de"]!.licence, commercial: true as const, status: "confirmed" as const } };
    await assert.rejects(downloadModel(kroko, { modelsDir: dir }), (e) => isVoiceProviderError(e) && e.code === "catalog");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("archives are verified, then handed to the extractor with strip-components, and land in the model directory", async () => {
  const archive = modelBytes(7, 2500);
  const { v } = await server({ "pkg.tar.bz2": archive });
  const dir = await tmp();
  try {
    const m: CatalogModel = { id: "arch", kind: "tts", engine: "vits", displayName: "Arch", licence: { id: "MIT", name: "MIT", commercial: true, status: "confirmed" }, download: [{ url: `${v.httpUrl}/pkg.tar.bz2`, sha256: sha256(archive), sizeBytes: archive.byteLength, archive: "tar.bz2", stripComponents: 1 }], roles: { model: "m.onnx" } };
    let call: { size: number; strip: number } | undefined;
    await downloadModel(m, { modelsDir: dir, extract: async (file, dest, o) => { call = { size: (await stat(file)).size, strip: o.stripComponents }; await writeFile(join(dest, "m.onnx"), "x"); } });
    assert.deepEqual(call, { size: 2500, strip: 1 });
    assert.equal(await readFile(join(dir, "arch", "m.onnx"), "utf8"), "x");
    assert.equal(await isInstalled(dir, m), true);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});

test("abort stops the download with an aborted error and keeps the partial for resume", async () => {
  const files = testFiles();
  const { v } = await server(files);
  const dir = await tmp();
  try {
    const m = modelOf(v.httpUrl, files);
    const ctl = new AbortController();
    await assert.rejects(downloadModel(m, { modelsDir: dir, signal: ctl.signal, onProgress: () => ctl.abort() }), (e) => isVoiceProviderError(e) && e.code === "aborted");
    assert.equal(await isInstalled(dir, m), false);
  } finally { await v.close(); await rm(dir, { recursive: true, force: true }); }
});
