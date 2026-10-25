// Model/licence table of the first-run wizard: exactly the local models the pinned memory engine pins
// (lib/providers/local-model-artifacts.js). `model` is the engine's model id, the value the Memory step writes to
// engine.embedding.local.model or engine.reranker.local.model, `revision` the engine's pinned revision and `dimensions` the
// width the step writes for an embedding model; packages/core/test/setup/memory-models.test.ts checks all three against the engine.
// Models the engine cannot load (Qwen3-Embedding and Qwen3-Reranker of ADR-006's catalogue) are not offered.
// Default (ADR-006 amendment 2026-10-08): EmbeddingGemma 2, Apache-2.0, for every use class; the use class only gates the
// non-commercial (Jina) options, which may be chosen only after the confirmation dialog (memory-step.ts).
import type { ModelMemoryStatusResult } from "../../../../rpc-schema/generated/types.ts";

export type ModelKind = "embedding" | "rerank";
export type ModelChoice = { id: string; kind: ModelKind; name: string; model: string; licence: string; nc: boolean; revision: string; dimensions?: number };

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: "egemma2", kind: "embedding", name: "EmbeddingGemma 2 (text)", model: "google/embeddinggemma-2", licence: "Apache-2.0", nc: false, revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0", dimensions: 768 },
  { id: "e5-small", kind: "embedding", name: "multilingual-e5-small", model: "intfloat/multilingual-e5-small", licence: "MIT", nc: false, revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3", dimensions: 384 },
  { id: "jina-v5-nano", kind: "embedding", name: "Jina v5 Text Nano", model: "jinaai/jina-embeddings-v5-text-nano-retrieval", licence: "CC BY-NC-4.0", nc: true, revision: "ac5d898c8d382b17167c33e5c8af644a3519b47d", dimensions: 768 },
  { id: "jina-v3", kind: "embedding", name: "Jina embeddings v3", model: "jinaai/jina-embeddings-v3", licence: "CC BY-NC-4.0", nc: true, revision: "68ed94909d564380f954be27ae2e133214c1adc9", dimensions: 1024 },
  { id: "bge-m3", kind: "rerank", name: "BGE-reranker-v2-m3", model: "woxpas-ai/bge-reranker-v2-m3-onnx", licence: "Apache-2.0", nc: false, revision: "c44ebc43de724ae8816668bb44d2e728e17faa18" },
  { id: "jina-rr-v2", kind: "rerank", name: "Jina reranker v2 base multilingual", model: "jinaai/jina-reranker-v2-base-multilingual", licence: "CC BY-NC-4.0", nc: true, revision: "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9" },
];

export const DEFAULT_EMBEDDING = "egemma2";
export const DEFAULT_RERANK = "bge-m3";
export const choiceById = (id: string): ModelChoice | undefined => MODEL_CHOICES.find((c) => c.id === id);
export const choicesOf = (kind: ModelKind): readonly ModelChoice[] => MODEL_CHOICES.filter((c) => c.kind === kind);

/** What the engine runs (`model.memory.status`), loaded each time the Memory step shows; never stored. */
export type MemoryModels = ModelMemoryStatusResult;
const LOCAL = "local-transformers";

/** The offered choice the engine runs now, or "" when it runs a model the step does not offer (a cloud model, another width). */
export function activeChoice(kind: ModelKind, m: MemoryModels): string {
  if (kind === "embedding") return m.embedding.provider === LOCAL ? choicesOf(kind).find((c) => c.model === m.embedding.model && c.dimensions === m.embedding.dimensions)?.id ?? "" : "";
  return m.reranker.provider === LOCAL ? choicesOf(kind).find((c) => c.model === m.reranker.model)?.id ?? "" : "";
}

/**
 * The choice the Memory step shows and writes: the person's own pick, else the wizard default while the store still runs the
 * harness default embedding, else what the engine runs ("" when that is none of the offered models). A store that already holds
 * data keeps its embedding whatever was picked. Without the engine's answer the pick or the default is shown, never written.
 */
export function memoryChoice(kind: ModelKind, picked: string, m: MemoryModels | undefined): string {
  const fallback = kind === "embedding" ? DEFAULT_EMBEDDING : DEFAULT_RERANK;
  if (!m) return picked || fallback;
  if (kind === "embedding" && m.embeddingSwitch !== "allowed") return activeChoice(kind, m);
  if (picked) return picked;
  return kind === "embedding" && !m.embedding.configured ? fallback : activeChoice(kind, m);
}

/** The config.set change that makes the engine run `c` (the whole block: no setting of another model stays behind). */
export function engineBlock(c: ModelChoice): { key: string; value: unknown } {
  return c.kind === "embedding"
    ? { key: "engine.embedding", value: { provider: LOCAL, local: { model: c.model, dimensions: c.dimensions } } }
    : { key: "engine.reranker", value: { provider: LOCAL, local: { model: c.model } } };
}
