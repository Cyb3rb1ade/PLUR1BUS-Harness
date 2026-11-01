// RE-04/T4: record namespace routes/fan-out from the harness pin and CP-5.2
// merging from v7.18.31. Real Lance tables, synthetic text, no model/network calls.
// PLUR1BUS_ENGINE_SRC=<pin> node record.mjs --namespaces <v7.18.31>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordRuntimeCases } from "./record-namespace-runtime.mjs";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const PLUGIN = "6419a60e79975d0b5244798c1fdbbd7997a712ce";
const AGENT = "namespace-fixture";
const QUERY = "Synthetic namespace fixture";
const NOW = 1_798_761_600_000;
const WIDTH = 384;
const names = [
  "namespaces-two-tables",
  "namespaces-legacy-table-missing-is-skipped",
  "namespaces-second-table-error-rejects-the-whole-recall",
  "namespaces-merge-keeps-reranker-order",
];
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const hash = (root, file) =>
  createHash("sha256")
    .update(readFileSync(path.join(root, file)))
    .digest("hex");
const sources = JSON.parse(readFileSync(new URL("./namespace-sources.json", import.meta.url), "utf8"));

function verifySources(engineRoot, pluginRoot) {
  assert.equal(sources.runtime.commit, PIN);
  assert.equal(sources.plugin.commit, PLUGIN);
  for (const [kind, root] of [
    ["runtime", engineRoot],
    ["plugin", pluginRoot],
  ]) {
    for (const [file, expected] of Object.entries(sources[kind].sha256)) {
      assert.equal(hash(root, file), expected, `immutable ${kind} source mismatch: ${file}`);
    }
  }
}
const vector = () => Array.from({ length: WIDTH }, (_, index) => (index === 0 ? 1 : 0));

function row(id, text = id, extra = {}) {
  return {
    id,
    text,
    summary: text,
    agentId: AGENT,
    storedBy: AGENT,
    scope: "agent-private",
    category: "fact",
    status: "active",
    epistemicStatus: "",
    memoryStrength: 1,
    createdAt: NOW,
    expiresAt: 0,
    ...extra,
  };
}

function memory(id, score, extra = {}) {
  return { entry: row(id), score, source: "vector", ...extra };
}

function projectTrace(trace) {
  const fields = ["candidates", "decisions", "guards", "storeDecisions"];
  return Object.fromEntries(
    fields.map((field) => [
      field,
      (trace?.[field] ?? []).map((entry) => {
        const projected = {};
        for (const key of ["id", "memoryId", "action", "stage", "reason", "name", "passed", "namespace"]) {
          if (entry[key] !== undefined) projected[key] = entry[key];
        }
        return projected;
      }),
    ]),
  );
}

function project(result) {
  return {
    queryVector: result.queryVector ? Array.from(result.queryVector).slice(0, 2) : null,
    canonical: result.canonical.map((item) => ({
      heading: item.heading,
      text: item.text,
      score: item.score,
      namespace: item.namespace,
    })),
    memories: result.memories.map((item) => ({
      id: item.entry.id,
      text: item.entry.text,
      score: item.score,
      rerankScore: item.rerankScore ?? null,
      namespace: item.namespace,
      source: item.source,
    })),
    trace: projectTrace(result.trace),
  };
}

function traceOf(module, maxDecisions = 100) {
  return module.createRecallDecisionTrace({
    query: QUERY,
    maxCandidates: 100,
    maxDecisions,
    maxGuards: 100,
    maxStoreDecisions: 100,
    config: { maxDecisions },
  });
}

