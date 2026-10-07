// Static model/licence table of the first-run wizard, copied from the "Model catalogue" of docs/adr/ADR-006-embedding-and-reranking.md.
// `revision` is only what that table pins (the abbreviated hashes of the two third-party ONNX exports); null = the table names none.
// A non-commercial (CC BY-NC-4.0) entry may be chosen only after the confirmation dialog (see steps.ts).
export type ModelKind = "embedding" | "rerank";
export type ModelChoice = { id: string; kind: ModelKind; name: string; hf: string; licence: string; nc: boolean; revision: string | null };

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: "qwen3-emb", kind: "embedding", name: "Qwen3-Embedding-0.6B", hf: "Qwen/Qwen3-Embedding-0.6B", licence: "Apache-2.0", nc: false, revision: null },
  { id: "e5-small", kind: "embedding", name: "multilingual-e5-small", hf: "intfloat/multilingual-e5-small", licence: "MIT", nc: false, revision: null },
  { id: "jina-v5-nano", kind: "embedding", name: "Jina v5 Text Nano", hf: "jinaai/jina-embeddings-v5-text-nano", licence: "CC BY-NC-4.0", nc: true, revision: null },
  { id: "jina-v3", kind: "embedding", name: "Jina embeddings v3", hf: "jinaai/jina-embeddings-v3", licence: "CC BY-NC-4.0", nc: true, revision: "68ed9490…adc9" },
  { id: "bge-m3", kind: "rerank", name: "BGE-reranker-v2-m3", hf: "BAAI/bge-reranker-v2-m3", licence: "Apache-2.0", nc: false, revision: "c44ebc43…aa18" },
  { id: "qwen3-rr", kind: "rerank", name: "Qwen3-Reranker-0.6B", hf: "Qwen/Qwen3-Reranker-0.6B", licence: "Apache-2.0", nc: false, revision: null },
  { id: "jina-rr-v2", kind: "rerank", name: "Jina reranker v2 base multilingual", hf: "jinaai/jina-reranker-v2-base-multilingual", licence: "CC BY-NC-4.0", nc: true, revision: null },
];

export const DEFAULT_EMBEDDING = "qwen3-emb";
export const DEFAULT_RERANK = "bge-m3";
export const choiceById = (id: string): ModelChoice | undefined => MODEL_CHOICES.find((c) => c.id === id);
export const choicesOf = (kind: ModelKind): readonly ModelChoice[] => MODEL_CHOICES.filter((c) => c.kind === kind);
