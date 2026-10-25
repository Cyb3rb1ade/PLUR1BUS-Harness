// When an embedding selection can be written without a re-embedding migration: only while the engine store holds no table
// yet. An existing table (even an empty one) carries the old vector space, and the engine refuses it under another model.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { assertEmbeddingChangeAllowed, memoryModelStatus, storeHoldsTables } from "../../src/embedding-migrate/selection.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "p1b-selection-"));
const l = layout("/h/.plur1bus");

describe("storeHoldsTables", () => {
  it("a store directory that does not exist yet holds no table", () => {
    const dir = scratch();
    try { assert.equal(storeHoldsTables(join(dir, "lancedb")), false); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the engine's start-up files alone are no table", () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, "_schema.json"), "{}"); mkdirSync(join(dir, "_neo", "default"), { recursive: true });
      writeFileSync(join(dir, "_neo", "default", "turn-journal.jsonl"), "");
      assert.equal(storeHoldsTables(dir), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("an agent table counts, empty or not", () => {
    const dir = scratch();
    try { mkdirSync(join(dir, "main", "memories.lance"), { recursive: true }); assert.equal(storeHoldsTables(dir), true); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a table of a re-embedded generation counts", () => {
    const dir = scratch();
    try { mkdirSync(join(dir, "generations", "g1", "main", "memories.lance"), { recursive: true }); assert.equal(storeHoldsTables(dir), true); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a symbolic link is not followed and counts as data (fail closed)", () => {
    const dir = scratch(), other = scratch();
    try { symlinkSync(other, join(dir, "main"), "dir"); assert.equal(storeHoldsTables(dir), true); } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
  });
});

describe("memoryModelStatus", () => {
  it("reports the harness defaults on a fresh store as switchable and not chosen", () => {
    const cfg = defaults();
    assert.deepEqual(memoryModelStatus(buildEngineConfig(cfg, l), cfg, false), {
      embedding: { provider: "local-transformers", model: "intfloat/multilingual-e5-small", dimensions: 384, configured: false },
      reranker: { provider: "local-transformers", model: "woxpas-ai/bge-reranker-v2-m3-onnx" },
      embeddingSwitch: "allowed",
    });
  });
  it("a store with a table needs a migration for another embedding", () => {
    const cfg = defaults();
    assert.equal(memoryModelStatus(buildEngineConfig(cfg, l), cfg, true).embeddingSwitch, "migration-required");
  });
  it("reports a configured cloud embedding with its model and dimensions", () => {
    const cfg = defaults() as any;
    cfg.engine.embedding = { provider: "openai", model: "text-embedding-3-large", dimensions: 3072, apiKeyEnv: "OPENAI_API_KEY" };
    cfg.memory = { ...cfg.memory, embedding: { privacyAck: { provider: "openai", acknowledgedAt: "2026-10-18T09:00:00Z", by: "owner" } } };
    assert.deepEqual(memoryModelStatus(buildEngineConfig(cfg, l), cfg, false).embedding, { provider: "openai", model: "text-embedding-3-large", dimensions: 3072, configured: true });
  });
  it("a named namespace layout is never treated as fresh", () => {
    const cfg = defaults() as any; cfg.engine.namespaces = { activeWriteNamespace: "plur1bus" };
    assert.equal(memoryModelStatus(buildEngineConfig(cfg, l), cfg, false).embeddingSwitch, "migration-required");
  });
});

describe("assertEmbeddingChangeAllowed", () => {
  const gemma = { key: "engine.embedding", value: { provider: "local-transformers", local: { model: "google/embeddinggemma-2", dimensions: 768 } } };
  const run = (changes: { key: string; value: unknown }[], holdsTables: boolean) => {
    const cfg = defaults();
    assertEmbeddingChangeAllowed({ current: cfg, changes, layout: l, active: buildEngineConfig(cfg, l), holdsTables: () => holdsTables });
  };
  it("lets a fresh store take another embedding model", () => {
    assert.doesNotThrow(() => run([gemma], false));
  });
  it("refuses another embedding model once the store holds a table", () => {
    assert.throws(() => run([gemma], true), (e: any) => e.error === "E_CONFLICT" && e.reason === "embedding-migration-required" && /memory reembed/.test(e.message));
  });
  it("refuses a different dimension count of the same model, which is another vector space", () => {
    const cfg = defaults() as any; cfg.engine.embedding = { local: { model: "google/embeddinggemma-2", dimensions: 768 } };
    assert.throws(() => assertEmbeddingChangeAllowed({ current: cfg, changes: [{ key: "engine.embedding.local.dimensions", value: 512 }], layout: l, active: buildEngineConfig(cfg, l), holdsTables: () => true }),
      (e: any) => e.reason === "embedding-migration-required");
  });
  it("lets unrelated changes and the active model through on a store with data", () => {
    assert.doesNotThrow(() => run([{ key: "embedding.useClass", value: "research" }, { key: "engine.reranker.local", value: { model: "jinaai/jina-reranker-v2-base-multilingual" } }], true));
    assert.doesNotThrow(() => run([{ key: "engine.embedding", value: { provider: "local-transformers", local: { model: "intfloat/multilingual-e5-small", dimensions: 384 } } }], true));
  });
  it("never looks at the store when the embedding stays the same", () => {
    const cfg = defaults();
    assert.doesNotThrow(() => assertEmbeddingChangeAllowed({ current: cfg, changes: [{ key: "engine.recallMinScore", value: 0.3 }], layout: l, active: buildEngineConfig(cfg, l), holdsTables: () => { throw new Error("store read"); } }));
  });
  it("refuses a local model the engine has not pinned, on any store", () => {
    for (const model of ["onnx-community/embeddinggemma-2-ONNX", "Qwen/Qwen3-Embedding-0.6B"]) {
      assert.throws(() => run([{ key: "engine.embedding.local", value: { model } }], false), (e: any) => e.error === "E_INVALID_PARAMS" && e.reason === "embedding-model-unavailable", model);
    }
  });
});
