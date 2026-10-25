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
import { engineEmbedding } from "../engine-config.ts";
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

/**
 * Refuses config changes that would build the engine with another embedding identity than the running one while the store holds
 * a table (E_CONFLICT reason `embedding-migration-required`; nothing is written), and a local model the engine does not pin, which
 * it could not load (E_INVALID_PARAMS reason `embedding-model-unavailable`). The identity is the engine's own fingerprint
 * (provider, model, revision, dimensions, prompts, dtype, artefacts), derived the way the engine derives it at start; the provider
 * rules of the engine start (details, privacy acknowledgment, `privacy.localOnly`) refuse here as they would there. Changes that
 * leave `engine.embedding` alone are not inspected.
 */
export function assertEmbeddingChangeAllowed(d: { current: HarnessConfig; changes: readonly { key: string; value: unknown }[]; layout: Layout; active: Record<string, unknown>; holdsTables: () => boolean }): void {
  if (!d.changes.some((c) => c.key === "engine" || c.key === "engine.embedding" || c.key.startsWith("engine.embedding."))) return;
  const next = identity(engineEmbedding(withChanges(d.current, d.changes), d.layout));
  const active = identity(plain(d.active.embedding));
  if (next.id === active.id || freshStore(d.active, d.holdsTables())) return;
  throw new RpcError("E_CONFLICT", `the memory store already holds data embedded with ${active.model}; another embedding model needs a re-embedding migration: plur1bus memory reembed --plan --model ${next.model}`,
    { reason: "embedding-migration-required" });
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
