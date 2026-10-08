// The wizard's static model table (ADR-006 amendment 2026-10-08): EmbeddingGemma 2 is the single permissive default
// for every use class; only the Jina entries are gated by the non-commercial confirmation dialog.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_EMBEDDING, DEFAULT_RERANK, MODEL_CHOICES, choiceById, choicesOf } from "../src/pages/setup/licences.ts";

describe("setup wizard model table", () => {
  test("the default embedding model is EmbeddingGemma 2 (Apache-2.0, pinned ONNX export revision), not licence-gated", () => {
    assert.equal(DEFAULT_EMBEDDING, "egemma2");
    const d = choiceById(DEFAULT_EMBEDDING)!;
    assert.equal(d.kind, "embedding");
    assert.equal(d.hf, "onnx-community/embeddinggemma-2-ONNX");
    assert.equal(d.licence, "Apache-2.0");
    assert.equal(d.nc, false, "the default never needs the licence dialog");
    assert.equal(d.revision, "daa72c51…90c0", "ONNX export commit daa72c51243991dfcaf9f9137d2c573d8f7790c0");
  });

  test("Qwen3, e5-small and Jina stay selectable; exactly the Jina entries are non-commercial", () => {
    const ids = choicesOf("embedding").map((c) => c.id);
    for (const id of ["egemma2", "qwen3-emb", "e5-small", "jina-v5-nano", "jina-v3"]) assert.ok(ids.includes(id), id);
    assert.deepEqual(choicesOf("embedding").filter((c) => c.nc).map((c) => c.id).sort(), ["jina-v3", "jina-v5-nano"]);
    assert.equal(choiceById("qwen3-emb")!.nc, false);
    assert.equal(choiceById("e5-small")!.nc, false);
  });

  test("the default reranker is unchanged and permissive; ids are unique", () => {
    assert.equal(DEFAULT_RERANK, "bge-m3");
    assert.equal(choiceById(DEFAULT_RERANK)!.nc, false);
    assert.equal(new Set(MODEL_CHOICES.map((c) => c.id)).size, MODEL_CHOICES.length);
  });
});
