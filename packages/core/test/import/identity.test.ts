import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { artefactDigest, CATALOG } from "../../src/import/catalog.ts";
import { assembleIdentity, classifyReranker, compareIdentity, compareReranker, targetIdentity } from "../../src/import/identity.ts";
import { tempDir } from "../helpers/temp-dir.ts";

// Test-only import of an engine internal: the drift check needs the profiles the pinned engine actually ships.
const ENGINE_ARTIFACTS: string = "@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js";
const engine = (await import(ENGINE_ARTIFACTS)) as Record<string, unknown>;
const E5 = "intfloat/multilingual-e5-small";
const NANO = "jinaai/jina-embeddings-v5-text-nano-retrieval";

describe("catalog", () => {
  it("matches the pinned engine's model profiles (drift check)", () => {
    const profiles = [engine.E5_EMBEDDING_PROFILE, engine.JINA_EMBEDDING_PROFILE, engine.JINA_V5_NANO_EMBEDDING_PROFILE, engine.JINA_RERANKER_PROFILE, engine.BGE_RERANKER_PROFILE] as any[];
    assert.deepEqual(Object.keys(CATALOG).sort(), profiles.map((p) => p.model).sort());
    for (const p of profiles) {
      const c = CATALOG[p.model]!;
      assert.equal(c.role, p.role, p.model);
      assert.equal(c.revision, p.revision, p.model);
      assert.equal(c.artefactDigest, artefactDigest(p.artifacts), p.model);
      const quantized = p.artifacts.some((a: { path: string }) => a.path.includes("quantized"));
      assert.equal(c.quantization, quantized ? "q8" : "fp32", p.model);
      if (p.dtype) assert.equal(c.quantization, p.dtype, p.model);
      if (p.license) assert.equal(c.licence, p.license, p.model);
      if (p.outputDimensions) assert.equal(c.nativeDimensions, p.outputDimensions, p.model);
      if (p.queryPrefix !== undefined) assert.equal(c.queryPrefix, p.queryPrefix, p.model);
      if (p.commercialUse === false) assert.equal(c.licenceClass, "non-commercial", p.model);
    }
  });
});

describe("targetIdentity", () => {
  it("gives the harness defaults for a home without config.json", () => {
    const t = targetIdentity(tempDir("p1b-imp-"));
    assert.equal(t.configSource, "defaults");
    assert.deepEqual(t.embedding.model, { value: E5, source: "harness-default" });
    assert.equal(t.embedding.dimension.value, 384);
    assert.deepEqual(t.embedding.prefixSchema.value, { query: "query: ", passage: "passage: " });
    assert.equal(t.embedding.prefixSchema.source, "engine-catalog");
    assert.deepEqual(t.embedding.quantization, { value: "fp32", source: "engine-catalog" });
    assert.equal(t.embedding.revision.value, CATALOG[E5]!.revision);
    assert.equal(t.reranker.model, "woxpas-ai/bge-reranker-v2-m3-onnx");
    assert.equal(t.reranker.licenceClass, "permissive");
  });
  it("reads config.json's engine.embedding.local overrides", () => {
    const home = tempDir("p1b-imp-");
    const cfg = defaults() as any;
    cfg.engine = { embedding: { local: { model: NANO, dimensions: 768 } } };
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
    const t = targetIdentity(home);
    assert.equal(t.configSource, "config.json");
    assert.deepEqual(t.embedding.model, { value: NANO, source: "harness-config" });
    assert.deepEqual(t.embedding.prefixSchema.value, { query: "Query: ", passage: "Document: " });
  });
  it("falls back to the defaults with a warning on an invalid config.json", () => {
    const home = tempDir("p1b-imp-");
    writeFileSync(join(home, "config.json"), "{not json");
    const t = targetIdentity(home);
    assert.equal(t.configSource, "invalid-config");
    assert.equal(t.warnings.length, 1);
  });
});

