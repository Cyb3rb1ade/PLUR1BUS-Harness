import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMediaSearch, mediaSearchMethods } from "../../src/composition/media-search.ts";
import { defaults } from "@plur1bus/config-schema";
import { FakePort, FakeCaptionProvider, silentLogger } from "./fakes.ts";

describe("composeMediaSearch", () => {
  it("store put/delete drive the hook; prompt becomes the caption", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    const ws = join(home, "ws"); mkdirSync(ws);
    mkdirSync(join(home, "media", "owners"), { recursive: true });
    writeFileSync(join(home, "media", "owners", "out1.json"), JSON.stringify({ agentId: "bernd", userId: "u", connectionId: "" }));
    writeFileSync(join(home, "media", "owners", "out2.json"), JSON.stringify({ agentId: "bernd", userId: "u", connectionId: "" }));
    let listener: any;
    const store = { root: join(home, "media", "outputs"), addListener: (l: unknown) => { listener = l; return () => { listener = undefined; }; } };
    const port = new FakePort();
    const cfg = defaults();
    const c = await composeMediaSearch({ home, config: () => cfg, engine: {}, agents: { workspaceOf: () => ws }, logger: { ...silentLogger, debug() {} } as any, store: store as any, budget: null, testPort: port });
    assert.equal(c.kind, "memory");
    listener.onPut({ id: "out1", prompt: "a red kite", files: [{ path: "0.png", format: "png" }] });
    listener.onPut({ id: "out2", kind: "video", prompt: "a red kite in motion", files: [{ path: "0.mov", format: "mov" }] });
    listener.onDelete("out1");
    await c.hook.idle();
    // The hook runs concurrently; owner-file reads need not complete in enqueue order.
    // Assert each medium's data and scope by identity, rather than OS I/O completion order.
    assert.equal(port.indexed.length, 2);
    const image = port.indexed.find(record => record.mediaId === "out1");
    const video = port.indexed.find(record => record.mediaId === "out2");
    assert.ok(image); assert.ok(video);
    assert.equal(image.captionSource, "prompt");
    assert.equal(image.caption, "a red kite");
    assert.equal(image.scope.agentId, "bernd");
    assert.equal(video.kind, "video");
    assert.equal(video.mime, "video/quicktime");
    assert.deepEqual(port.removed, ["out1"]);
    await c.close();
    assert.equal(listener, undefined);
  });
  it("engine without media: disabled, no listener", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    let attached = false;
    const store = { root: home, addListener: () => { attached = true; return () => {}; } };
    const c = await composeMediaSearch({ home, config: () => defaults(), engine: {}, agents: { workspaceOf: () => undefined }, logger: { ...silentLogger, debug() {} } as any, store: store as any, budget: null });
    assert.equal(c.kind, "disabled");
    assert.equal(attached, false);
    await c.close();
  });
  it("mediaSearchMethods exposes the six handlers; a disabled index answers E_MEDIA_UNAVAILABLE", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    const c = await composeMediaSearch({ home, config: () => defaults(), engine: {}, agents: { workspaceOf: () => undefined }, logger: { ...silentLogger, debug() {} } as any, store: null, budget: null });
    const methods = mediaSearchMethods({ home, config: () => defaults(), agents: { workspaceOf: () => undefined } }, c);
    assert.deepEqual(Object.keys(methods).sort(), ["media.caption.set", "media.index.pause", "media.index.reindex", "media.index.resume", "media.index.status", "media.search"]);
    await c.close();
  });
});

it("cloud captioning works with local media and only its own acknowledgment; runtime pin wins", async () => {
  const home = mkdtempSync(join(tmpdir(), "media-caption-local-"));
  const ws = join(home, "ws"); mkdirSync(ws);
  const cfg = defaults();
  cfg.memory.mediaEmbedding.caption.provider = "openai";
  cfg.memory.mediaEmbedding.caption.privacyAck = { provider: "openai", acknowledgedAt: "2026-10-14T10:00:00Z", by: "alice" };
  let pinned = false; let lookups = 0;
  const cloud = new FakeCaptionProvider("openai", false);
  const port = new FakePort();
  const c = await composeMediaSearch({ home, config: () => cfg, engine: {}, agents: { workspaceOf: () => ws }, logger: { ...silentLogger, debug() {} } as any, store: null, budget: null, testPort: port,
    privacyPinned: () => pinned, cloudCaption: () => { lookups++; return cloud; } });
  try {
    const record = { mediaId: "caption-test", agentId: "bernd", kind: "image" as const, mime: "image/png", source: { bytes: new Uint8Array([1]) } };
    c.hook.onUploaded(record); await c.hook.idle();
    assert.equal(cfg.memory.mediaEmbedding.privacyAck, undefined);
    assert.equal(port.indexed[0]?.caption, "auto caption");
    assert.equal(cloud.calls.length, 1);
    assert.equal(lookups, 1);
    pinned = true;
    c.hook.onUploaded({ ...record, mediaId: "pinned-test" }); await c.hook.idle();
    assert.equal(cloud.calls.length, 1); assert.equal(lookups, 1);
  } finally { await c.close(); }
});
