// When an embedding selection may be written straight into `engine.embedding` (the Memory step of the first-run wizard and every
// other `config.set` from the web, which the API checks first through `model.licence.check`). The engine binds each store table
// to the vector space it was created in and refuses the table under another model, so another identity is written only while the
// store holds no table at all; after that, moving the store is the re-embedding migration (`plur1bus memory reembed`).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { embeddingFingerprintId } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/fingerprint.js";
import { embeddingFingerprintFromNormalizedConfig } from "@cyb3rb1ade/plur1bus-memory/lib/reembedding/runtime-config.js";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { pinnedLocalModelProfile } from "@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js";
import { buildEngineConfig, engineEmbedding } from "../engine-config.ts";
import { LOCAL_PROVIDER, reembedTargetPolicy, targetFromSpec, type TargetSpec } from "./target.ts";
import { assertMemoryConfiguration } from "../licences/memory.ts";
import type { LicenceAcceptance } from "../licences/ledger.ts";
import type { Layout } from "../paths.ts";
import { RpcError } from "../rpc/errors.ts";

/** Deeper than any store layout (agent tables, shared pools, `generations/<id>/<agent>`). */
const MAX_DEPTH = 8;

/**
 * Whether the engine's store directory holds a LanceDB table (a `*.lance` directory) at any depth: an agent's table, a shared
 * pool or a copied generation, empty or not. A directory that does not exist holds none. Whatever cannot be read with certainty
 * (an unreadable directory, a symbolic link, a tree deeper than any store layout) counts as a table.
 */
export function storeHoldsTables(baseDbPath: string): boolean {
  const pending: { dir: string; depth: number }[] = [{ dir: baseDbPath, depth: 0 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    let entries;
    try { entries = readdirSync(next.dir, { withFileTypes: true }); }
    catch (e) { return !(next.depth === 0 && (e as NodeJS.ErrnoException).code === "ENOENT"); }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return true;
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".lance") || next.depth + 1 >= MAX_DEPTH) return true;
      pending.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
    }
  }
  return false;
}

export interface MemoryModelStatus {
  /** `configured`: `engine.embedding` names a provider or a local model (otherwise the harness default runs). */
  embedding: { provider: string; model: string; dimensions: number; configured: boolean };
  reranker: { provider: string; model?: string };
  /** `allowed` while the store holds no table; afterwards another embedding needs `plur1bus memory reembed`. */
  embeddingSwitch: "allowed" | "migration-required";
}

/** The models the running engine was built with (`engineConfig`), and whether another embedding can still be written. */
export function memoryModelStatus(engineConfig: Record<string, unknown>, cfg: HarnessConfig, holdsTables: boolean): MemoryModelStatus {
  const emb = normalizeEmbeddingConfig(plain(engineConfig.embedding));
  const chosen = plain(plain(cfg.engine).embedding), rer = plain(engineConfig.reranker);
  const provider = typeof rer.provider === "string" ? rer.provider : "local-transformers";
  const model = provider === "local-transformers" ? plain(rer.local).model : rer.model;
  return {
    embedding: { provider: String(emb.provider), model: String(emb.model), dimensions: Number(emb.dimensions), configured: chosen.provider !== undefined || plain(chosen.local).model !== undefined },
    reranker: { provider, ...(typeof model === "string" && model !== "" ? { model } : {}) },
    embeddingSwitch: freshStore(engineConfig, holdsTables) ? "allowed" : "migration-required",
  };
}

/** The commercially usable local default (Apache-2.0) a refusal points to. */
const PERMISSIVE_DEFAULT = "google/embeddinggemma-2";
const within = (key: string, root: string): boolean => key === root || key.startsWith(`${root}.`);
type Changes = readonly { key: string; value: unknown }[];
interface ChangeInput {
  current: HarnessConfig; changes: Changes; layout: Layout; active: Record<string, unknown>; holdsTables: () => boolean;
  /** The persisted licence confirmations: given, a non-commercial memory model needs one, as at the engine start (checkEngineConfigLicences). */
  acceptances?: readonly LicenceAcceptance[];
}
/** Keys that can change the engine's embedding identity, and the keys the licence acceptance of a non-commercial model rests on. */
const touchesIdentity = (changes: Changes): boolean => changes.some((c) => c.key === "engine" || within(c.key, "engine.embedding"));
const touchesLicence = (changes: Changes): boolean => changes.some((c) => within(c.key, "embedding") || within(c.key, "engine.modelPreparation"));