function mergeRuns(pipeline, traces) {
  const cases = [
    {
      name: "scores-duplicates-canonical-and-cap",
      options: { maxOut: 4, canonicalMaxItems: 2, dedupEnabled: false },
      input: [
        {
          namespace: "first",
          queryVector: [1, 0],
          canonical: [
            { heading: " Release ", text: "Alpha\u00a0 beta", score: 0.7 },
            { heading: "Other", text: "Other canonical", score: 0.5 },
          ],
          memories: [memory("same", 0.4), memory("tie-a", 0.7), memory("low", 0.1)],
        },
        {
          namespace: "second",
          canonical: [{ heading: "release", text: "alpha beta", score: 0.9 }],
          memories: [memory("same", 0.8, { entry: row("same", "Higher copy") }), memory("tie-b", 0.7)],
        },
      ],
    },
    {
      name: "jaccard-dedup-and-disjoint-validity",
      options: { maxOut: 6, dedupEnabled: true, dedupJaccard: 0.78 },
      input: [
        {
          namespace: "first",
          memories: [
            memory("near-a", 0.9, { entry: row("near-a", "alpha beta gamma delta") }),
            memory("past", 0.8, { entry: row("past", "temporal words", { validFrom: 1, validUntil: 10 }) }),
          ],
        },
        {
          namespace: "second",
          memories: [
            memory("near-b", 0.7, { entry: row("near-b", "alpha beta gamma delta") }),
            memory("future", 0.6, { entry: row("future", "temporal words", { validFrom: 10, validUntil: 20 }) }),
          ],
        },
      ],
    },
    {
      name: "fair-child-traces-and-global-decisions",
      options: { maxOut: 4, dedupEnabled: false },
      maxDecisions: 4,
      input: [
        {
          namespace: "first",
          memories: [memory("same", 0.8)],
          trace: {
            decisions: [
              { memoryId: "a", action: "rejection", stage: "fixture", reason: "first-old" },
              { memoryId: "b", action: "rejection", stage: "fixture", reason: "first-new" },
            ],
            candidates: [{ id: "same", source: "vector", score: 0.8, summary: "Synthetic" }],
            guards: [{ name: "fixture", passed: false, reason: "guard-a" }],
          },
        },
        {
          namespace: "second",
          memories: [memory("same", 0.4)],
          trace: {
            decisions: [{ memoryId: "c", action: "rejection", stage: "fixture", reason: "second-new" }],
            storeDecisions: [{ memoryId: "same", action: "fixture", reason: "store-b" }],
          },
        },
      ],
    },
    {
      name: "replacement-of-two-disjoint-origin-revisions",
      options: { maxOut: 4, dedupEnabled: false },
      input: [
        {
          namespace: "first",
          memories: [
            memory("old-a", 0.8, {
              entry: row("old-a", "first revision", {
                sourceAgentId: "author",
                sourceMemoryId: "origin",
                validFrom: 1,
                validUntil: 10,
              }),
            }),
            memory("old-b", 0.7, {
              entry: row("old-b", "second revision", {
                sourceAgentId: "author",
                sourceMemoryId: "origin",
                validFrom: 10,
                validUntil: 20,
              }),
            }),
          ],
        },
        {
          namespace: "second",
          memories: [
            memory("replacement", 0.9, {
              entry: row("replacement", "replacement revision", {
                sourceAgentId: "author",
                sourceMemoryId: "origin",
                validFrom: 1,
                validUntil: 20,
              }),
            }),
          ],
        },
      ],
    },
    {
      name: "invalid-source-kind-falls-back-to-namespace",
      options: { maxOut: 4, dedupEnabled: false },
      input: [
        {
          namespace: "shared-workspace",
          sourceKind: "unknown",
          memories: [
            memory("shared-copy", 0.99, {
              entry: row("shared-copy", "Shared copy", { sourceAgentId: AGENT, sourceMemoryId: "original" }),
            }),
          ],
        },
        { namespace: "private", memories: [memory("original", 0.1)] },
      ],
    },
    {
      name: "default-canonical-cap-follows-global",
      options: { maxOut: 1, dedupEnabled: false },
      input: [
        {
          namespace: "first",
          canonical: [{ heading: "Canonical", text: "Canonical fixture", score: 1 }],
          memories: [memory("memory", 1)],
        },
      ],
    },
  ];
  return cases.map((spec) => {
    const before = JSON.stringify(spec.input);
    const result = pipeline.mergeNamespaceRecallResults(spec.input, {
      ...spec.options,
      trace: traceOf(traces, spec.maxDecisions),
    });
    assert.equal(JSON.stringify(spec.input), before, "namespace merge must clone wrappers");
    return { ...spec, result: project(result), inputsUnchanged: true };
  });
}

function orderRuns(pipeline, traces) {
  const input = [
    { namespace: "first", memories: [memory("r1", 0.2, { rerankScore: 1 }), memory("r2", 0.9, { rerankScore: 0.5 })] },
    { namespace: "second", memories: [memory("u1", 1)] },
  ];
  return [
    {
      name: "reranked-before-unreranked",
      input,
      options: { maxOut: 3, dedupEnabled: false },
      result: project(
        pipeline.mergeNamespaceRecallResults(input, { maxOut: 3, dedupEnabled: false, trace: traceOf(traces) }),
      ),
    },
    {
      name: "equal-rerank-scores-retain-namespace-ordinal",
      input: [
        { namespace: "first", memories: [memory("tie-first", 0.1, { rerankScore: 0.8 })] },
        { namespace: "second", memories: [memory("tie-second", 0.99, { rerankScore: 0.8 })] },
      ],
      options: { maxOut: 2, dedupEnabled: false },
      result: project(
        pipeline.mergeNamespaceRecallResults(
          [
            { namespace: "first", memories: [memory("tie-first", 0.1, { rerankScore: 0.8 })] },
            { namespace: "second", memories: [memory("tie-second", 0.99, { rerankScore: 0.8 })] },
          ],
          { maxOut: 2, dedupEnabled: false, trace: traceOf(traces) },
        ),
      ),
    },
  ];
}

