/** Supervised source-model probing owns private copies only; target configuration remains with the maintenance host. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, validate, type HarnessConfig } from "@plur1bus/config-schema";
import { EMBEDDING_PREPARATION_TARGETS } from "@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { buildEngineConfig, checkEngineConfigLicences } from "../engine-config.ts";
import { targetFromModel } from "../embedding-migrate/target.ts";
import { layout } from "../paths.ts";
import type { ImportConfigChange, ImportStoreProbe } from "./execution.ts";
import { prepareOpenclawStores } from "./importers/openclaw-stores.ts";
import { inspectStoreAdopt } from "./importers/hermes-stores.ts";
import { SourceReader } from "./source-reader.ts";
import { sourceStoreModel, type SourceStoreModel } from "./source-store-model.ts";
import type { SourceRegistry } from "./source-registry.ts";
import { ImportError } from "./types.ts";

const unavailable = () => new ImportError("E_NOT_AVAILABLE", "source-store-transfer-unsupported", "Source store transfer is unavailable");
type Captured = Awaited<ReturnType<SourceRegistry["get"]>>;

function checked(config: object): HarnessConfig {
  const result = validate(structuredClone(config));
  if (!result.ok) throw unavailable();
  return result.config;
}

/** Private model controls use this only after current-person cache and licence validation. */
export function storeModelPreparation(model: string, dimensions: number): { key: string; value: object } {
  const profile = EMBEDDING_PREPARATION_TARGETS.find(item => item.model === model && item.dimensions === dimensions);
  if (!profile) throw unavailable();
  return { key: "engine.modelPreparation", value: { profile: profile.id,
    ...(profile.commercialUse === false ? { acceptNonCommercialLicense: true } : {}) } };
}

/** An omitted final model means the current canonical pinned local vector space, without silently changing prefixes. */
export function currentStoreTarget(config: object, home: string): string {
  const cfg = checked(config);
  const normalized = normalizeEmbeddingConfig(buildEngineConfig(cfg, layout(home)).embedding as Record<string, unknown>);
  if (normalized.provider !== "local-transformers" || typeof normalized.model !== "string") throw unavailable();
  const target = targetFromModel({ model: normalized.model });
  if (!target.ok || embeddingFingerprintId(embeddingFingerprintFromNormalizedConfig(normalized))
    !== embeddingFingerprintId({ ...target.fingerprint })) throw unavailable();
  return normalized.model;
}

/** Uses only validated target cache/licence controls and a pinned source candidate, never source credentials or flags. */
export function sourceStoreConfig(config: object, candidate: SourceStoreModel): HarnessConfig {
  const cfg = checked(config);
  const profile = EMBEDDING_PREPARATION_TARGETS.find(item => item.model === candidate.model && item.dimensions === candidate.dimensions);
  if (!profile || cfg.engine.namespaces !== undefined) throw unavailable();
  if (profile.commercialUse === false && (!cfg.embedding.acceptedNcLicence || cfg.embedding.useClass === "commercial")) {
    throw new ImportError("E_DENIED", "model-licence-required", "Source model licence confirmation is required");
  }
  const existing = cfg.engine.embedding as { local?: { cacheDir?: string } } | undefined;
  const { reembedding: _oldSelection, ...engine } = cfg.engine;
  cfg.engine = { ...engine, embedding: { provider: "local-transformers", local: {
    model: candidate.model, dimensions: candidate.dimensions,
    ...(existing?.local?.cacheDir ? { cacheDir: existing.local.cacheDir } : {}),
  } }, modelPreparation: storeModelPreparation(candidate.model, candidate.dimensions).value };
  return checked(cfg);
}

/** These minimal private controls are written only after the complete cold baseline exists. */
export function sourceStoreChanges(config: object, candidate: SourceStoreModel): ImportConfigChange[] {
  const next = sourceStoreConfig(config, candidate);
  return [{ key: "engine.embedding", value: next.engine.embedding }, { key: "engine.reembedding", value: null },
    { key: "engine.modelPreparation", value: next.engine.modelPreparation }];
}

