// The Harness-owned half of the switch (the engine's own `switch` needs a host config-mutation capability this host does
// not have): one `config.set` that writes the target embedding block and the generation selection together. `engine.*`
// keys are class `core`, so the supervisor restarts the core on the change and the target generation is active from
// that start; until the file is replaced every recall is answered by the old generation. Before writing, the guard
// derives the fingerprint the ENGINE will derive from the written configuration at start (the same functions
// create-engine.js calls) and refuses on any difference: a mismatch there would make the core refuse to start.
// Every direction is switchable (owner decision 2026-10-18): a local target writes the pinned local block, a cloud or
// self-hosted one the same fields #509 accepts (provider, model, dimensions, baseUrl, the key only as apiKeyEnv). The
// written configuration passes buildEngineConfig first, so a missing privacy acknowledgment, privacy.localOnly or missing
// details refuse the switch and leave the old configuration active.
import { readFileSync } from "node:fs";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { embeddingConfigFromSelection, embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { buildEngineConfig } from "../engine-config.ts";
import type { Layout } from "../paths.ts";
import { MigrationError } from "./driver.ts";
import { blockFromFingerprint, isLocalTarget } from "./target.ts";
import type { SwitchPort } from "./port.ts";

export interface SwitchConfig {
  /** The running configuration (the user's `engine.embedding` is carried over where the selection says nothing). */
  current(): HarnessConfig;
  /** `config.set` on the supervisor; null while the configuration is the file (nothing owns the write). */
  set(changes: { key: string; value: unknown }[]): Promise<void> | null;
}
export interface SwitchSelection { generation: string; fingerprint: Record<string, unknown>; fingerprintId: string }

/**
 * The embedding block and `reembedding` selection for a target: a local one projected by the engine's own function, a
 * remote one as the provider block (no fallback, no key, no leftover local settings of the previous provider).
 */
export function targetSelection(sel: { generation: string; fingerprint: unknown; fingerprintId: string; remote?: { apiKeyEnv: string; baseUrl?: string; privacyAck?: unknown } }, current: Record<string, unknown>) {
  const fingerprint = sel.fingerprint as Record<string, unknown>;
  const remote = !isLocalTarget(fingerprint.provider as string);
  if (remote && !sel.remote) throw new Error(`a ${String(fingerprint.provider)} target needs the name of the environment variable holding its key (apiKeyEnv)`);
  return {
    embedding: remote ? blockFromFingerprint(sel.fingerprint as never, sel.remote!) : embeddingConfigFromSelection({ generation: sel.generation, fingerprintId: sel.fingerprintId, fingerprint }, current),
    reembedding: { activeGeneration: sel.generation, fingerprintId: sel.fingerprintId, dimensions: fingerprint.dimensions as number },
  };
}

export function createConfigSwitchPort(d: { config: SwitchConfig; layout: Layout }): SwitchPort {
  const refuse = (message: string) => new MigrationError("switch-unavailable", message);
  return {
    async apply(sel) {
      const cfg = d.config.current();
      const current = ((cfg.engine as Record<string, unknown>).embedding ?? {}) as Record<string, unknown>;
      let selected: ReturnType<typeof targetSelection>;
      try { selected = targetSelection(sel, current); } catch (e) { throw refuse(e instanceof Error ? e.message : String(e)); }
      const { embedding, reembedding } = selected;
      // A plan-time acknowledgment of the cloud target (admin.reembed.plan acknowledgePrivacy) is written with the block.
      const ack = sel.remote?.privacyAck;
      // What the engine will compute from what we are about to write (harness merge → engine normalisation → fingerprint).
      const next = { ...cfg, engine: { ...cfg.engine, embedding, reembedding }, ...(ack ? { memory: { ...cfg.memory, embedding: { ...(cfg.memory as { embedding?: object }).embedding, privacyAck: ack } } } : {}) } as HarnessConfig;
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
      const p = d.config.set([{ key: "engine.embedding", value: embedding }, { key: "engine.reembedding", value: reembedding }, ...(ack ? [{ key: "memory.embedding.privacyAck", value: ack }] : [])]);
      if (p === null) throw refuse("no supervisor owns config.json for this core, so the active embedding selection cannot be written; start the daemon and retry");
      await p;
    },
    written(sel) {
      let cfg: { engine?: { reembedding?: { activeGeneration?: unknown; fingerprintId?: unknown } } };
      try { cfg = JSON.parse(readFileSync(d.layout.configPath, "utf8")); } catch { return false; }
      const r = cfg.engine?.reembedding;
      return r?.activeGeneration === sel.generation && r.fingerprintId === embeddingFingerprintId(sel.fingerprint as unknown as Record<string, unknown>);
    },
  };
}
