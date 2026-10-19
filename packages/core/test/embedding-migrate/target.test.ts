import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { targetFromModel, targetFromSpec } from "../../src/embedding-migrate/target.ts";

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

describe("targetFromSpec: every direction, refused only by the provider rules (owner decision 2026-10-18)", () => {
  const ack = { provider: "openrouter", acknowledgedAt: "2026-10-18T10:00:00.000Z", by: "person-owner", endpoint: "https://openrouter.ai/api/v1" };
  const cloud = { provider: "openrouter", model: "qwen/qwen3-embedding-8b", dimensions: 4096, baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" };
  it("a cloud target gets the engine's fingerprint (endpoint, no credential) and an env SecretRef, never the key", () => {
    const r = targetFromSpec(cloud, { privacyAck: ack });
    assert.ok(r.ok && !r.local);
    if (!r.ok || r.local) return;
    assert.deepEqual([r.fingerprint.provider, r.fingerprint.model, r.fingerprint.dimensions, r.fingerprint.endpoint], ["openrouter", "qwen/qwen3-embedding-8b", 4096, "https://openrouter.ai/api/v1"]);
    assert.deepEqual(r.secretRef, { source: "env", provider: "default", id: "OPENROUTER_API_KEY" });
    assert.ok(!JSON.stringify(r.fingerprint).includes("OPENROUTER_API_KEY"));
  });
  it("without provider or with local-transformers the target is a pinned local model, as before", () => {
    const a = targetFromSpec({ model: "intfloat/multilingual-e5-small" }), b = targetFromSpec({ provider: "local-transformers", model: "jinaai/jina-embeddings-v5-text-nano-retrieval" });
    assert.ok(a.ok && a.local && b.ok && b.local);
    const bad = targetFromSpec({ provider: "local-transformers", model: "intfloat/multilingual-e5-small", baseUrl: "http://127.0.0.1:1/v1" });
    assert.ok(!bad.ok && bad.probe.reasons[0] === "target-identity-invalid");
  });
  it("a missing privacy acknowledgment refuses a cloud target with E_DENIED; loopback needs none", () => {
    assert.throws(() => targetFromSpec(cloud), (e: any) => e.error === "E_DENIED" && e.reason === "privacy-acknowledgment-required");
    const r = targetFromSpec({ provider: "ollama", model: "nomic-embed-text", dimensions: 768, baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "OLLAMA_KEY" });
    assert.ok(r.ok && !r.local);
  });
  it("privacy.localOnly refuses a cloud target with E_DENIED reason local-only, even acknowledged; loopback and local stay possible", () => {
    assert.throws(() => targetFromSpec(cloud, { privacyAck: ack, localOnly: true }), (e: any) => e.error === "E_DENIED" && e.reason === "local-only");
    assert.ok(targetFromSpec({ model: "intfloat/multilingual-e5-small" }, { localOnly: true }).ok);
    assert.ok(targetFromSpec({ provider: "ollama", model: "m", dimensions: 8, baseUrl: "http://localhost:11434/v1", apiKeyEnv: "K" }, { localOnly: true }).ok);
  });
  it("missing details are the provider rule's E_INVALID_PARAMS, a plaintext key is never accepted", () => {
    assert.throws(() => targetFromSpec({ ...cloud, apiKeyEnv: undefined } as never, { privacyAck: ack }), (e: any) => e.error === "E_INVALID_PARAMS");
    assert.throws(() => targetFromSpec({ provider: "openrouter", model: "m", apiKeyEnv: "K", baseUrl: "https://openrouter.ai/api/v1" }, { privacyAck: ack }), (e: any) => e.error === "E_INVALID_PARAMS");
  });
});
