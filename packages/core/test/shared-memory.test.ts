import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sharedMemoryStatus } from "../src/shared-memory.ts";

describe("sharedMemoryStatus", () => {
  it("projects supported, mode and reason", () => {
    const es = { sharedMemory: { supported: true, mode: "fd-capability" } };
    assert.deepEqual(sharedMemoryStatus(es), { supported: true, mode: "fd-capability" });
    const withReason = { sharedMemory: { supported: false, mode: "unavailable", reason: "platform" } };
    assert.deepEqual(sharedMemoryStatus(withReason), { supported: false, mode: "unavailable", reason: "platform" });
  });

  it("drops unknown fields", () => {
    const es = { sharedMemory: { supported: true, mode: "fd-capability", reason: "platform", extra: 1, internalPath: "/x" } };
    const r = sharedMemoryStatus(es);
    assert.deepEqual(r, { supported: true, mode: "fd-capability", reason: "platform" });
    assert.equal("extra" in (r as object), false);
    assert.equal("internalPath" in (r as object), false);
  });

  it("null when absent, malformed, or the engine status itself is missing", () => {
    assert.equal(sharedMemoryStatus({}), null);
    assert.equal(sharedMemoryStatus(null), null);
    assert.equal(sharedMemoryStatus(undefined), null);
    assert.equal(sharedMemoryStatus("nope"), null);
    assert.equal(sharedMemoryStatus({ sharedMemory: null }), null);
    assert.equal(sharedMemoryStatus({ sharedMemory: { mode: "fd-capability" } }), null); // missing supported
    assert.equal(sharedMemoryStatus({ sharedMemory: { supported: true, mode: "bogus" } }), null); // unknown mode
  });

  it("drops a non-string reason rather than passing it through", () => {
    const r = sharedMemoryStatus({ sharedMemory: { supported: true, mode: "fd-capability", reason: 1 } });
    assert.deepEqual(r, { supported: true, mode: "fd-capability" });
  });
});
