import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, chmod, mkdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFfmpegPorts } from "../../src/media-search/ffmpeg.ts";

// 20-byte "PNG": signature + IEND chunk. Enough for the frame splitter.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.from([0xae, 0x42, 0x60, 0x82])]);
const code = (c: string) => (e: unknown) => (e as { error?: string }).error === c;

type Cfg = { mode: "frames" | "hang" | "big" | "fail" | "pcm" | "probe"; sceneEmpty?: boolean; frames?: number; samples?: number };
let root = ""; let n = 0;
async function fake(cfg: Cfg): Promise<{ bin: string; record: string; argvs: () => Promise<string[][]> }> {
  const bin = join(root, `fake-${n++}`); const record = `${bin}.argv`;
  const src = `#!${process.execPath}
const fs = require("node:fs"); const cfg = ${JSON.stringify(cfg)}; const png = Buffer.from(${JSON.stringify(PNG.toString("base64"))}, "base64");
const argv = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(argv) + "\\n");
process.stdout.on("error", () => process.exit(0));
if (cfg.mode === "hang") setInterval(() => {}, 1000);
else if (cfg.mode === "fail") { process.stderr.write("nope\\n"); process.exit(1); }
else if (cfg.mode === "probe") { process.stdout.write("12.5\\n"); }
else if (cfg.mode === "big") { const chunk = Buffer.alloc(65536, 1); const w = () => { while (process.stdout.write(chunk)) {} process.stdout.once("drain", w); }; w(); }
else if (cfg.mode === "frames") {
  const scene = argv.some((a) => a.includes("scene"));
  if (scene && cfg.sceneEmpty) process.exit(0);
  const k = cfg.frames ?? 2;
  for (let i = 0; i < k; i++) { process.stderr.write("[Parsed_showinfo_1 @ 0x1] n:   " + i + " pts: 0 pts_time:" + (i * 2.5) + " pos: 1\\n"); process.stdout.write(png); }
}
else if (cfg.mode === "pcm") { const f = new Float32Array(cfg.samples ?? 10); for (let i = 0; i < f.length; i++) f[i] = i / 100; process.stdout.write(Buffer.from(f.buffer)); }
`;
  await writeFile(bin, src); await chmod(bin, 0o755);
  return { bin, record, argvs: async () => (await readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) };
}
async function setup(cfg: Cfg, extra: Record<string, unknown> = {}) {
  const f = await fake(cfg); const tempDir = join(root, `tmp-${n++}`); await mkdir(tempDir);
  const ports = createFfmpegPorts({ ffmpegPath: f.bin, tempDir, timeoutMs: 5000, ...extra });
  return { f, tempDir, ports };
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of it) out.push(x); return out; }

