import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMediaSearch, mediaSearchMethods } from "../../src/composition/media-search.ts";
import { defaults } from "@plur1bus/config-schema";
import { FakePort, silentLogger } from "./fakes.ts";

describe("composeMediaSearch", () => {
  it("store put/delete drive the hook; prompt becomes the caption", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    const ws = join(home, "ws"); mkdirSync(ws);
    mkdirSync(join(home, "media", "owners"), { recursive: true });
    writeFileSync(join(home, "media", "owners", "out1.json"), JSON.stringify({ agentId: "bernd", userId: "u", connectionId: "" }));
    let listener: any;
    const store = { root: join(home, "media", "outputs"), addListener: (l: unknown) => { listener = l; return () => { listener = undefined; }; } };
    const port = new FakePort();
    const cfg = defaults();
    const c = await composeMediaSearch({ home, config: () => cfg, engine: {}, agents: { workspaceOf: () => ws }, logger: { ...silentLogger, debug() {} } as any, store: store as any, budget: null, testPort: port });
    assert.equal(c.kind, "memory");
    listener.onPut({ id: "out1", prompt: "a red kite", files: [{ path: "0.png", format: "png" }] });
    listener.onDelete("out1");
    await c.hook.idle();
    assert.equal(port.indexed[0]!.captionSource, "prompt");
    assert.equal(port.indexed[0]!.caption, "a red kite");
    assert.equal(port.indexed[0]!.scope.agentId, "bernd");
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