/** Probe constructors inherit neither live store overrides nor feature state paths, credentials, or background routing. */
export function isolatedStoreProbeConfig(config: object, home: string): HarnessConfig {
  const selected = checked(config);
  const actual = buildEngineConfig(selected, layout(home));
  const cfg = defaults();
  cfg.embedding = { ...selected.embedding };
  cfg.privacy = { ...selected.privacy };
  cfg.memory.embedding = { ...selected.memory.embedding };
  cfg.memory.mediaEmbedding.enabled = false;
  cfg.engine = { embedding: actual.embedding,
  ...(actual.modelPreparation ? { modelPreparation: actual.modelPreparation } : {}),
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false },
  dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false },
  conversationReactivationRecall: { enabled: false } };
  return checked(cfg);
}

export function isolatedSourceProbeConfig(config: object, candidate: SourceStoreModel, home: string): HarnessConfig {
  return isolatedStoreProbeConfig(sourceStoreConfig(config, candidate), home);
}

export function configuredStoreCopyProbe(config: object, home: string,
  testInternals?: Record<string, unknown>): ImportStoreProbe {
  const isolated = isolatedStoreProbeConfig(config, home);
  checkEngineConfigLicences(buildEngineConfig(isolated, layout(home)), layout(home));
  return path => inspectStoreAdopt({ storePath: path, targetConfig: isolated, targetHome: home,
    ...(testInternals ? { testInternals } : {}) });
}

/** The same bounded Engine inspection is used again on the worker's newly staged copy. */
export function sourceStoreCopyProbe(config: object, candidate: SourceStoreModel, home: string,
  testInternals?: Record<string, unknown>): ImportStoreProbe {
  return configuredStoreCopyProbe(sourceStoreConfig(config, candidate), home, testInternals);
}

/** Existing deterministic test model seam; the ordinary fixed worker ignores it unless the host explicitly enabled internals. */
export function supervisedStoreInternals(dimensions: number): Record<string, unknown> | undefined {
  if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1" || process.env.PLUR1BUS_TEST_INTERNALS !== "flat-embedder") return undefined;
  const one = async () => Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0);
  return { embeddings: { embed: one, embedQuery: one, embedPassage: one,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(one)), shutdown: async () => {} }, reranker: null };
}

/** A source-configured temporary Engine verifies a private copy; a running target Engine is never opened twice. */
export async function probeSourceStoreTransfer(options: { home: string; source: Captured; candidate: SourceStoreModel;
  config: object; signal?: AbortSignal; testInternals?: Record<string, unknown> }): Promise<void> {
  const candidate = sourceStoreModel(options.source.read.report, options.candidate.storeId);
  if (JSON.stringify(candidate) !== JSON.stringify(options.candidate)) throw unavailable();
  const config = isolatedSourceProbeConfig(options.config, candidate, options.home);
  checkEngineConfigLicences(buildEngineConfig(config, layout(options.home)), layout(options.home));
  const scratch = await mkdtemp(join(tmpdir(), "p1b-source-store-probe-"));
  try {
    options.signal?.throwIfAborted();
    const selected = options.source.read.report.plur1bus.stores.find(store => store.storeId === candidate.storeId)!;
    const internals = options.testInternals;
    const embeddings = internals?.embeddings;
    const result = await prepareOpenclawStores({ stores: [{ ...selected,
      identity: { ...selected.identity, plannedAction: "take-over" } }], storeRoot: options.source.read.report.plur1bus.storeRoot,
    reader: new SourceReader({ ...options.source.reader, ...(options.signal ? { signal: options.signal } : {}) }),
    // Keep host policy/ledger authority at the real home; target store paths point only at this private scratch owner.
    l: { ...layout(scratch), home: options.home }, isApply: false, runId: "source-probe", onConflict: "replace",
    targetConfig: config, targetEmbedding: selected.identity.fields,
    ...(internals ? { testInternals: { ...internals,
      ...(typeof embeddings === "function" ? { embeddings: embeddings(candidate.dimensions) } : {}) } } : {}),
    });
    options.signal?.throwIfAborted();
    if (result.errors.length || result.stores.length !== 1 || result.stores[0]?.action !== "preview-ok"
      || result.adoptReport?.verdict !== "ok") {
      throw new ImportError("E_STORE_INCOMPATIBLE", "source-store-probe-failed", "Source store could not be verified with its source model");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
