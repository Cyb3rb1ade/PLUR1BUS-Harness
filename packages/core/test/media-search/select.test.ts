import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectMediaIndex } from "../../src/media-search/select.ts";
import { InMemoryMediaIndex } from "../../src/media-search/in-memory.ts";
import { EngineMediaIndex } from "../../src/media-search/engine-adapter.ts";
import { DisabledMediaIndex } from "../../src/media-search/disabled.ts";

const fn = async () => undefined;
const media = (extra: Record<string, unknown> = {}) => ({ index: fn, search: fn, remove: fn, setCaption: fn, status: fn, backfill: { start: fn, pause: fn, resume: fn, cancel: fn }, ...extra });
const ports = { frames: null, audio: null };

describe("selectMediaIndex", () => {
  it("engine without media -> disabled", () => {
    const r = selectMediaIndex({ engine: {}, config: { enabled: true }, ports });
    assert.equal(r.kind, "disabled");
    assert.ok(r.port instanceof DisabledMediaIndex);
  });
  it("engine with media -> engine adapter, host ports attached once", () => {
    const attached: unknown[] = [];
    const budget = { canContinue: async () => true };
    const r = selectMediaIndex({ engine: { media: media({ attachHost: (h: unknown) => { attached.push(h); } }) }, config: {}, ports: { ...ports, budget } });
    assert.equal(r.kind, "engine");
    assert.ok(r.port instanceof EngineMediaIndex);
    assert.deepEqual(attached, [{ frames: null, audio: null, budget }]);
  });
  it("engine media without attachHost is fine", () => {
    assert.equal(selectMediaIndex({ engine: { media: media() }, config: { enabled: true }, ports }).kind, "engine");
  });
  it("config disabled or provider off -> disabled even with engine support", () => {
    assert.equal(selectMediaIndex({ engine: { media: media() }, config: { enabled: false }, ports }).kind, "disabled");
    assert.equal(selectMediaIndex({ engine: { media: media() }, config: { provider: "off" }, ports }).kind, "disabled");
  });
  it("test-injected index wins; in-memory is never auto-selected", () => {
    const mem = new InMemoryMediaIndex({ provider: "p", model: "m", dim: 2, fingerprint: "f", embedText: async () => [1, 0], embedMedia: async () => ({ vectors: [[1, 0]], segments: [{ idx: 0, startMs: 0, endMs: 0 }] }) });
    assert.equal(selectMediaIndex({ engine: {}, config: {}, ports, test: mem }).port, mem);
    assert.equal(selectMediaIndex({ engine: {}, config: {}, ports, test: mem }).kind, "memory");
    assert.notEqual(selectMediaIndex({ engine: {}, config: {}, ports }).kind, "memory");
  });
});
