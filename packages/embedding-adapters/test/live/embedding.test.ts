// Optional live smoke for embedding adapters. Skipped (and reported as skipped) unless PLUR1BUS_LIVE_EMBED=1 and the
// target's key or URL is set. See docs/embedding-adapters.md for the variable names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingAdapter } from "../../src/registry.ts";
import { probe } from "../../src/probe.ts";
import { EMBED_TARGETS, liveGetSecret, skipReason } from "./helpers.ts";

for (const t of EMBED_TARGETS) {
  const skip = skipReason(...t.needs);
  test(`live embed/${t.name}`, { skip, timeout: 60_000 }, async () => {
    const config = t.config();
    const adapter = createEmbeddingAdapter(config, { getSecret: liveGetSecret });
    const out = await adapter.embed(["live smoke document one", "live smoke document two"], { inputType: "document" });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.length, config.dimensions);
    const q = await adapter.embed(["live smoke query"], { inputType: "query" });
    assert.equal(q.length, 1);
    const result = await probe(adapter);
    console.log(`live embed/${t.name}: probe ${result.ok ? "ok" : `FAILED ${result.error}`} (${result.dimensions} dims, ${result.identityId.slice(-12)})`);
    assert.equal(result.ok, true, result.error);
  });
}
