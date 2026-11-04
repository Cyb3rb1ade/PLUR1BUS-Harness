// Actual namespace runtime coverage for the #850 review. Synthetic providers only.
import assert from "node:assert/strict";
import { productionPool, captureIdentityFailureFacade } from "./record-namespace-pools.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NOW = 1_798_761_600_000;
const AGENT = "namespace-fixture";
const WIDTH = 384;
const QUERY = "Synthetic namespace fixture";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const vector = (width, basis = 0) => Array.from({ length: width }, (_, i) => (i === basis ? 1 : 0));
const row = (n, extra = {}) => ({
  id: id(n),
  text: `Synthetic namespace evidence ${n}`,
  summary: `Synthetic namespace evidence ${n}`,
  agentId: AGENT,
  storedBy: AGENT,
  scope: "agent-private",
  status: "active",
  category: "fact",
  epistemicStatus: "observed",
  memoryStrength: 1,
  createdAt: NOW,
  expiresAt: 0,
  ...extra,
});
const item = (namespace, n, extra = {}, basis = 0) => ({ namespace, row: row(n, extra), basis });

function runtimeSpecs() {
  const tiers = [
    item("active", 1),
    item("active", 2, {}, 1),
    item("active", 3, {}, 2),
    item("legacy", 4, { coreMemoryScore: 0.8 }),
    item("legacy", 5, { category: "project" }),
    item("legacy", 6),
    item("legacy", 7, { text: "Synthetic namespace evidence 1", summary: "Synthetic namespace evidence 1" }),
  ];
  const edges = [
    { source: id(1), target: id(2), strength: 0.9, directed: false, type: "related" },
    { source: id(1), target: id(3), strength: 0.8, directed: false, type: "related" },
  ];
  return [
    {
      name: "namespaces-budget-default-object-absent",
      rows: Array.from({ length: 13 }, (_, i) => item("active", i + 1)),
      params: { topN: 20 },
    },
    {
      name: "namespaces-budget-enabled-tiers",
      rows: tiers,
      edges,
      params: { topN: 9, budget: 6, recallMinScore: 0.9, associativeEnabled: true, adaptiveBudget: { enabled: true } },
    },
    {
      name: "namespaces-budget-object-absent-tiers",
      rows: tiers,
      edges,
      params: { topN: 9, budget: 6, recallMinScore: 0.9, associativeEnabled: true },
    },
    {
      name: "namespaces-canonical-graph-dedupe",
      rows: tiers,
      edges,
      knowledge:
        "## Synthetic canonical\nCanonical namespace knowledge is embedded once and retained with exact text.\n",
      params: {
        topN: 9,
        budget: 6,
        recallMinScore: 0.9,
        associativeEnabled: true,
        canonicalEnabled: true,
        dedupEnabled: true,
      },
      emotion: 1.05,
    },
    {
      name: "namespaces-runtime-rerank",
      source: "plugin",
      rows: [item("active", 1), item("active", 2), item("legacy", 3), item("legacy", 4)],
      params: { topN: 4, budget: 3 },
      rerank: { 1: 0.7, 2: 0.9, 3: 0.8, 4: 0.6 },
    },
    ...["plugin", "runtime"].map((source) => ({
      name: `namespaces-mixed-tiers-child-rerank-${source}`,
      source,
      rows: [
        item("active", 1),
        item("active", 2),
        item("active", 3, { coreMemoryScore: 0.8 }),
        item("legacy", 4, { category: "project" }),
        item("legacy", 5, { category: "project" }),
        item("legacy", 6, {}, 1),
        item("legacy", 7, {}, 2),
      ],
      edges: [
        { source: id(4), target: id(6), strength: 0.9, directed: false, type: "related" },
        { source: id(4), target: id(7), strength: 0.8, directed: false, type: "related" },
      ],
      params: { topN: 10, budget: 6, recallMinScore: 0.9, associativeEnabled: true },
      rerank: { 1: 0.99, 2: 0.94, 3: 0.95, 4: 0.97, 5: 0.92, 6: 0.98, 7: 0.93 },
    })),
    ...[false, true].map((foreignAvailable) => ({
      name: `namespaces-model-upgrade-unconfigured-legacy${foreignAvailable ? "-provider-present" : ""}-rejects`,
      defaultMismatch: true,
      foreignAvailable,
      rows: [item("active", 1), item("legacy", 2)],
      foreignDimension: WIDTH,
      params: { topN: 4, budget: 4 },
    })),
    {
      name: "namespaces-unbound-legacy-inherits-route-identity",
      unboundLegacy: true,
      rows: [item("active", 1), item("legacy", 2)],
      foreignDimension: WIDTH,
      foreignAvailable: true,
      params: { topN: 4, budget: 4 },
    },
    {
      name: "namespaces-budget-disabled-retains-thirteen",
      rows: Array.from({ length: 13 }, (_, i) => item("active", i + 1)),
      params: { topN: 20, budget: 2, adaptiveBudget: { enabled: false } },
    },
    ...[false, true].map((enabled) => ({
      name: `namespaces-canonical-exceeds-top-n-budget-${enabled ? "enabled" : "disabled"}`,
      rows: [item("active", 1), item("active", 2), item("legacy", 3), item("legacy", 4)],
      foreignDimension: WIDTH / 2,
      foreignAvailable: true,
      knowledge:
        "## First canonical\nSynthetic canonical first section.\n## Second canonical\nSynthetic canonical second section.\n",
      params: { topN: 1, budget: 3, canonicalEnabled: true, canonicalMaxItems: 2, adaptiveBudget: { enabled } },
      rerank: { 1: 0.7, 2: 0.9, 3: 0.8, 4: 0.6 },
    })),
    ...[false, true].map((enabled) => ({
      name: `namespaces-canonical-budget-below-max-items-${enabled ? "enabled" : "disabled"}`,
      rows: [item("active", 1), item("active", 2), item("legacy", 3), item("legacy", 4)],
      foreignDimension: WIDTH / 2,
      foreignAvailable: true,
      knowledge:
        "## First canonical\nSynthetic canonical first section.\n## Second canonical\nSynthetic canonical second section.\n",
      params: { topN: 2, budget: 1, canonicalEnabled: true, canonicalMaxItems: 2, adaptiveBudget: { enabled } },
      rerank: { 1: 0.7, 2: 0.9, 3: 0.8, 4: 0.6 },
    })),
    {
      name: "namespaces-fusion-rerank-fallback-disabled",
      foreignDimension: WIDTH / 2,
      foreignAvailable: true,
      rows: [item("active", 1), item("legacy", 2)],
      rerank: "unavailable",
      params: { topN: 4, budget: 4, rerankerFallbackOnError: false },
    },
    {
      name: "namespaces-ledger-workspace-present",
      rows: [item("active", 1), item("legacy", 2)],
      params: { topN: 4, budget: 4, workspaceKey: "workspace:v1:namespace-fixture" },
    },
    {
      name: "namespaces-graph-endpoint-acl-order",
      rows: [item("active", 1), item("active", 2, { agentId: "foreign", storedBy: "foreign" }, 1), item("legacy", 3)],
      edges: [edges[0]],
      params: { topN: 4, budget: 4, recallMinScore: 0.9, associativeEnabled: true },
    },
    ...[false, true].map((failure) => ({
      name: `namespaces-foreign-identities-rerank${failure ? "-fallback" : ""}`,
      rows: [item("active", 1), item("active", 2), item("legacy", 3), item("legacy", 4)],
      foreignDimension: WIDTH / 2,
      foreignAvailable: true,
      params: { topN: 3, budget: 3 },
      rerank: failure ? "unavailable" : { 1: 0.7, 2: 0.9, 3: 0.8, 4: 0.6 },
    })),
    ...[WIDTH, WIDTH / 2].map((dimension) => ({
      name: `namespaces-foreign-identity-unavailable-${dimension}`,
      rows: [item("active", 1), item("legacy", 2)],
      foreignDimension: dimension,
      params: { topN: 4, budget: 4 },
    })),
    {
      name: "namespaces-foreign-identities-available",
      rows: [item("active", 1), item("active", 2), item("legacy", 3), item("legacy", 4)],
      foreignDimension: WIDTH / 2,
      foreignAvailable: true,
      params: { topN: 4, budget: 4 },
    },
  ];
}

