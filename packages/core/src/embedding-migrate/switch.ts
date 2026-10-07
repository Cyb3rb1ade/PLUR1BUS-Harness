// The Harness-owned half of the switch (the engine's own `switch` needs a host config-mutation capability this host does
// not have): one `config.set` that writes the target embedding block and the generation selection together. `engine.*`
// keys are class `core`, so the supervisor restarts the core on the change and the target generation is active from
// that start; until the file is replaced every recall is answered by the old generation. Before writing, the guard
// derives the fingerprint the ENGINE will derive from the written configuration at start (the same functions
// create-engine.js calls) and refuses on any difference: a mismatch there would make the core refuse to start.
import type { HarnessConfig } from "@plur1bus/config-schema";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { embeddingConfigFromSelection, embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { buildEngineConfig } from "../engine-config.ts";
import type { Layout } from "../paths.ts";
import { MigrationError } from "./driver.ts";
import type { SwitchPort } from "./port.ts";

export interface SwitchConfig {
  /** The running configuration (the user's `engine.embedding` is carried over where the selection says nothing). */
  current(): HarnessConfig;
  /** `config.set` on the supervisor; null while the configuration is the file (nothing owns the write). */
  set(changes: { key: string; value: unknown }[]): Promise<void> | null;
}
export interface SwitchSelection { generation: string; fingerprint: Record<string, unknown>; fingerprintId: string }

/** The embedding block and `reembedding` selection for a target, projected by the engine's own function. */
export function targetSelection(sel: { generation: string; fingerprint: unknown; fingerprintId: string }, current: Record<string, unknown>) {
  const fingerprint = sel.fingerprint as Record<string, unknown>;
  return {
    embedding: embeddingConfigFromSelection({ generation: sel.generation, fingerprintId: sel.fingerprintId, fingerprint }, current),
    reembedding: { activeGeneration: sel.generation, fingerprintId: sel.fingerprintId, dimensions: fingerprint.dimensions as number },
  };
}

export function createConfigSwitchPort(d: { config: SwitchConfig; layout: Layout }): SwitchPort {
  const refuse = (message: string) => new MigrationError("switch-unavailable", message);
  return {
    async apply(sel) {
      const fp = sel.fingerprint as unknown as Record<string, unknown>;
      if (fp.provider !== "local-transformers") {
        throw refuse(`switching to provider ${String(fp.provider)} is not supported here: the harness runs the engine with local-transformers embeddings only`);
      }
      const cfg = d.config.current();
      const current = ((cfg.engine as Record<string, unknown>).embedding ?? {}) as Record<string, unknown>;
      const { embedding, reembedding } = targetSelection(sel, current);
      // What the engine will compute from what we are about to write (harness merge → engine normalisation → fingerprint).
      const next = { ...cfg, engine: { ...cfg.engine, embedding, reembedding } } as HarnessConfig;
      let derived: string;
      try {
        const n = normalizeEmbeddingConfig(buildEngineConfig(next, d.layout).embedding as Record<string, unknown>);
        derived = embeddingFingerprintId(embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions }));
      } catch (e) {
        throw refuse(`the target embedding configuration is not one the engine accepts (${e instanceof Error ? e.message : String(e)})`);
      }
      if (derived !== sel.fingerprintId) {
        throw refuse("the engine would not derive the planned fingerprint from the target configuration (unpinned model or changed prefixes); not writing it");
      }
      const p = d.config.set([{ key: "engine.embedding", value: embedding }, { key: "engine.reembedding", value: reembedding }]);
      if (p === null) throw refuse("no supervisor owns config.json for this core, so the active embedding selection cannot be written; start the daemon and retry");
      await p;
    },
  };
}