describe("assembleIdentity and compareIdentity", () => {
  const target = () => targetIdentity(tempDir("p1b-imp-")).embedding;
  const e5Evidence = () => ({
    config: { provider: "local-transformers", local: { model: E5, dimensions: 384 } },
    cache: [{ provider: "local-transformers", model: E5, dimensions: 384, entries: 3 }],
    modelCache: { revisions: [CATALOG[E5]!.revision], quantization: "fp32" as const },
    vectorDimension: 384,
    dimensionClaims: [{ source: "config" as const, value: 384 }],
  });

  it("confirms every field of a legacy E5 store from config, model cache and vector schema and matches", () => {
    const { fields, reasons } = assembleIdentity(e5Evidence());
    assert.deepEqual(reasons, []);
    assert.equal(fields.dimension.source, "vector-schema");
    assert.equal(fields.revision.source, "model-cache");
    assert.equal(fields.artefactHash.source, "derived");
    assert.equal(fields.artefactHash.value, CATALOG[E5]!.artefactDigest);
    assert.equal(compareIdentity(fields, target()).verdict, "match");
  });
  it("is undetermined when a field has no confirming source", () => {
    const ev = { ...e5Evidence(), modelCache: undefined };
    const { fields } = assembleIdentity(ev);
    assert.equal(fields.revision.source, "unknown");
    const c = compareIdentity(fields, target());
    assert.equal(c.verdict, "undetermined");
    assert.equal(c.fields.revision, "unknown");
  });
  it("is a mismatch when a confirmed field differs", () => {
    const { fields } = assembleIdentity({ ...e5Evidence(), vectorDimension: 768, dimensionClaims: [] });
    const c = compareIdentity(fields, target());
    assert.equal(c.fields.dimension, "mismatch");
    assert.equal(c.verdict, "mismatch");
  });
  it("flags a dimension conflict between the vector schema and the config", () => {
    const { fields, reasons } = assembleIdentity({ ...e5Evidence(), vectorDimension: 768 });
    assert.deepEqual(reasons, ["dimension-conflict"]);
    assert.match(fields.dimension.note ?? "", /config=384/);
  });
  it("prefers the store's own fingerprint record", () => {
    const fp = { provider: "local-transformers", model: NANO, revision: CATALOG[NANO]!.revision, dimensions: 768, queryPrefix: "Query: ", passagePrefix: "Document: ", pooling: "mean", normalize: true, dtype: "q8", artifacts: [{ path: "a", sha256: "b".repeat(64) }] };
    const { fields } = assembleIdentity({ fingerprint: fp, cache: [], vectorDimension: 768, dimensionClaims: [] });
    for (const k of ["provider", "model", "revision", "quantization", "prefixSchema", "normalization", "artefactHash"] as const) assert.equal(fields[k].source, "store-metadata", k);
    assert.equal(fields.artefactHash.value, artefactDigest(fp.artifacts));
  });
  it("marks local-only fields not-applicable for a remote provider", () => {
    const { fields } = assembleIdentity({ config: { provider: "openai", model: "text-embedding-3-small", apiKey: "x" }, cache: [], vectorDimension: 1536, dimensionClaims: [] });
    assert.equal(fields.revision.source, "not-applicable");
    assert.equal(fields.endpoint.source, "config");
    assert.equal(compareIdentity(fields, target()).verdict, "mismatch");
  });
  it("knows nothing without config, cache or metadata", () => {
    const { fields } = assembleIdentity({ cache: [], vectorDimension: 384, dimensionClaims: [] });
    assert.equal(fields.provider.source, "unknown");
    assert.equal(fields.model.source, "unknown");
    assert.equal(compareIdentity(fields, target()).verdict, "undetermined");
  });
  it("turns multiple identities into a mismatch even when every field matches", () => {
    const { fields } = assembleIdentity(e5Evidence());
    assert.equal(compareIdentity(fields, target(), ["multiple-identities"]).verdict, "mismatch");
  });
});

describe("classifyReranker", () => {
  it("classifies local, remote, non-commercial, disabled and default rerankers", () => {
    assert.equal(classifyReranker({ enabled: true, provider: "local-transformers", local: { model: "jinaai/jina-reranker-v2-base-multilingual" } }).licenceClass, "non-commercial");
    const bge = classifyReranker({ enabled: true, provider: "local-transformers" });
    assert.equal(bge.licenceClass, "permissive");
    assert.equal(bge.modelSource, "engine-default");
    const cohere = classifyReranker({ enabled: true, provider: "cohere", apiKeyEnv: "COHERE_API_KEY" });
    assert.deepEqual([cohere.locality, cohere.licenceClass, cohere.model, cohere.enabled], ["remote", "remote-service-terms", "rerank-v3.5", true]);
    assert.equal(classifyReranker({ enabled: false, provider: "cohere" }).locality, "disabled");
    assert.equal(classifyReranker(undefined).source, "engine-default");
  });
  it("recommends rather than blocks on a mismatch", () => {
    const target = targetIdentity(tempDir("p1b-imp-")).reranker;
    const c = compareReranker(classifyReranker({ provider: "cohere", apiKeyEnv: "K" }), target);
    assert.equal(c.verdict, "mismatch");
    assert.match(c.recommendation, /Not fatal/);
    const nc = compareReranker(classifyReranker({ provider: "local-transformers", local: { model: "jinaai/jina-reranker-v2-base-multilingual" } }), target);
    assert.match(nc.recommendation, /NC confirmation/);
    assert.equal(compareReranker(classifyReranker({ provider: "local-transformers" }), target).verdict, "match");
  });
});