function snapshot(result) {
  const trace = {};
  for (const field of ["candidates", "decisions", "guards", "storeDecisions"]) {
    trace[field] = (result.trace?.[field] ?? []).map(({ addedAt, recordedAt, ...entry }) => entry);
  }
  return {
    queryVector: result.queryVector ? Array.from(result.queryVector).slice(0, 2) : null,
    canonical: result.canonical,
    memories: result.memories,
    trace,
    degraded: result.degraded ?? null,
  };
}

function parameters(spec, dependencies) {
  return {
    query: QUERY,
    agentId: AGENT,
    workspaceKey: "",
    topN: 9,
    candidateTopK: 40,
    recallMinScore: 0.15,
    canonicalEnabled: false,
    canonicalMinScore: 0.3,
    canonicalMaxItems: 2,
    associativeEnabled: false,
    dedupEnabled: false,
    dedupJaccard: 0.78,
    queryRefinerEnabled: false,
    ...spec.params,
    ...dependencies,
    aclCtx: { agentId: AGENT, allowedAgents: [AGENT], visibleScopes: ["agent-private"] },
    graphEdges: spec.edges ?? [],
  };
}

function provider(identity, calls) {
  return {
    identity,
    embedQuery: async () => {
      calls.push({ identityId: identity.model, kind: "query" });
      return vector(identity.dimension);
    },
    embed: async () => {
      calls.push({ identityId: identity.model, kind: "passage" });
      return vector(identity.dimension);
    },
  };
}

