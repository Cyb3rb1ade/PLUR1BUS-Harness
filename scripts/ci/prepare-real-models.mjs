import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const coreRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url));

/** Download and SHA-verify the existing acceptance models before timing actual Core startup. */
export async function prepareRealModels({ directory, profiles, fetchImpl = globalThis.fetch, signal,
  onProgress = () => {} } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new Error('PLUR1BUS_MODELS_CACHE must name an absolute cache directory');
  }
  const { E5_EMBEDDING_PROFILE, BGE_RERANKER_PROFILE, ensurePinnedModelArtifacts } = await import(
    pathToFileURL(coreRequire.resolve('@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js')).href);
  const summaries = [];
  const startedAt = performance.now();
  let profileIndex = 0;
  for (const profile of profiles ?? [E5_EMBEDDING_PROFILE, BGE_RERANKER_PROFILE]) {
    const index = ++profileIndex;
    const report = (stage, fields = {}) => onProgress({ profile: index, stage,
      elapsedMs: Math.round(performance.now() - startedAt), ...fields });
    const artifactProgress = new Map();
    let requests = 0;
    report('verify-started');
    // Reuse the exactly pinned Engine's atomic downloader, size/SHA validation and licence gate.
    // No noncommercial consent, alternative model, retry or unverified cache entry is introduced.
    const { downloaded, reused } = await ensurePinnedModelArtifacts(profile, directory, {
      fetchImpl: async (...args) => {
        const request = ++requests;
        report('request-started', { request });
        const response = await fetchImpl(...args);
        // Return the original response and body untouched. Never log URLs, headers or downloaded bytes.
        report('headers-received', { request, status: response.status });
        return response;
      }, signal,
      onProgress: event => {
        const artifact = profile.artifacts.findIndex(expected => expected.path === event.artifact) + 1;
        const bucket = Math.floor(event.bytesCompleted / (16 * 1024 * 1024));
        // The pinned Engine observes its own stream. Emit at most one line per 16 MiB plus state changes.
        const previous = artifactProgress.get(artifact);
        if (previous?.state === event.state && previous.bucket === bucket) return;
        artifactProgress.set(artifact, { state: event.state, bucket });
        report(`artifact-${event.state}`, { artifact, bytesCompleted: event.bytesCompleted,
          bytesTotal: event.bytesTotal, artifactsCompleted: event.artifactsCompleted });
      },
    });
    summaries.push({ model: profile.model, revision: profile.revision, downloaded, reused });
    report('verified', { downloaded, reused });
  }
  return summaries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summaries = await prepareRealModels({ directory: process.env.PLUR1BUS_MODELS_CACHE,
      signal: AbortSignal.timeout(300_000),
      onProgress: event => process.stdout.write(`real-model preparation progress: ${JSON.stringify(event)}\n`) });
    for (const summary of summaries) process.stdout.write(`real-model artifacts verified: ${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`real-model preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
