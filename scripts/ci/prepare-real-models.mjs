import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const coreRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url));

/** Download and SHA-verify the existing acceptance models before timing actual Core startup. */
export async function prepareRealModels({ directory, profiles, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new Error('PLUR1BUS_MODELS_CACHE must name an absolute cache directory');
  }
  const { E5_EMBEDDING_PROFILE, BGE_RERANKER_PROFILE, ensurePinnedModelArtifacts } = await import(
    pathToFileURL(coreRequire.resolve('@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js')).href);
  const summaries = [];
  for (const profile of profiles ?? [E5_EMBEDDING_PROFILE, BGE_RERANKER_PROFILE]) {
    // Reuse the exactly pinned Engine's atomic downloader, size/SHA validation and licence gate.
    // No noncommercial consent, alternative model, retry or unverified cache entry is introduced.
    const { downloaded, reused } = await ensurePinnedModelArtifacts(profile, directory, { fetchImpl, signal });
    summaries.push({ model: profile.model, revision: profile.revision, downloaded, reused });
  }
  return summaries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summaries = await prepareRealModels({ directory: process.env.PLUR1BUS_MODELS_CACHE,
      signal: AbortSignal.timeout(300_000) });
    for (const summary of summaries) process.stdout.write(`real-model artifacts verified: ${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`real-model preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