before(async () => { root = await mkdtemp(join(tmpdir(), "ffmpeg-test-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

describe("createFfmpegPorts resolution", () => {
  it("returns null ports when the binary is missing", () => {
    const p = createFfmpegPorts({ ffmpegPath: join(root, "does-not-exist"), tempDir: root });
    assert.equal(p.frames, null); assert.equal(p.audio, null);
  });
  it("returns null ports when PATH has no ffmpeg", () => {
    const saved = process.env["PATH"]; process.env["PATH"] = join(root, "empty-dir");
    try { const p = createFfmpegPorts({ tempDir: root }); assert.equal(p.frames, null); assert.equal(p.audio, null); } finally { process.env["PATH"] = saved; }
  });
  it("finds ffmpeg on PATH", async () => {
    const dir = join(root, "pathdir"); await mkdir(dir);
    const f = await fake({ mode: "frames" }); const { copyFile } = await import("node:fs/promises"); await copyFile(f.bin, join(dir, "ffmpeg")); await chmod(join(dir, "ffmpeg"), 0o755);
    const saved = process.env["PATH"]; process.env["PATH"] = dir;
    try { const p = createFfmpegPorts({ tempDir: root }); assert.ok(p.frames); assert.ok(p.audio); } finally { process.env["PATH"] = saved; }
  });
  it("a binary that vanishes later yields E_MEDIA_UNSUPPORTED_KIND", async () => {
    const { f, ports } = await setup({ mode: "frames" });
    await unlink(f.bin);
    await assert.rejects(collect(ports.frames!.frames({ path: "/x/v.mp4" }, { intervalSec: 1, sceneDetect: false, maxFrames: 2 })), code("E_MEDIA_UNSUPPORTED_KIND"));
    await assert.rejects(collect(ports.audio!.pcm({ path: "/x/a.wav" }, { sampleRate: 16000, mono: true, maxSeconds: 5 })), code("E_MEDIA_UNSUPPORTED_KIND"));
  });
  it("a failing exit code yields E_MEDIA_UNSUPPORTED_KIND", async () => {
    const { ports } = await setup({ mode: "fail" });
    await assert.rejects(collect(ports.frames!.frames({ path: "/x/v.mp4" }, { intervalSec: 1, sceneDetect: false, maxFrames: 2 })), code("E_MEDIA_UNSUPPORTED_KIND"));
  });
});

describe("frames", () => {
  it("passes argv as an array, path verbatim as one argument, no shell", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; shell: unknown }> = [];
    const spy = ((cmd: string, args: readonly string[], opts: { shell?: unknown }) => { calls.push({ cmd, args, shell: opts.shell }); return (spawn as unknown as (...a: unknown[]) => ReturnType<typeof spawn>)(cmd, args, opts); }) as unknown as typeof spawn;
    const { f, ports, tempDir } = await setup({ mode: "frames" }, { spawn: spy });
    const evil = join(root, "my video; rm -rf $(x) `y` & z.mp4");
    const frames = await collect(ports.frames!.frames({ path: evil }, { intervalSec: 2, sceneDetect: false, maxFrames: 5 }));
    assert.equal(frames.length, 2);
    const argv = (await f.argvs())[0]!;
    assert.ok(argv.includes(`file:${resolve(evil)}`), "path arrives verbatim as a single argument");
    assert.equal(argv.filter((a) => a.includes("rm -rf")).length, 1);
    assert.ok(argv.includes("-nostdin"));
    const i = argv.indexOf("-protocol_whitelist"); assert.ok(i >= 0); assert.equal(argv[i + 1], "file,pipe");
    assert.ok(argv.indexOf("-protocol_whitelist") < argv.indexOf("-i"));
    assert.ok(calls.length >= 1 && calls.every((c) => c.shell === false && Array.isArray(c.args)));
    assert.deepEqual(await readdir(tempDir), []);
  });
  it("yields png frames with showinfo timestamps and respects maxFrames in argv", async () => {
    const { f, ports } = await setup({ mode: "frames", frames: 3 });
    const frames = await collect(ports.frames!.frames({ path: "/x/v.mp4" }, { intervalSec: 2, sceneDetect: false, maxFrames: 3 }));
    assert.deepEqual(frames.map((x) => x.tsMs), [0, 2500, 5000]);
    assert.ok(frames.every((x) => x.mime === "image/png" && Buffer.compare(Buffer.from(x.image), PNG) === 0));
    const argv = (await f.argvs())[0]!;
    assert.equal(argv[argv.indexOf("-frames:v") + 1], "3");
  });
  it("never yields more than maxFrames", async () => {
    const { ports } = await setup({ mode: "frames", frames: 6 });
    assert.equal((await collect(ports.frames!.frames({ path: "/x/v.mp4" }, { intervalSec: 1, sceneDetect: false, maxFrames: 4 }))).length, 4);
  });
  it("sceneDetect uses select gt(scene,0.3) and falls back to the interval when nothing is detected", async () => {
    const { f, ports } = await setup({ mode: "frames", sceneEmpty: true });
    const frames = await collect(ports.frames!.frames({ path: "/x/v.mp4" }, { intervalSec: 1, sceneDetect: true, maxFrames: 4 }));
    assert.equal(frames.length, 2);
    const calls = await f.argvs();
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.some((a) => a.includes("gt(scene,0.3)")));
    assert.ok(!calls[1]!.some((a) => a.includes("scene")));
  });
  it("writes bytes sources into tempDir and removes them afterwards", async () => {
    const { f, ports, tempDir } = await setup({ mode: "frames" });
    await collect(ports.frames!.frames({ bytes: new Uint8Array([1, 2, 3]) }, { intervalSec: 1, sceneDetect: false, maxFrames: 2 }));
    const argv = (await f.argvs())[0]!;
    assert.ok(argv.some((a) => a.startsWith(`file:${tempDir}`)));
    assert.deepEqual(await readdir(tempDir), []);
  });
  it("timeout kills a hanging process; tempDir stays empty", async () => {
    const { ports, tempDir } = await setup({ mode: "hang" }, { timeoutMs: 300 });
    const t0 = Date.now();
    await assert.rejects(collect(ports.frames!.frames({ bytes: new Uint8Array([1]) }, { intervalSec: 1, sceneDetect: false, maxFrames: 2 })), code("E_MEDIA_UNSUPPORTED_KIND"));
    assert.ok(Date.now() - t0 < 4000);
    assert.deepEqual(await readdir(tempDir), []);
  });
  it("size limit trips on oversized output", async () => {
    const { ports, tempDir } = await setup({ mode: "big" }, { maxBytes: 200_000, maxFrameBytes: 100_000 });
    await assert.rejects(collect(ports.frames!.frames({ bytes: new Uint8Array([1]) }, { intervalSec: 1, sceneDetect: false, maxFrames: 2 })), code("E_MEDIA_UNSUPPORTED_KIND"));
    assert.deepEqual(await readdir(tempDir), []);
  });
  it("early termination by the consumer cleans up", async () => {
    const { ports, tempDir } = await setup({ mode: "frames", frames: 4 });
    for await (const _ of ports.frames!.frames({ bytes: new Uint8Array([1]) }, { intervalSec: 1, sceneDetect: false, maxFrames: 4 })) break;
    assert.deepEqual(await readdir(tempDir), []);
  });
});

describe("audio", () => {
  it("streams f32le mono PCM in chunks with startMs offsets", async () => {
    const { f, ports, tempDir } = await setup({ mode: "pcm", samples: 25 }, { audioChunkSec: 1 });
    const chunks = await collect(ports.audio!.pcm({ path: "/x/a.wav" }, { sampleRate: 10, mono: true, maxSeconds: 60 }));
    assert.deepEqual(chunks.map((c) => [c.startMs, c.samples.length]), [[0, 10], [1000, 10], [2000, 5]]);
    assert.ok(chunks.every((c) => c.samples instanceof Float32Array));
    assert.ok(Math.abs(chunks[1]!.samples[0]! - 0.1) < 1e-6);
    const argv = (await f.argvs())[0]!;
    const has = (k: string, v: string) => argv[argv.indexOf(k) + 1] === v;
    assert.ok(has("-ar", "10") && has("-ac", "1") && has("-f", "f32le") && has("-t", "60"));
    assert.ok(argv.includes("-nostdin") && has("-protocol_whitelist", "file,pipe"));
    assert.deepEqual(await readdir(tempDir), []);
  });
  it("clamps maxSeconds to probed duration when ffprobe is available", async () => {
    const probe = await fake({ mode: "probe" });
    const { f, ports } = await setup({ mode: "pcm" }, { ffprobePath: probe.bin });
    await collect(ports.audio!.pcm({ path: "/x/a.wav" }, { sampleRate: 100, mono: true, maxSeconds: 3600 }));
    const pa = (await probe.argvs())[0]!; assert.ok(pa.includes("-protocol_whitelist") && pa.includes("file:/x/a.wav"));
    const a = (await f.argvs())[0]!; assert.equal(a[a.indexOf("-t") + 1], "13");
  });
  it("hang and size limits on audio", async () => {
    const h = await setup({ mode: "hang" }, { timeoutMs: 300 });
    await assert.rejects(collect(h.ports.audio!.pcm({ bytes: new Uint8Array([1]) }, { sampleRate: 100, mono: true, maxSeconds: 5 })), code("E_MEDIA_UNSUPPORTED_KIND"));
    assert.deepEqual(await readdir(h.tempDir), []);
    const b = await setup({ mode: "big" }, { maxBytes: 300_000 });
    await assert.rejects(collect(b.ports.audio!.pcm({ bytes: new Uint8Array([1]) }, { sampleRate: 100, mono: true, maxSeconds: 5 })), code("E_MEDIA_UNSUPPORTED_KIND"));
    assert.deepEqual(await readdir(b.tempDir), []);
  });
});
