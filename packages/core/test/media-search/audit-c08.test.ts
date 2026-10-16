import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMediaIndex, type InMemoryMediaIndexOptions } from "../../src/media-search/in-memory.ts";
import { createMediaIndexHook, type MediaRecord } from "../../src/media-search/hook.ts";
import { createCaptionService } from "../../src/media-search/caption/service.ts";
import { readSource } from "../../src/media-search/caption/keyframes.ts";
import { createFfmpegPorts } from "../../src/media-search/ffmpeg.ts";
import type { MediaIndexRequest, Scope } from "../../src/media-search/types.ts";
import { FakeCaptionProvider, FakePort, recorder, scope as fakeScope, silentLogger } from "./fakes.ts";

const sc = (agentId: string, workspace: string, user?: string): Scope => ({ agentId, workspace, ...(user ? { user } : {}) }) as unknown as Scope;
const code = (c: string) => (e: unknown) => (e as { error?: string }).error === c;
const req = (mediaId: string, s: Scope): MediaIndexRequest => ({ mediaId, kind: "image", mime: "image/png", source: { bytes: new Uint8Array([1]) }, scope: s });
function make(over: Partial<InMemoryMediaIndexOptions> = {}) {
  return new InMemoryMediaIndex({
    provider: "test", model: "tiny", dim: 2, fingerprint: "fp", embedText: async () => [1, 0],
    embedMedia: async () => ({ vectors: [[1, 0]], segments: [{ idx: 0, startMs: 0, endMs: 1 }] }), ...over,
  });
}

describe("c08: isolation between workspaces/projects", () => {
  it("same agent id in another workspace is not visible (search and likeMediaId)", async () => {
    const m = make();
    await m.index(req("theirs", sc("a1", "ws-other")));
    await m.index(req("mine", sc("a1", "ws")));
    assert.deepEqual((await m.search({ text: "x", limit: 10, scope: sc("a1", "ws") })).map((h) => h.mediaId), ["mine"]);
    await assert.rejects(m.search({ likeMediaId: "theirs", limit: 5, scope: sc("a1", "ws") }), code("E_NOT_FOUND"));
  });
  it("same user in another workspace is not visible either; empty user id never matches", async () => {
    const m = make();
    await m.index(req("u-other-ws", sc("a2", "ws-other", "user:1")));
    await m.index(req("blank", sc("a3", "ws", "")));
    assert.deepEqual(await m.search({ text: "x", limit: 10, scope: sc("a9", "ws", "user:1") }), []);
    assert.deepEqual(await m.search({ text: "x", limit: 10, scope: sc("a8", "ws", "") }), []);
  });
});

describe("c08: search bounds", () => {
  it("rejects limits that are not positive integers within the cap", async () => {
    const m = make();
    await m.index(req("a", sc("a1", "ws")));
    await m.index(req("b", sc("a1", "ws")));
    for (const limit of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      await assert.rejects(m.search({ text: "x", limit, scope: sc("a1", "ws") }), code("E_INVALID_PARAMS"), `limit ${limit}`);
    }
  });
  it("rejects empty, blank and oversized text; unknown kinds", async () => {
    const m = make();
    for (const text of ["", "   ", "x".repeat(4097)]) await assert.rejects(m.search({ text, limit: 5, scope: sc("a1", "ws") }), code("E_INVALID_PARAMS"));
    await assert.rejects(m.search({ text: "x", kinds: ["doc" as never], limit: 5, scope: sc("a1", "ws") }), code("E_INVALID_PARAMS"));
  });
  it("caption fusion never asks the caption index for more than a bounded number of hits", async () => {
    let asked = 0;
    const m = make({ captions: { search: async (_t, n) => { asked = n; return []; } } });
    await m.index(req("a", sc("a1", "ws")));
    await m.search({ text: "x", limit: 200, fuseCaptions: true, scope: sc("a1", "ws") });
    assert.ok(asked <= 200, `asked ${asked}`);
  });
});

describe("c08: delete consistency", () => {
  it("in-memory: remove during an in-flight index does not resurrect the medium or its caption", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const setCalls: string[] = []; const removed: string[] = [];
    const m = make({ embedMedia: async () => { await gate; return { vectors: [[1, 0]], segments: [{ idx: 0, startMs: 0, endMs: 1 }] }; }, captions: { search: async () => [], set: (id) => { setCalls.push(id); }, remove: (id) => { removed.push(id); } } });
    const p = m.index({ ...req("gone", sc("a1", "ws")), caption: "c" });
    await m.remove("gone");
    release(); await p;
    assert.deepEqual(await m.search({ text: "x", limit: 5, scope: sc("a1", "ws") }), []);
    assert.equal((await m.status()).counts.indexed, 0);
    assert.deepEqual(setCalls, []);
  });
  it("hook: a delete that overtakes a running index job removes the medium afterwards", async () => {
    const live = new Set<string>();
    const port = new FakePort();
    port.indexImpl = async (r) => { await new Promise((res) => setTimeout(res, 30)); live.add(r.mediaId); return { segments: 1, state: "indexed" }; };
    port.remove = async (id: string) => { live.delete(id); port.removed.push(id); };
    const hook = createMediaIndexHook({ port: () => port, captions: createCaptionService({ config: () => ({ source: "off", maxChars: 10 }), provider: () => undefined }), config: () => ({ enabled: true, provider: "local" }), scopeOf: () => fakeScope, events: recorder(), counters: { indexFailed() {} }, logger: silentLogger, timeoutMs: 0, concurrency: 2 });
    const r: MediaRecord = { mediaId: "m1", kind: "image", mime: "image/png", source: { bytes: new Uint8Array([1]) } };
    hook.onStored(r); await new Promise((res) => setTimeout(res, 5));
    hook.onDeleted("m1");
    await hook.idle();
    assert.deepEqual([...live], []);
  });
});

