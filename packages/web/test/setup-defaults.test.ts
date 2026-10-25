// The wizard's model table and which model the Memory step shows and writes (ADR-006 amendment 2026-10-08): EmbeddingGemma 2
// is the single permissive default for every use class; only the Jina entries are gated by the non-commercial dialog. The
// engine side of the table (ids, revisions, widths) is checked in packages/core/test/setup/memory-models.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_EMBEDDING, DEFAULT_RERANK, MODEL_CHOICES, activeChoice, choiceById, choicesOf, engineBlock, memoryChoice, type MemoryModels } from "../src/pages/setup/licences.ts";

const fresh: MemoryModels = {
  embedding: { provider: "local-transformers", model: "intfloat/multilingual-e5-small", dimensions: 384, configured: false },
  reranker: { provider: "local-transformers", model: "woxpas-ai/bge-reranker-v2-m3-onnx" },
  embeddingSwitch: "allowed",
};

describe("setup wizard model table", () => {
  test("the default embedding model is EmbeddingGemma 2 (Apache-2.0) under the engine's id, not licence-gated", () => {
    assert.equal(DEFAULT_EMBEDDING, "egemma2");
    const d = choiceById(DEFAULT_EMBEDDING)!;
    assert.equal(d.kind, "embedding");
    assert.equal(d.model, "google/embeddinggemma-2");
    assert.equal(d.licence, "Apache-2.0");
    assert.equal(d.nc, false, "the default never needs the licence dialog");
    assert.deepEqual(engineBlock(d), { key: "engine.embedding", value: { provider: "local-transformers", local: { model: "google/embeddinggemma-2", dimensions: 768 } } });
  });

  test("only models the engine can load are offered; exactly the Jina entries are non-commercial", () => {
    assert.deepEqual(choicesOf("embedding").map((c) => c.id), ["egemma2", "e5-small", "jina-v5-nano", "jina-v3"]);
    assert.deepEqual(choicesOf("rerank").map((c) => c.id), ["bge-m3", "jina-rr-v2"]);
    assert.deepEqual(MODEL_CHOICES.filter((c) => c.nc).map((c) => c.id).sort(), ["jina-rr-v2", "jina-v3", "jina-v5-nano"]);
  });

  test("the default reranker is BGE in its ONNX export and permissive; ids are unique", () => {
    assert.equal(DEFAULT_RERANK, "bge-m3");
    assert.equal(choiceById(DEFAULT_RERANK)!.model, "woxpas-ai/bge-reranker-v2-m3-onnx");
    assert.equal(choiceById(DEFAULT_RERANK)!.nc, false);
    assert.equal(new Set(MODEL_CHOICES.map((c) => c.id)).size, MODEL_CHOICES.length);
  });
});

describe("memoryChoice", () => {
  test("a fresh store on the harness default shows EmbeddingGemma 2 and the running reranker", () => {
    assert.equal(memoryChoice("embedding", "", fresh), "egemma2");
    assert.equal(memoryChoice("rerank", "", fresh), "bge-m3");
  });
  test("the person's pick wins while the store can still switch", () => {
    assert.equal(memoryChoice("embedding", "jina-v3", fresh), "jina-v3");
    assert.equal(memoryChoice("rerank", "jina-rr-v2", fresh), "jina-rr-v2");
  });
  test("an explicitly configured embedding stays chosen until another is picked", () => {
    const configured = { ...fresh, embedding: { ...fresh.embedding, configured: true } };
    assert.equal(memoryChoice("embedding", "", configured), "e5-small");
  });
  test("a store with data keeps its embedding whatever was picked, but not its reranker", () => {
    const used: MemoryModels = { ...fresh, embeddingSwitch: "migration-required" };
    assert.equal(memoryChoice("embedding", "egemma2", used), "e5-small");
    assert.equal(memoryChoice("rerank", "jina-rr-v2", used), "jina-rr-v2");
  });
  test("a running model the table does not offer is the empty choice (kept)", () => {
    const cloud: MemoryModels = { ...fresh, embedding: { provider: "openai", model: "text-embedding-3-large", dimensions: 3072, configured: true }, reranker: { provider: "cohere", model: "rerank-v3.5" } };
    assert.equal(activeChoice("embedding", cloud), "");
    assert.equal(memoryChoice("embedding", "", cloud), "");
    assert.equal(memoryChoice("rerank", "", cloud), "");
    assert.equal(activeChoice("embedding", { ...fresh, embedding: { ...fresh.embedding, model: "google/embeddinggemma-2", dimensions: 512 } }), "", "another width is another vector space");
  });
  test("without the engine's answer the pick or the default is shown", () => {
    assert.equal(memoryChoice("embedding", "", undefined), "egemma2");
    assert.equal(memoryChoice("embedding", "e5-small", undefined), "e5-small");
  });
});
