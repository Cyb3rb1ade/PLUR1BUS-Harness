// Read-only scan of a PLUR1BUS engine store root (the engine's own layout: lib/reembedding/lance-backend.js,
// generation-layout.js, namespace-config.js, embedding-cache.js): stores, their vector schema, the embedding cache,
// the re-embedding state and generation manifests, assembled into per-store identities (docs/import.md §8.4).
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assembleIdentity, compareIdentity, type CacheGroup, type FieldSource, type Fingerprint, type Identity } from "./identity.ts";
import { isDir, isFile, loadLanceDb, openSqliteReadOnly, readBounded } from "./readonly.ts";
import type { StoreReport } from "./types.ts";

const RESERVED = new Set([".plur1bus-shared", "control", "generations", "embedding-cache-v2"]);
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHARED_KEY = /^(?:w|u)-[a-f0-9]{62}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_NAMESPACE = "lancedb-namespaced";

export function subdirs(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
}

export interface StoreScanInput {
  baseDbPath: string;
  baseDbPathSource: "config" | "default";
  /** The PLUR1BUS plugin config (`embedding`, `reranker`, `namespaces`, `reembedding`, `runtime`, …). */
  config: Record<string, any>;
  /** Directory of the source's local model artefacts for the configured embedding model's cacheDir. */
  modelCacheDir: string | null;
  target: Identity;
}

export interface StoreScan {
  storeRoot: Record<string, unknown>;
  embeddingCache: Record<string, unknown>;
  reembedding: Record<string, unknown>;
  stores: StoreReport[];
  warnings: string[];
}

function readCacheGroups(cacheDir: string, warnings: string[]): Map<string, CacheGroup[]> {
  const out = new Map<string, CacheGroup[]>();
  let files: string[] = [];
  try { files = readdirSync(cacheDir).filter((n) => n.endsWith(".db")).sort(); } catch { return out; }
  for (const name of files) {
    const scope = name.slice(0, -3);
    try {
      const h = openSqliteReadOnly(join(cacheDir, name));
      try {
        // Only the identity columns; `debug_text` (message text) and `vector` are never selected.
        const rows = h.db.prepare("SELECT provider, model, dimensions, COUNT(*) AS entries FROM embeddings GROUP BY provider, model, dimensions ORDER BY provider, model, dimensions").all() as unknown as CacheGroup[];
        out.set(scope, rows.map((r) => ({ provider: String(r.provider), model: String(r.model), dimensions: Number(r.dimensions), entries: Number(r.entries) })));
        if (h.mode === "immutable") warnings.push(`embedding cache ${name}: larger than the copy limit, read without its WAL`);
      } finally { h.close(); }
    } catch (e) {
      warnings.push(`embedding cache ${name}: unreadable (${(e as Error).message})`);
    }
  }
  return out;
}

function readFingerprints(baseDbPath: string, warnings: string[]): { byId: Map<string, Fingerprint>; migrations: number } {
  const byId = new Map<string, Fingerprint>();
  const text = readBounded(join(baseDbPath, "control", "reembedding-state.json"), 16 * 1024 * 1024);
  if (text === null) return { byId, migrations: 0 };
  try {
    const state = JSON.parse(text) as { migrations?: Record<string, { source?: { fingerprintId?: string; fingerprint?: Fingerprint }; target?: { fingerprintId?: string; fingerprint?: Fingerprint } }> };
    const migrations = Object.values(state.migrations ?? {});
    for (const m of migrations) for (const side of [m.source, m.target]) if (side?.fingerprintId && side.fingerprint) byId.set(side.fingerprintId, side.fingerprint);
    return { byId, migrations: migrations.length };
  } catch {
    warnings.push("control/reembedding-state.json: unparseable");
    return { byId, migrations: 0 };
  }
}

function readGenerations(baseDbPath: string): { generation: string; fingerprintId: string | null; dimensions: number | null }[] {
  return subdirs(join(baseDbPath, "generations")).filter((g) => GENERATION.test(g)).map((generation) => {
    const text = readBounded(join(baseDbPath, "generations", generation, "generation.json"), 4 * 1024 * 1024);
    let m: { fingerprintId?: unknown; dimensions?: unknown } = {};
    try { if (text) m = JSON.parse(text); } catch { /* invalid manifest: reported with nulls */ }
    return { generation, fingerprintId: typeof m.fingerprintId === "string" ? m.fingerprintId : null, dimensions: Number.isSafeInteger(m.dimensions) ? (m.dimensions as number) : null };
  });
}