describe("c08: paths outside allowed roots", () => {
  it("readSource: path outside the roots, via .. or symlink, is refused; inside is read", async () => {
    const base = await mkdtemp(join(tmpdir(), "c08-"));
    try {
      const root = join(base, "root"); const out = join(base, "outside");
      await mkdir(root); await mkdir(out);
      await writeFile(join(root, "ok.bin"), "ok"); await writeFile(join(out, "secret.bin"), "s");
      await symlink(join(out, "secret.bin"), join(root, "link.bin"));
      assert.equal((await readSource({ path: join(root, "ok.bin") }, [root])).byteLength, 2);
      await assert.rejects(readSource({ path: join(out, "secret.bin") }, [root]), code("E_MEDIA_UNSUPPORTED_KIND"));
      await assert.rejects(readSource({ path: join(root, "..", "outside", "secret.bin") }, [root]), code("E_MEDIA_UNSUPPORTED_KIND"));
      await assert.rejects(readSource({ path: join(root, "link.bin") }, [root]), code("E_MEDIA_UNSUPPORTED_KIND"));
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("readSource: size limit applies to bytes sources and is checked before a file is read", async () => {
    await assert.rejects(readSource({ bytes: new Uint8Array(65 * 1024 * 1024) }), code("E_MEDIA_UNSUPPORTED_KIND"));
    const base = await mkdtemp(join(tmpdir(), "c08-"));
    try {
      const f = join(base, "big.bin"); await writeFile(f, ""); await truncate(f, 65 * 1024 * 1024);
      await assert.rejects(readSource({ path: f }), code("E_MEDIA_UNSUPPORTED_KIND"));
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("ffmpeg ports: a path outside allowedRoots is refused before any process starts", async () => {
    const base = await mkdtemp(join(tmpdir(), "c08-"));
    try {
      const root = join(base, "root"); await mkdir(root);
      const f = join(base, "x.mp4"); await writeFile(f, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42")]));
      const fake = join(base, "ffmpeg"); await writeFile(fake, "#!/bin/sh\n", { mode: 0o755 });
      let spawned = 0;
      const ports = createFfmpegPorts({ ffmpegPath: fake, tempDir: join(base, "t"), allowedRoots: [root], spawn: (() => { spawned++; throw new Error("no spawn"); }) as never });
      await assert.rejects(async () => { for await (const _ of ports.frames!.frames({ path: f }, { intervalSec: 1, sceneDetect: false, maxFrames: 1 })) void _; }, code("E_MEDIA_UNSUPPORTED_KIND"));
      assert.equal(spawned, 0);
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

describe("c08: privacy pin at call time", () => {
  it("a cloud provider is refused by the caption service once the pin is set, before it is called", async () => {
    let pinned = false;
    const cloud = new FakeCaptionProvider("openai", false);
    const svc = createCaptionService({ config: () => ({ source: "prompt-then-user-then-auto", maxChars: 100 }), provider: () => cloud, pinned: () => pinned } as never);
    const input = { kind: "image" as const, mime: "image/png", source: { bytes: new Uint8Array([1]) } };
    assert.ok(await svc.resolve(input));
    cloud.calls.length = 0; pinned = true;
    await assert.rejects(svc.resolve(input), code("E_MEDIA_PRIVACY"));
    assert.equal(cloud.calls.length, 0);
    const local = new FakeCaptionProvider("local", true);
    const svc2 = createCaptionService({ config: () => ({ source: "prompt-then-user-then-auto", maxChars: 100 }), provider: () => local, pinned: () => true } as never);
    assert.ok(await svc2.resolve(input));
  });
});

describe("c08: open items", () => {
  const composeWith = async (over: Record<string, unknown>, caption: Record<string, unknown> = {}) => {
    const { composeMediaSearch } = await import("../../src/composition/media-search.ts");
    const { defaults } = await import("@plur1bus/config-schema");
    const home = await mkdtemp(join(tmpdir(), "c08-comp-"));
    const cfg = defaults(); cfg.memory.mediaEmbedding = { ...cfg.memory.mediaEmbedding, enabled: true, caption: { ...cfg.memory.mediaEmbedding.caption, source: "prompt-then-user-then-auto", ...caption } } as typeof cfg.memory.mediaEmbedding;
    let attached: { frames: any; audio: any } | undefined;
    const noop = async () => { throw new Error("unused"); };
    const engine = { media: { index: noop, search: noop, remove: noop, setCaption: noop, status: noop, backfill: { start: noop, pause: noop, resume: noop, cancel: noop }, attachHost: (h: any) => { attached = h; } } };
    const c = await composeMediaSearch({ home, config: () => cfg, engine, agents: { workspaceOf: () => home }, logger: { ...silentLogger, debug() {} } as any, store: null, budget: null, ...over } as never);
    return { home, c, ports: () => attached! };
  };
  it("composition passes allowedRoots (media directories) to the ffmpeg ports and caption providers", async () => {
    let spawned = 0;
    const { home, c, ports } = await composeWith({ ffmpeg: { spawn: (() => { spawned++; throw new Error("no spawn"); }) as never } }, { provider: "local" });
    try {
      assert.equal(c.kind, "engine");
      const outside = join(home, "elsewhere.mp4"); await writeFile(outside, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42")]));
      await assert.rejects(async () => { for await (const _ of ports().frames.frames({ path: outside }, { intervalSec: 1, sceneDetect: false, maxFrames: 1 })) void _; }, code("E_MEDIA_UNSUPPORTED_KIND"));
      assert.equal(spawned, 0);
      // the local caption provider refuses the same path before it loads any model
      await assert.rejects(c.captions.resolve({ kind: "image", mime: "image/png", source: { path: outside } }), code("E_MEDIA_UNSUPPORTED_KIND"));
    } finally { await c.close(); await rm(home, { recursive: true, force: true }); }
  });
  it("composition passes the privacy pin callback to createCaptionService as well as to resolveCaptionProvider", async () => {
    // The first read happens while the provider is chosen (not pinned), every later read is the service's own call-time check.
    let reads = 0; const cloud = new FakeCaptionProvider("openai", false);
    const { home, c } = await composeWith({ privacyPinned: () => ++reads > 1, cloudCaption: () => cloud }, { provider: "openai", privacyAck: { provider: "openai", acknowledgedAt: "2026-10-14T10:00:00Z", by: "u" } });
    try {
      await assert.rejects(c.captions.resolve({ kind: "image", mime: "image/png", source: { bytes: new Uint8Array([1]) } }), code("E_MEDIA_PRIVACY"));
      assert.equal(cloud.calls.length, 0);
    } finally { await c.close(); await rm(home, { recursive: true, force: true }); }
  });
  it("KNOWN GAP: MediaIndexPort.remove and setCaption carry no scope, so the port cannot refuse a caller that does not own the medium", { todo: true }, () => {});
  it("hook: an index job that hit the timeout does not land after a later delete (the port has no cancel, so the late result is removed again)", async () => {
    const live = new Set<string>();
    const port = new FakePort();
    port.indexImpl = async (r) => { await new Promise((res) => setTimeout(res, 80)); live.add(r.mediaId); return { segments: 1, state: "indexed" }; };
    port.remove = async (id: string) => { live.delete(id); port.removed.push(id); };
    const hook = createMediaIndexHook({ port: () => port, captions: createCaptionService({ config: () => ({ source: "off", maxChars: 10 }), provider: () => undefined }), config: () => ({ enabled: true, provider: "local" }), scopeOf: () => fakeScope, events: recorder(), counters: { indexFailed() {} }, logger: silentLogger, timeoutMs: 10, concurrency: 2 });
    const r: MediaRecord = { mediaId: "m1", kind: "image", mime: "image/png", source: { bytes: new Uint8Array([1]) } };
    hook.onStored(r);
    await new Promise((res) => setTimeout(res, 40)); // the job gave up waiting; the engine call is still running
    hook.onDeleted("m1");
    await hook.idle();
    await new Promise((res) => setTimeout(res, 150)); // the late index lands
    assert.deepEqual([...live], []);
  });
  it("hook: a late index result without a delete stays, and nothing is tracked once it settled", async () => {
    const live = new Set<string>(); const port = new FakePort();
    port.indexImpl = async (r) => { await new Promise((res) => setTimeout(res, 60)); live.add(r.mediaId); return { segments: 1, state: "indexed" }; };
    const hook = createMediaIndexHook({ port: () => port, captions: createCaptionService({ config: () => ({ source: "off", maxChars: 10 }), provider: () => undefined }), config: () => ({ enabled: true, provider: "local" }), scopeOf: () => fakeScope, events: recorder(), counters: { indexFailed() {} }, logger: silentLogger, timeoutMs: 10, concurrency: 2 });
    hook.onStored({ mediaId: "m2", kind: "image", mime: "image/png", source: { bytes: new Uint8Array([1]) } });
    await hook.idle(); await new Promise((res) => setTimeout(res, 120));
    assert.deepEqual([...live], ["m2"]); assert.deepEqual(port.removed, []);
  });
});
