import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeCompatibility, type EmbeddingFingerprint } from "../../src/embedding-migrate/probe.ts";

const local = (over: Partial<EmbeddingFingerprint> = {}): EmbeddingFingerprint => ({
  provider: "local-transformers", model: "bge-small-en", revision: "a".repeat(40), dimensions: 384, normalize: true, pooling: "mean", ...over,
});

describe("probeCompatibility", () => {
  it("identical identity is compatible", () => {
    const r = probeCompatibility({ stored: local(), target: local() });
    assert.equal(r.verdict, "compatible");
    assert.deepEqual(r.reasons, []);
    assert.equal(r.storedId, r.targetId);
  });

  it("credential metadata does not make a different identity", () => {
    const r = probeCompatibility({ stored: local({ apiKeyEnv: "A" } as never), target: local({ apiKeyEnv: "B" } as never) });
    assert.equal(r.verdict, "compatible");
  });

  it("a different model needs migration and names the changed field", () => {
    const r = probeCompatibility({ stored: local(), target: local({ model: "bge-base-en", dimensions: 768 }) });
    assert.equal(r.verdict, "migration-needed");
    assert.deepEqual(r.changed, ["model", "dimensions"]);
    assert.deepEqual(r.reasons, ["model-changed", "dimension-changed"]);
    assert.match(r.message, /re-embed/i);
  });

  it("normalisation, prefix, pooling and endpoint changes each need migration", () => {
    for (const [field, over] of [
      ["normalize", { normalize: false }], ["queryPrefix", { queryPrefix: "query: " }], ["passagePrefix", { passagePrefix: "passage: " }],
      ["pooling", { pooling: "cls" }], ["endpoint", { endpoint: "http://127.0.0.1:9/v1" }], ["provider", { provider: "openai", revision: undefined }],
    ] as const) {
      const r = probeCompatibility({ stored: local(), target: local(over as Partial<EmbeddingFingerprint>) });
      assert.equal(r.verdict, "migration-needed", field);
      assert.ok(r.changed.includes(field), `${field} in ${r.changed.join(",")}`);
    }
  });

  it("is incompatible, never compatible, when the stored identity is missing", () => {
    const r = probeCompatibility({ stored: null, target: local() });
    assert.equal(r.verdict, "incompatible");
    assert.deepEqual(r.reasons, ["stored-identity-missing"]);
  });

  it("is incompatible when the stored identity cannot be normalised (unknown dimensions)", () => {
    const r = probeCompatibility({ stored: local({ dimensions: 0 }), target: local() });
    assert.equal(r.verdict, "incompatible");
    assert.deepEqual(r.reasons, ["stored-identity-invalid"]);
  });

  it("refuses a target with a moving revision and says why", () => {
    const r = probeCompatibility({ stored: local(), target: local({ revision: "main" }) });
    assert.equal(r.verdict, "incompatible");
    assert.deepEqual(r.reasons, ["target-revision-unpinned"]);
    assert.match(r.message, /revision/);
  });

  it("refuses a target without usable dimensions", () => {
    const r = probeCompatibility({ stored: local(), target: local({ dimensions: undefined as never }) });
    assert.equal(r.verdict, "incompatible");
    assert.deepEqual(r.reasons, ["target-identity-invalid"]);
  });

  it("refuses when the target provider's own probe failed, even for a different identity", () => {
    const r = probeCompatibility({ stored: local(), target: local({ model: "other" }), targetProbe: { ok: false, error: "provider-failed" } });
    assert.equal(r.verdict, "incompatible");
    assert.deepEqual(r.reasons, ["target-provider-unusable"]);
    assert.match(r.message, /provider-failed/);
  });

  it("a failed provider probe is incompatible even when the identity is identical (the store could not be served)", () => {
    const r = probeCompatibility({ stored: local(), target: local(), targetProbe: { ok: false, error: "provider-failed" } });
    assert.equal(r.verdict, "incompatible");
  });
});
