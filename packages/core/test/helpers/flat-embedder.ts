/** The engine contract test's stub ($ENGINE/tests/engine-contract.test.js:33-38): a fixed 384-dimension vector, no model load. */
export interface FlatEmbedderOptions {
  /** Delays `embedPassage`/`embedBatch` (capture) by the returned milliseconds. */
  passageDelayMs?: () => number;
  /** Delays `embed`/`embedQuery` (topic list, recall, correct) by the returned milliseconds. */
  queryDelayMs?: () => number;
}

export function flatEmbedder(o: FlatEmbedderOptions = {}) {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const sleep = async (ms: number | undefined) => { if (ms !== undefined && ms > 0) await new Promise((r) => setTimeout(r, ms)); };
  const one = async () => { await sleep(o.queryDelayMs?.()); return vector(); };
  const passage = async () => { await sleep(o.passageDelayMs?.()); return vector(); };
  return { embed: one, embedQuery: one, embedPassage: passage, embedBatch: async (texts: string[]) => { await sleep(o.passageDelayMs?.()); return texts.map(vector); }, shutdown: async () => {} };
}

/** R17: the core tests' engine seam — flat embedder and no reranker, so no model is ever loaded (engine-config forces the reranker on). */
export function flatTestInternals(o: FlatEmbedderOptions & { extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  const e: FlatEmbedderOptions = { ...(o.passageDelayMs ? { passageDelayMs: o.passageDelayMs } : {}), ...(o.queryDelayMs ? { queryDelayMs: o.queryDelayMs } : {}) };
  return { embeddings: flatEmbedder(e), reranker: null, ...(o.extra ?? {}) };
}
