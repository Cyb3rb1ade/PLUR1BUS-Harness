// Called only by the opt-in M2 Nightly step. No cloud adapter is constructed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingAdapter, createRerankAdapter, probe } from '../../packages/embedding-adapters/src/index.ts';

const enabled = process.env.PLUR1BUS_M2_NIGHTLY === '1';
const providers = ['ollama', 'tei', 'vllm', 'llamacpp', 'omlx', 'mtplx'] as const;
for (const provider of providers) {
  const prefix = `PLUR1BUS_LIVE_${provider.toUpperCase()}`;
  const baseURL = process.env[`${prefix}_URL`], model = process.env[`${prefix}_MODEL`], dims = process.env[`${prefix}_DIMS`];
  test(`M2 Nightly local embedding/${provider}`, {
    skip: !enabled ? 'M2 Nightly disabled' : !baseURL || !model || !dims ? 'endpoint/model/dimensions not configured' : false, timeout: 120_000,
  }, async () => {
    // Catch all external errors: no endpoint, credential or provider-controlled message enters the runner output.
    try {
      const adapter = createEmbeddingAdapter({ provider, baseURL: baseURL!, model: model!, dimensions: Number(dims),
        ...(process.env[`${prefix}_KEY`] ? { secretName: 'nightly.adapter' } : {}),
      }, { getSecret: () => process.env[`${prefix}_KEY`] });
      const result = await probe(adapter);
      assert.equal(result.ok, true);
    } catch { assert.fail(`M2 ${provider} embedding probe failed (details withheld)`); }
  });
  if (provider === 'ollama') continue; // No Ollama rerank wire in the existing registry.
  const rerankURL = process.env[`${prefix}_RERANK_URL`], rerankModel = process.env[`${prefix}_RERANK_MODEL`];
  test(`M2 Nightly local rerank/${provider}`, {
    skip: !enabled ? 'M2 Nightly disabled' : !rerankURL || !rerankModel ? 'rerank endpoint/model not configured' : false, timeout: 60_000,
  }, async () => {
    try {
      const adapter = createRerankAdapter({ provider, baseURL: rerankURL!, model: rerankModel!,
        ...(process.env[`${prefix}_RERANK_KEY`] ? { secretName: 'nightly.adapter' } : {}),
      }, { getSecret: () => process.env[`${prefix}_RERANK_KEY`] });
      const results = await adapter.rerank('Where did the kitten rest?', ['A cat rested on the rug.', 'The invoice is overdue.', 'A kitten slept on a mat.'], { topN: 3 });
      assert.equal(results.length, 3);
      assert.equal(new Set(results.map(r => r.index)).size, 3);
      assert.notEqual(results[0]!.index, 1);
      assert.ok(results.every(r => Number.isFinite(r.score)));
    } catch { assert.fail(`M2 ${provider} rerank mapping/semantic smoke failed (details withheld)`); }
  });
}
