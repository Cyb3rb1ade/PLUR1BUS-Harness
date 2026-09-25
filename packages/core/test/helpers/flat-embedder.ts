/** The engine contract test's stub ($ENGINE/tests/engine-contract.test.js:33-38): a fixed 384-dimension vector, no model load. */
export function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts: string[]) => texts.map(vector), shutdown: async () => {} };
}
