import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { targetFromModel } from "../../src/embedding-migrate/target.ts";

describe("targetFromModel", () => {
  it("builds the engine's own pinned fingerprint for a pinned local model", () => {
    const r = targetFromModel({ model: "intfloat/multilingual-e5-small" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.fingerprint.provider, "local-transformers");
    assert.equal(r.fingerprint.dimensions, 384);
    assert.match(r.fingerprint.revision ?? "", /^[a-f0-9]{40}$/);
    assert.ok((r.fingerprint.artifacts?.length ?? 0) > 0, "artefact hashes are part of the identity");
    assert.match(embeddingFingerprintId(r.fingerprint as never), /^embedding:v1:sha256:[a-f0-9]{64}$/);
  });

  it("changing the prefixes changes the identity", () => {
    const a = targetFromModel({ model: "intfloat/multilingual-e5-small" }); const b = targetFromModel({ model: "intfloat/multilingual-e5-small", queryPrefix: "q: " });
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.notEqual(embeddingFingerprintId(a.fingerprint as never), embeddingFingerprintId(b.fingerprint as never));
  });

  it("an unknown model is refused with a reason, not guessed", () => {
    const r = targetFromModel({ model: "someone/unpinned-model" });
    assert.ok(!r.ok);
    if (!r.ok) { assert.equal(r.probe.verdict, "incompatible"); assert.deepEqual(r.probe.reasons, ["target-model-unpinned"]); assert.match(r.probe.message, /pinned local embedding model/); }
  });

  it("a pinned reranker is not an embedding model", () => {
    const r = targetFromModel({ model: "woxpas-ai/bge-reranker-v2-m3-onnx" });
    assert.ok(!r.ok);
  });
});
