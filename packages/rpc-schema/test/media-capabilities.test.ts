/** MM-3a status additions remain compatible with producers predating RPC 1.20.0. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { loadFixtures, validateResult } from "../src/index.ts";

it("accepts media capabilities and encoder metadata without requiring them from older status producers", () => {
  const fixtures = loadFixtures();
  for (const name of ["model.memory.status", "media.index.status"]) {
    const old = structuredClone(fixtures.methods[name]!.result) as Record<string, unknown>;
    delete old.capabilities;
    delete old.encoders;
    assert.equal(validateResult(name, old).ok, true, `${name}: old response`);
    const enriched = {
      ...old,
      capabilities: { text: true, image: true, audio: true, video: true },
      encoders: [{ role: "vision", dtype: "q8", state: "not-installed", downloadBytes: 123, revision: "a".repeat(40) }],
    };
    assert.equal(validateResult(name, enriched).ok, true, `${name}: enriched response`);
    assert.equal(validateResult(name, { ...enriched, capabilities: { text: true } }).ok, false);
    assert.equal(validateResult(name, { ...enriched, encoders: [{ role: "audio", dtype: "q4", state: "ready" }] }).ok, false);
    assert.equal(validateResult(name, { ...enriched, encoders: [{ role: "audio", dtype: "q8", state: "ready", path: "/private/models" }] }).ok, false);
  }
});
