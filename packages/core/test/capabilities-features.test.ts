import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities } from "@plur1bus/rpc-schema";
import { CORE_FEATURES } from "../src/capabilities.ts";

describe("CORE_FEATURES", () => {
  it("is immutable: no module can add a feature the core does not carry", () => {
    assert.equal(Object.isFrozen(CORE_FEATURES), true);
    assert.throws(() => (CORE_FEATURES as string[]).push("x.injected"), TypeError);
    assert.equal(CORE_FEATURES.includes("x.injected"), false);
  });
  it("has no duplicates and no prototype-object names", () => {
    assert.equal(new Set(CORE_FEATURES).size, CORE_FEATURES.length);
    for (const f of CORE_FEATURES) assert.equal(f in Object.prototype, false, f);
  });
  it("is advertised sorted and verbatim in the core's hello", () => {
    const caps = buildCapabilities(CORE_FEATURES, "core");
    assert.deepEqual([...caps.features], [...CORE_FEATURES].sort());
  });
  it("buildCapabilities treats prototype names as ordinary strings, not as methods", () => {
    const caps = buildCapabilities(["__proto__", "constructor", "toString"], "core");
    assert.equal(Object.hasOwn(caps.methods, "constructor"), false);
    assert.equal(Object.hasOwn(caps.methods, "toString"), false);
    assert.equal(Object.getPrototypeOf(caps.methods) === Object.prototype || Object.getPrototypeOf(caps.methods) === null, true);
  });
});