async function seedRows(modules, base, specs, identities, unboundLegacy) {
  const seeded = [];
  const rows = [];
  for (const spec of specs) {
    const identity = identities[spec.namespace];
    let db = seeded.find((db) => db.fixtureNamespace === spec.namespace);
    if (!db) {
      db = new modules.MemoryDB(
        path.join(base, spec.namespace, AGENT),
        identity.dimension,
        null,
        unboundLegacy && spec.namespace === "legacy" ? {} : { identity },
      );
      db.fixtureNamespace = spec.namespace;
      seeded.push(db);
    }
    await db.store({ ...spec.row, vector: vector(identity.dimension, spec.basis) });
    const stored = await db.getById(spec.row.id);
    const { vector: ignored, ...metadata } = stored;
    rows.push({
      namespace: spec.namespace,
      identity,
      basis: spec.basis,
      row: JSON.parse(JSON.stringify(metadata, (_, value) => (typeof value === "bigint" ? Number(value) : value))),
    });
  }
  return { seeded, rows };
}

function scriptedRanker(spec, calls) {
  if (!spec.rerank) return null;
  return {
    rerank: async (query, docs, topN) => {
      calls.push({ query, docs, topN });
      if (spec.rerank === "unavailable") throw new Error("synthetic reranker unavailable");
      return docs
        .map((text, index) => ({
          index,
          score: spec.rerank[Number(text.match(/evidence (\d+)/)?.[1])],
        }))
        .sort((a, b) => b.score - a.score);
    },
  };
}