export type EmbeddingEffect = "unchanged" | "write" | "move";
/** A re-embedding target as `admin.reembed.plan` takes it, with its provider and width always named. */
export type EmbeddingTarget = TargetSpec & { provider: string; dimensions: number };
export interface EmbeddingChange {
  /**
   * `unchanged`: the vector space of the running engine; `write`: another one over a store without data (or under an engine
   * without a usable embedding), which config.set may write; `move`: another one over a store with data, which only a
   * re-embedding migration reaches (`target` is what `admin.reembed.plan` takes, and the plan reproduces its identity).
   */
  effect: EmbeddingEffect;
  current: { provider: string; model: string; dimensions: number };
  target: EmbeddingTarget | null;
}

/**
 * What `changes` (one `config.set`) do to the memory engine's embedding, compared with the engine built from `active`. Throws for
 * an embedding the engine could not load (E_INVALID_PARAMS reason `embedding-model-unavailable`): a local model it does not pin,
 * a block a re-embedding plan cannot describe, or a pinned non-commercial model whose licence acceptance the changes take away
 * (the commercial use class, a withdrawn acceptance). While the store holds data embedded with that non-commercial model, the
 * refusal is E_CONFLICT reason `embedding-migration-required`: only moving the store helps. The identity is the engine's own
 * fingerprint (provider, model, revision, dimensions, prompts, dtype, artefacts), derived the way the engine derives it at start;
 * the provider rules of the engine start (details, privacy acknowledgment, `privacy.localOnly`) refuse here as they would there.
 * The store is read only when the identity changes or a non-commercial licence is lost.
 */
export function embeddingChange(d: ChangeInput): EmbeddingChange {
  const c = classify(d);
  const target = c.next === null || c.effect === "unchanged" ? null : c.effect === "move" ? reachableTarget(c.next, c.after) : targetOf(c.next.block);
  if (d.acceptances) assertMemoryConfiguration(buildEngineConfig(c.after, d.layout), d.acceptances);
  assertLoadable(c, d.layout);
  return { effect: c.effect, current: described(c.running), target };
}

/**
 * The pre-check of every web `config.set` (`model.licence.check`): refuses a move, which config.set cannot make (E_CONFLICT reason
 * `embedding-migration-required`; nothing is written), and otherwise what `embeddingChange` refuses. Changes that touch neither
 * `engine.embedding`, the licence keys (`embedding.*`) nor `engine.modelPreparation` are not inspected.
 */
export function assertEmbeddingChangeAllowed(d: ChangeInput): void {
  if (!touchesIdentity(d.changes) && !touchesLicence(d.changes)) return;
  const c = classify(d);
  if (c.effect === "move") {
    throw new RpcError("E_CONFLICT", `the memory store already holds data embedded with ${described(c.running).model}; another embedding model needs a re-embedding migration: plur1bus memory reembed --plan --model ${c.next?.model ?? ""}`,
      { reason: "embedding-migration-required" });
  }
  assertLoadable(c, d.layout);
}

interface Classified {
  effect: EmbeddingEffect; after: HarnessConfig; fresh: () => boolean; running: Record<string, unknown>;
  /** The embedding the changes lead to; null when they leave the identity keys alone. */
  next: { id: string; model: string; block: Record<string, unknown> } | null;
}

/** `effect` of the changes against the running embedding; the store is read only when the identity changes. */
function classify(d: ChangeInput): Classified {
  const after = withChanges(d.current, d.changes);
  const fresh = (): boolean => freshStore(d.active, d.holdsTables());
  const running = plain(d.active.embedding);
  if (!touchesIdentity(d.changes)) return { effect: "unchanged", after, fresh, running, next: null };
  const block = engineEmbedding(after, d.layout);
  const next = { ...identity(block), block }, active = usableIdentity(running);
  // A running engine without a usable embedding has no vector space to keep.
  const effect: EmbeddingEffect = next.id === active?.id ? "unchanged" : active === null || fresh() ? "write" : "move";
  return { effect, after, fresh, running, next };
}

/** Refuses a pinned non-commercial embedding the engine could not load under the changed configuration (see `embeddingChange`). */
function assertLoadable(c: Classified, l: Layout): void {
  const blocked = unloadableNonCommercial(c.after, l);
  if (blocked === null) return;
  if (c.effect === "unchanged" && !c.fresh()) {
    throw new RpcError("E_CONFLICT", `the memory store holds data embedded with ${blocked}, which has a non-commercial licence: the engine loads it only with that licence accepted and a non-commercial use class. Move the store to a commercially usable model first, for example: plur1bus memory reembed --plan --model ${PERMISSIVE_DEFAULT}`,
      { reason: "embedding-migration-required" });
  }
  throw new RpcError("E_INVALID_PARAMS", `the memory engine loads ${blocked} only with its non-commercial licence accepted and a non-commercial use class; choose a commercially usable embedding model`,
    { reason: "embedding-model-unavailable" });
}

