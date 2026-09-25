/** The engine contract test's stub ($ENGINE/tests/engine-contract.test.js:33-38): a fixed 384-dimension vector, no model load. */
export function flatEmbedder(o: { passageDelayMs?: () => number } = {}) {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const delay = async () => { const ms = o.passageDelayMs?.() ?? 0; if (ms > 0) await new Promise((r) => setTimeout(r, ms)); };
  const one = async () => vector();
  const passage = async () => { await delay(); return vector(); };
  return { embed: one, embedQuery: one, embedPassage: passage, embedBatch: async (texts: string[]) => { await delay(); return texts.map(vector); }, shutdown: async () => {} };
}

/** R17: the core tests' engine seam — flat embedder and no reranker, so no model is ever loaded (engine-config forces the reranker on). */
export function flatTestInternals(o: { passageDelayMs?: () => number; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return { embeddings: flatEmbedder(o.passageDelayMs ? { passageDelayMs: o.passageDelayMs } : {}), reranker: null, ...(o.extra ?? {}) };
}