function modelCacheEvidence(modelCacheDir: string | null, model: unknown): { revisions: string[]; quantization: "q8" | "fp32" | null } | undefined {
  if (!modelCacheDir || typeof model !== "string" || model.split("/").some((p) => p === ".." || p === "")) return undefined;
  const dir = join(modelCacheDir, ...model.split("/"));
  if (!isDir(dir)) return undefined;
  const revisions = subdirs(dir);
  let quantization: "q8" | "fp32" | null = null;
  if (revisions.length === 1) {
    const rev = join(dir, revisions[0]!);
    if (isFile(join(rev, "onnx", "model_quantized.onnx"))) quantization = "q8";
    else if (isFile(join(rev, "onnx", "model.onnx"))) quantization = "fp32";
  }
  return { revisions, quantization };
}

interface LanceFacts { dimension: number | null; rows: number | null; rowFingerprints: string[] | null; error?: string }

async function lanceFacts(partition: string): Promise<LanceFacts> {
  const lancedb = await loadLanceDb();
  if (!lancedb) return { dimension: null, rows: null, rowFingerprints: null, error: "LanceDB unavailable" };
  let db;
  try {
    db = await lancedb.connect(partition, { readConsistencyInterval: 0 });
    const t = await db.openTable("memories");
    try {
      const schema = await t.schema();
      const vec = schema.fields.find((x) => x.name === "vector");
      const dimension = Number.isSafeInteger(vec?.type.listSize) ? vec!.type.listSize! : null;
      const rows = await t.countRows();
      let rowFingerprints: string[] | null = null;
      if (schema.fields.some((x) => x.name === "embeddingFingerprint")) {
        // Only this one identity column is projected; no content column is read.
        const vals = await t.query().select(["embeddingFingerprint"]).toArray();
        rowFingerprints = [...new Set(vals.map((r) => r.embeddingFingerprint).filter((v): v is string => typeof v === "string" && v !== ""))].sort();
      }
      return { dimension, rows, rowFingerprints };
    } finally { t.close(); }
  } catch (e) {
    return { dimension: null, rows: null, rowFingerprints: null, error: (e as Error).message };
  } finally { db?.close(); }
}