/** The target as `admin.reembed.plan` takes it: provider, model and width, local prefixes the block sets, a remote endpoint and key variable. */
function targetOf(block: Record<string, unknown>): EmbeddingTarget {
  const n = normalizeEmbeddingConfig(block), local = plain(block.local);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const provider = String(n.provider), queryPrefix = str(local.queryPrefix), passagePrefix = str(local.passagePrefix);
  const baseUrl = str(n.baseUrl), apiKeyEnv = str(n.apiKeyEnv);
  return {
    provider, model: String(n.model), dimensions: Number(n.dimensions),
    ...(provider === LOCAL_PROVIDER ? { ...(queryPrefix ? { queryPrefix } : {}), ...(passagePrefix ? { passagePrefix } : {}) } : { ...(baseUrl ? { baseUrl } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) }),
  };
}

/** `targetOf(block)`, refused when the plan it describes would not land on the block's own identity (a setting a plan cannot carry). */
function reachableTarget(next: { id: string; block: Record<string, unknown> }, cfg: HarnessConfig): EmbeddingTarget {
  const spec = targetOf(next.block);
  const t = targetFromSpec(spec, reembedTargetPolicy(cfg));
  if (t.ok && embeddingFingerprintId(t.fingerprint as unknown as Record<string, unknown>) === next.id) return spec;
  throw new RpcError("E_INVALID_PARAMS", `a re-embedding migration cannot reach this embedding block (it sets more than provider, model, dimensions, prefixes, endpoint and key variable); plan the target with plur1bus memory reembed --plan`,
    { reason: "embedding-model-unavailable" });
}

/** Provider, model and width of the running embedding, read as the engine reads them (raw when it cannot). */
function described(block: Record<string, unknown>): EmbeddingChange["current"] {
  try { const n = normalizeEmbeddingConfig(block); return { provider: String(n.provider), model: String(n.model), dimensions: Number(n.dimensions) }; } catch {
    const local = plain(block.local);
    return { provider: String(block.provider ?? LOCAL_PROVIDER), model: String(local.model ?? block.model ?? ""), dimensions: Number(local.dimensions ?? block.dimensions ?? 0) };
  }
}

/** The identity of the running embedding; null when the engine could not use it. */
function usableIdentity(block: Record<string, unknown>): { id: string; model: string } | null {
  try { return identity(block); } catch { return null; }
}

/**
 * The pinned non-commercial embedding the engine built from `cfg` could not load, because no licence acceptance reaches it
 * (`modelPreparation`, which buildEngineConfig gives only for an accepted licence and a non-commercial use class); null when
 * the engine can load its embedding, or when `cfg` fails for another reason the engine start reports itself.
 */
function unloadableNonCommercial(cfg: HarnessConfig, l: Layout): string | null {
  let engine: Record<string, unknown>;
  try { engine = buildEngineConfig(cfg, l); } catch { return null; }
  const emb = plain(engine.embedding);
  if (emb.provider !== "local-transformers") return null;
  let model: string;
  try { model = String(normalizeEmbeddingConfig(emb).model); } catch { return null; }
  if (pinnedLocalModelProfile(model)?.commercialUse !== false) return null;
  return plain(engine.modelPreparation).acceptNonCommercialLicense === true ? null : model;
}

/** A named namespace layout (`engine.namespaces`) can keep tables beside the store directory: it is never treated as fresh. */
const freshStore = (engineConfig: Record<string, unknown>, holdsTables: boolean): boolean => !holdsTables && engineConfig.namespaces === undefined;

function identity(block: Record<string, unknown>): { id: string; model: string } {
  try {
    const n = normalizeEmbeddingConfig(block);
    return { id: embeddingFingerprintId(embeddingFingerprintFromNormalizedConfig({ ...n, dimensions: n.dimensions })), model: String(n.model) };
  } catch (e) {
    throw new RpcError("E_INVALID_PARAMS", `the memory engine cannot use this embedding (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}); choose one of its pinned local models or a complete provider block`,
      { reason: "embedding-model-unavailable" });
  }
}

/** `cfg` with the dotted-key changes of one `config.set` applied (a copy; the running configuration is not touched). */
function withChanges(cfg: HarnessConfig, changes: readonly { key: string; value: unknown }[]): HarnessConfig {
  const out = structuredClone(cfg) as unknown as Record<string, unknown>;
  for (const { key, value } of changes) {
    const parts = key.split(".");
    if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue; // the schema refuses them
    let node = out;
    for (const part of parts.slice(0, -1)) {
      const child = node[part];
      node = node[part] = child !== null && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : {};
    }
    node[parts.at(-1)!] = structuredClone(value);
  }
  return out as unknown as HarnessConfig;
}

function plain(v: unknown): Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
}