async function captureRuntime(engineRoot, pluginRoot, spec, modules) {
  const scratch = mkdtempSync(path.join(tmpdir(), "re04-t4-review-"));
  const base = path.join(scratch, "stores");
  const workspace = path.join(scratch, "workspace");
  mkdirSync(base);
  if (spec.knowledge) {
    mkdirSync(path.join(workspace, "memory"), { recursive: true });
    writeFileSync(path.join(workspace, "memory", "KNOWLEDGE.md"), spec.knowledge);
    utimesSync(path.join(workspace, "memory", "KNOWLEDGE.md"), NOW / 1000, NOW / 1000);
  }
  const active = modules.embeddingIdentity({ provider: "fixture", model: "active", dimension: WIDTH });
  const legacy = spec.foreignDimension
    ? modules.embeddingIdentity({ provider: "fixture", model: "legacy", dimension: spec.foreignDimension })
    : active;
  const identities = { active, legacy };
  const config = {
    activeWriteNamespace: "active",
    activeRecallNamespaces: ["active"],
    legacyReadOnlyNamespaces: ["legacy"],
    crossNamespaceRecall: true,
  };
  const { seeded, rows } = await seedRows(modules, base, spec.rows, identities, spec.unboundLegacy);
  const layout = modules.namespaceConfig.resolveNamespaceLayout(base, config, { explicit: true });
  const identityRoutes =
    spec.foreignDimension && !spec.defaultMismatch ? [{ namespace: "legacy", identity: legacy }] : [];
  const pool = productionPool(modules, layout, WIDTH, active, identityRoutes);
  const ledgerLines = [];
  const calls = [];
  const rankCalls = [];
  const embeddings = provider(active, calls);
  const identityProviders = new Map([[modules.identityId(active), embeddings]]);
  if (spec.foreignAvailable) identityProviders.set(modules.identityId(legacy), provider(legacy, calls));
  const runtime = spec.source === "plugin" ? await load(pluginRoot, "index.js") : modules.namespaceRecall;
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    let result = null;
    let error = null;
    try {
      result = await pool.withReadDbs(AGENT, async (leased) => {
        const present = [];
        for (const source of leased) {
          if ((await source.db.init()) !== false && source.db.table) present.push({ ...source, sourceKind: "private" });
        }
        return runtime.runMergedNamespaceRecall(
          present,
          parameters(spec, {
            logger: { info() {}, warn() {}, debug() {} },
            embeddings,
            identityProviders,
            reranker: scriptedRanker(spec, rankCalls),
            workspaceDir: spec.knowledge ? workspace : null,
            emotionalState: spec.emotion ? { computeRecallBoost: () => spec.emotion } : null,
            retrievalLogger: (entry) => {
              const line = modules.dynamics.createRetrievalLedgerEntry({ ...entry, timestamp: NOW });
              line.id = "__UUID__";
              ledgerLines.push(`${JSON.stringify(line)}\n`);
            },
          }),
          modules.traces.createRecallDecisionTrace({
            query: QUERY,
            maxCandidates: 100,
            maxDecisions: 100,
            maxGuards: 100,
            maxStoreDecisions: 100,
          }),
          null,
        );
      });
    } catch (failure) {
      error = { name: failure.name, code: failure.code ?? null, message: failure.message };
    }
    const facade = spec.defaultMismatch
      ? await captureIdentityFailureFacade(modules, pool, scratch, AGENT, QUERY)
      : null;
    return {
      config,
      identityRoutes,
      unboundLegacy: spec.unboundLegacy ?? false,
      error,
      facade,
      agentId: AGENT,
      query: QUERY,
      now: NOW,
      rows,
      params: spec.params,
      source: spec.source ?? "runtime",
      knowledge: spec.knowledge ?? null,
      edges: spec.edges ?? [],
      emotion: spec.emotion ?? null,
      foreignAvailable: spec.foreignAvailable ?? false,
      rerank: spec.rerank ?? null,
      result: result ? snapshot(result) : null,
      ledgerLines,
      embeddingCalls: calls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      rerankCalls: rankCalls.sort((a, b) => JSON.stringify(a.docs).localeCompare(JSON.stringify(b.docs))),
    };
  } finally {
    Date.now = realNow;
    await pool.shutdown();
    for (const db of seeded) await db.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function recordRuntimeCases(engineRoot, pluginRoot) {
  const modules = {
    ...(await load(engineRoot, "engine/store/memory-db.js")),
    ...(await load(engineRoot, "lib/multi-namespace-pool.js")),
    ...(await load(engineRoot, "engine/store/agent-db-pool.js")),
    ...(await load(engineRoot, "lib/providers/embedding-identity.js")),
    namespaceConfig: await load(engineRoot, "lib/namespace-config.js"),
    namespaceRecall: await load(engineRoot, "engine/recall/namespace-recall.js"),
    traces: await load(engineRoot, "lib/recall-decision-trace.js"),
    dynamics: await load(engineRoot, "lib/memory-dynamics.js"),
    ...(await load(engineRoot, "engine/recall/assemble-prompt-context.js")),
  };
  const result = {};
  for (const spec of runtimeSpecs()) {
    const recorded = await captureRuntime(engineRoot, pluginRoot, spec, modules);
    recorded.embeddingCallSource = "runtime";
    if (spec.source === "plugin") {
      // CP-5 predates the harness pin's identity/query routing. Capture both real
      // executions: CP-5 owns ranking, the harness pin owns query coalescing.
      const routed = await captureRuntime(engineRoot, pluginRoot, { ...spec, source: "runtime" }, modules);
      recorded.embeddingCallsAtResultSource = recorded.embeddingCalls;
      recorded.embeddingCalls = routed.embeddingCalls;
      recorded.resultAtRoutingPin = routed.result;
      recorded.ledgerLinesAtRoutingPin = routed.ledgerLines;
    }
    result[spec.name] = recorded;
  }
  assert.equal(existsSync(engineRoot), true);
  return result;
}