export async function scanStoreRoot(input: StoreScanInput): Promise<StoreScan> {
  const warnings: string[] = [];
  const cfg = input.config;
  const base = input.baseDbPath;
  const selection = cfg.reembedding && typeof cfg.reembedding === "object" ? cfg.reembedding as { activeGeneration?: string; fingerprintId?: string; dimensions?: number } : null;
  const namespaces = cfg.namespaces && typeof cfg.namespaces === "object" ? cfg.namespaces as { activeWriteNamespace?: string; activeRecallNamespaces?: string[]; legacyReadOnlyNamespaces?: string[] } : null;
  const writer = namespaces ? (namespaces.activeWriteNamespace ?? DEFAULT_NAMESPACE) : null;
  const baseDir = namespaces && writer && basename(base) === writer ? dirname(base) : base;
  let layoutMode: "legacy-flat" | "named" | "generation" = namespaces ? "named" : "legacy-flat";
  let activeRoot = namespaces && writer ? join(baseDir, writer) : base;
  let sharedBase = namespaces ? baseDir : base;
  const activeGeneration = selection?.activeGeneration && GENERATION.test(selection.activeGeneration) ? selection.activeGeneration : null;
  if (activeGeneration) {
    layoutMode = "generation";
    const genRoot = join(base, "generations", activeGeneration);
    activeRoot = writer ? join(genRoot, writer) : genRoot;
    sharedBase = genRoot;
  }
  const generations = readGenerations(base);
  const { byId, migrations } = readFingerprints(base, warnings);
  const cacheDir = join(base, "embedding-cache-v2");
  const cacheGroups = readCacheGroups(cacheDir, warnings);
  const activeManifest = activeGeneration ? generations.find((g) => g.generation === activeGeneration) : undefined;
  if (activeGeneration && !activeManifest) warnings.push(`active generation ${activeGeneration} has no generation.json`);
  const activeFpId = activeManifest?.fingerprintId ?? selection?.fingerprintId ?? null;
  const fingerprint = activeFpId ? byId.get(activeFpId) : undefined;
  const emb = cfg.embedding && typeof cfg.embedding === "object" ? cfg.embedding as Record<string, any> : undefined;
  const configModel = emb?.provider === "local-transformers" ? (emb.local?.model ?? emb.model) : emb?.model;
  const modelCache = modelCacheEvidence(input.modelCacheDir, fingerprint?.model ?? configModel);
  const configDim = Number.isSafeInteger(emb?.local?.dimensions) ? emb!.local.dimensions : Number.isSafeInteger(emb?.dimensions) ? emb!.dimensions : null;
  const cacheScope = cfg.runtime?.embeddingCacheScope === "shared" ? "shared" : "agent";

  const partitions: { storeId: string; kind: "agent" | "shared"; agentId: string | null; namespace: string | null; path: string }[] = [];
  const nsOf = layoutMode === "legacy-flat" ? null : writer;
  for (const name of subdirs(activeRoot)) {
    if (RESERVED.has(name) || name.startsWith("_") || name.startsWith(".") || !AGENT_ID.test(name)) continue;
    if (!isDir(join(activeRoot, name, "memories.lance"))) continue;
    partitions.push({ storeId: `agent:${name}`, kind: "agent", agentId: name, namespace: nsOf, path: join(activeRoot, name) });
  }
  if (namespaces) {
    for (const ns of [...new Set([...(namespaces.activeRecallNamespaces ?? []), ...(namespaces.legacyReadOnlyNamespaces ?? [])])].filter((n) => n !== writer && AGENT_ID.test(n))) {
      const nsRoot = join(activeGeneration ? join(base, "generations", activeGeneration) : baseDir, ns);
      for (const name of subdirs(nsRoot)) {
        if (!AGENT_ID.test(name) || RESERVED.has(name) || !isDir(join(nsRoot, name, "memories.lance"))) continue;
        partitions.push({ storeId: `agent:${name}@${ns}`, kind: "agent", agentId: name, namespace: ns, path: join(nsRoot, name) });
      }
    }
  }
  for (const kind of ["workspaces", "users"] as const) {
    const kindRoot = join(sharedBase, ".plur1bus-shared", kind);
    for (const key of subdirs(kindRoot)) {
      if (!SHARED_KEY.test(key) || !isDir(join(kindRoot, key, "memories.lance"))) continue;
      partitions.push({ storeId: `shared:${kind}:${key}`, kind: "shared", agentId: null, namespace: null, path: join(kindRoot, key) });
    }
  }

  const stores: StoreReport[] = [];
  for (const p of partitions) {
    const facts = await lanceFacts(p.path);
    if (facts.error) warnings.push(`${p.storeId}: vector schema unreadable (${facts.error})`);
    const cache = cacheGroups.get(cacheScope === "shared" || p.kind === "shared" ? "shared" : p.agentId!) ?? [];
    const claims: { source: FieldSource; value: number }[] = [];
    if (activeManifest?.dimensions) claims.push({ source: "store-metadata", value: activeManifest.dimensions });
    if (configDim) claims.push({ source: "config", value: configDim });
    if (cache.length === 1) claims.push({ source: "cache", value: cache[0]!.dimensions });
    const { fields, reasons } = assembleIdentity({ fingerprint, config: emb, cache, modelCache, vectorDimension: facts.dimension, dimensionClaims: claims });
    const evidence: Record<string, unknown>[] = [];
    const keys = new Set<string>();
    if (activeGeneration) {
      evidence.push({ source: "store-metadata", kind: "generation", generation: activeGeneration, fingerprintId: activeFpId, dimensions: activeManifest?.dimensions ?? null, fingerprintRecord: fingerprint ? "found" : "missing" });
      keys.add(fingerprint ? `${fingerprint.model}|${fingerprint.dimensions}` : String(activeFpId));
    }
    for (const g of cache) { evidence.push({ source: "cache", provider: g.provider, model: g.model, dimensions: g.dimensions, entries: g.entries }); keys.add(`${g.model}|${g.dimensions}`); }
    if (facts.rowFingerprints) evidence.push({ source: "store-metadata", kind: "row-fingerprints", distinct: facts.rowFingerprints.length, fingerprintIds: facts.rowFingerprints.slice(0, 10) });
    const distinct = Math.max(keys.size, facts.rowFingerprints?.length ?? 0, (facts.rows ?? 0) > 0 ? 1 : 0);
    const allReasons = [...reasons];
    if (distinct > 1) allReasons.push("multiple-identities");
    const comparison = compareIdentity(fields, input.target, allReasons);
    if (comparison.verdict === "undetermined") allReasons.push("identity-undetermined");
    for (const [k, v] of Object.entries(comparison.fields)) if (v === "mismatch") allReasons.push(`${k}-differs`);
    stores.push({
      ...p, rows: facts.rows,
      identity: { fields, distinctIdentities: distinct, evidence, comparison, plannedAction: comparison.verdict === "match" ? "take-over" : "re-embedding-migration", reasons: allReasons },
    });
  }
  return {
    storeRoot: { baseDbPath: base, baseDbPathSource: input.baseDbPathSource, present: isDir(base), layout: layoutMode, activeRoot, activeGeneration, namespace: writer },
    embeddingCache: { present: isDir(cacheDir), path: cacheDir, scope: cacheScope, databases: [...cacheGroups.entries()].map(([scope, groups]) => ({ scope, groups: groups.length, entries: groups.reduce((a, g) => a + g.entries, 0) })) },
    reembedding: { migrations, generations, fingerprintRecords: byId.size, activeFingerprintId: activeFpId },
    stores,
    warnings,
  };
}
