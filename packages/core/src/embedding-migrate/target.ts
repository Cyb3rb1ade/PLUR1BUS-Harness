// The target fingerprint for `--model`: built with the engine's own functions (normalisation of a local-transformers
// embedding block, then the fingerprint of that normalised config), so the revision and artefact hashes are the pinned
// ones and the id equals what the engine derives at start. Only pinned local models: the Harness runs the engine with
// local-transformers embeddings (engine-config.ts), so anything else could be copied but never switched to.
import { embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { refuseTarget, type EmbeddingFingerprint, type ProbeResult } from "./probe.ts";

export interface TargetModel { model: string; dimensions?: number; queryPrefix?: string; passagePrefix?: string }

export function targetFromModel(t: TargetModel): { ok: true; fingerprint: EmbeddingFingerprint } | { ok: false; probe: ProbeResult } {
  try {
    const local: Record<string, unknown> = { model: t.model, ...(t.dimensions !== undefined ? { dimensions: t.dimensions } : {}), ...(t.queryPrefix !== undefined ? { queryPrefix: t.queryPrefix } : {}), ...(t.passagePrefix !== undefined ? { passagePrefix: t.passagePrefix } : {}) };
    const n = normalizeEmbeddingConfig({ provider: "local-transformers", local });
    return { ok: true, fingerprint: embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions }) as unknown as EmbeddingFingerprint };
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return { ok: false, probe: refuseTarget("target-model-unpinned", `the target model is not a pinned local embedding model the harness can run (${why})`) };
  }
}