function routingRuns(module) {
  const specs = [
    { name: "implicit-flat", config: null },
    { name: "explicit-defaults", config: {} },
    { name: "active-leaf", leaf: "active", config: { activeWriteNamespace: "active" } },
    {
      name: "stable-dedup-without-legacy",
      config: {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active", "other", "active"],
        legacyReadOnlyNamespaces: ["legacy", "legacy"],
      },
    },
    {
      name: "cross-namespace-includes-legacy",
      config: {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["other", "active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      },
    },
    { name: "overlap-is-refused", config: { activeWriteNamespace: "active", legacyReadOnlyNamespaces: ["active"] } },
    { name: "writer-must-be-readable", config: { activeWriteNamespace: "active", activeRecallNamespaces: ["other"] } },
    {
      name: "ambiguous-non-writer-leaf",
      leaf: "other",
      config: { activeWriteNamespace: "active", activeRecallNamespaces: ["active", "other"] },
    },
  ];
  return specs.map((spec) => {
    const base = path.join("/fixture", "stores", spec.leaf ?? "");
    try {
      const layout = module.resolveNamespaceLayout(base, spec.config ?? {}, { explicit: spec.config !== null });
      return {
        ...spec,
        result: {
          threw: false,
          mode: layout.mode,
          write: layout.activeWriteNamespace,
          read: layout.mode === "legacy-flat" ? [null] : layout.recallReadNamespaces,
          baseLeafWasStripped: layout.baseDir !== base,
        },
      };
    } catch {
      return { ...spec, result: { threw: true } };
    }
  });
}

async function runtimeRun(root, name, modules) {
  const { MemoryDB, MultiNamespacePool, AgentDbPool, namespaceConfig, namespaceRecall, traces } = modules;
  const scratch = mkdtempSync(path.join(tmpdir(), "re04-t4-"));
  const base = path.join(scratch, "stores");
  mkdirSync(base);
  const config = {
    activeWriteNamespace: "active",
    activeRecallNamespaces: ["active"],
    legacyReadOnlyNamespaces: ["legacy"],
    crossNamespaceRecall: true,
  };
  const missing = name.includes("missing");
  const error = name.includes("error");
  const rows = [{ namespace: "active", row: row("11111111-1111-4111-8111-111111111111", "Active synthetic fixture") }];
  if (!missing)
    rows.push({ namespace: "legacy", row: row("22222222-2222-4222-8222-222222222222", "Legacy synthetic fixture") });
  const seeded = [];
  let pool;
  try {
    for (const item of rows) {
      const db = new MemoryDB(path.join(base, item.namespace, AGENT), WIDTH);
      await db.store({ ...item.row, vector: vector() });
      // Rust's Store is a persistence primitive. Seed its fixture with the row
      // Node actually wrote, including new-write epistemic normalization.
      const persisted = await db.getById(item.row.id);
      for (const key of Object.keys(item.row)) {
        if (persisted[key] !== undefined) {
          item.row[key] = typeof persisted[key] === "bigint" ? Number(persisted[key]) : persisted[key];
        }
      }
      seeded.push(db);
    }
    const layout = namespaceConfig.resolveNamespaceLayout(base, config, { explicit: true });
    pool = new MultiNamespacePool(layout, WIDTH, AgentDbPool);
    const ledger = [];
    const completed = [];
    const realNow = Date.now;
    Date.now = () => NOW;
    let result;
    try {
      result = await pool.withReadDbs(AGENT, async (leased) => {
        const present = [];
        for (const item of leased) {
          if ((await item.db.init()) !== false && item.db.table) present.push({ ...item, sourceKind: "private" });
        }
        if (error) {
          const failing = present.find((item) => item.namespace === "legacy");
          failing.db.table.vectorSearch = () => {
            completed.push("legacy-error");
            throw new Error("synthetic table read failed");
          };
          const active = present.find((item) => item.namespace === "active");
          const original = active.db.table.vectorSearch.bind(active.db.table);
          active.db.table.vectorSearch = (...args) => {
            completed.push("active-read");
            return original(...args);
          };
        }
        return namespaceRecall.runMergedNamespaceRecall(
          present,
          {
            query: QUERY,
            agentId: AGENT,
            workspaceKey: "",
            topN: 4,
            candidateTopK: 40,
            budget: 4,
            recallMinScore: 0.15,
            canonicalEnabled: false,
            canonicalMaxItems: 2,
            associativeEnabled: false,
            dedupEnabled: false,
            queryRefinerEnabled: false,
            embeddings: { embed: async () => vector(), embedQuery: async () => vector() },
            aclCtx: { agentId: AGENT, allowedAgents: [AGENT], visibleScopes: ["agent-private"] },
            retrievalLogger: (entry) => {
              const line = modules.dynamics.createRetrievalLedgerEntry({ ...entry, timestamp: NOW });
              assert.match(line.id, /^[0-9a-f-]{36}$/);
              ledger.push({ ...line, id: "__UUID__" });
            },
          },
          traceOf(traces),
          null,
        );
      });
      result = { threw: false, ...project(result) };
    } catch (failure) {
      result = { threw: true, errorName: failure.name, errorMessage: failure.message };
    } finally {
      Date.now = realNow;
    }
    return {
      config,
      agentId: AGENT,
      query: QUERY,
      now: NOW,
      rows,
      missingLegacyCreated: missing ? existsSync(path.join(base, "legacy")) : null,
      result,
      ledger,
      ledgerLines: ledger.map((line) => `${JSON.stringify(line)}\n`),
      completed: completed.sort(),
    };
  } finally {
    await pool?.shutdown();
    for (const db of seeded) await db.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function recordNamespaces(engineRoot, pluginRoot) {
  assert.equal(process.version, "v24.21.0", "record with the documented Node version");
  verifySources(engineRoot, pluginRoot);
  const pipeline = await load(pluginRoot, "lib/recall-pipeline.js");
  const traces = await load(pluginRoot, "lib/recall-decision-trace.js");
  const modules = {
    ...(await load(engineRoot, "engine/store/memory-db.js")),
    ...(await load(engineRoot, "lib/multi-namespace-pool.js")),
    ...(await load(engineRoot, "engine/store/agent-db-pool.js")),
    namespaceConfig: await load(engineRoot, "lib/namespace-config.js"),
    namespaceRecall: await load(engineRoot, "engine/recall/namespace-recall.js"),
    traces: await load(engineRoot, "lib/recall-decision-trace.js"),
    dynamics: await load(engineRoot, "lib/memory-dynamics.js"),
  };
  const recordedFrom = {
    engine: "node",
    runtimeCommit: PIN,
    mergeCommit: PLUGIN,
    mergeTag: "v7.18.31",
    node: process.version,
    unicode: process.versions.unicode,
    icu: process.versions.icu,
    runtimeSourceSha256: hash(engineRoot, "engine/recall/namespace-recall.js"),
    ledgerSourceSha256: hash(engineRoot, "lib/memory-dynamics.js"),
    mergeSourceSha256: hash(pluginRoot, "lib/recall-pipeline.js"),
    sources,
  };
  const capture = async () => {
    const files = {};
    for (const name of names.slice(0, 3))
      files[name] = { recordedFrom, runtime: await runtimeRun(engineRoot, name, modules) };
    files[names[0]].merges = mergeRuns(pipeline, traces);
    files[names[0]].routing = routingRuns(modules.namespaceConfig);
    const nullableLine = modules.dynamics.createRetrievalLedgerEntry({
      agentId: "",
      workspaceKey: "",
      query: "",
      resultsCount: 2,
      selectedIds: [undefined, "kept"],
      timestamp: NOW,
    });
    nullableLine.id = "__UUID__";
    files[names[3]] = {
      recordedFrom,
      merges: orderRuns(pipeline, traces),
      nullableLedgerLine: `${JSON.stringify(nullableLine)}\n`,
    };
    for (const [name, runtime] of Object.entries(await recordRuntimeCases(engineRoot, pluginRoot))) {
      files[name] = { recordedFrom, runtime };
    }
    return files;
  };
  const first = await capture();
  assert.deepEqual(await capture(), first, "two Node recordings must agree");
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "golden", "namespaces");
  mkdirSync(out, { recursive: true });
  for (const [name, data] of Object.entries(first)) {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    assert.equal(text.toLowerCase().includes("open" + "claw"), false, "forbidden marker in fixture");
    writeFileSync(path.join(out, `${name}.json`), text);
  }
  process.stdout.write(`recorded ${Object.keys(first).length} namespace goldens from Node\n`);
}
