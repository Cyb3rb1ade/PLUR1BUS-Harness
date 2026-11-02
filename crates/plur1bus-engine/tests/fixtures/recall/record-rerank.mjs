// Records RE-04/T3 goldens from plugin line v7.18.31.
//
//   node record.mjs --rerank /path/to/v7.18.31
//
// The script loads lib/recall-pipeline.js and lib/recall-budget.js from that
// checkout. It also loads lib/jev-recall-filter.js with a fake fetch. Nothing
// is sent on the network. Two in-process passes must agree before any file is
// written. Time fields (recordedAt, elapsedMs) are dropped so the files stay
// deterministic. The writer refuses the forbidden product token and does not
// print request URLs, model ids, or vectors.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_COMMIT = "6419a60e79975d0b5244798c1fdbbd7997a712ce";
const here = path.dirname(new URL(import.meta.url).pathname);
const goldenDir = path.join(here, "golden", "rerank");
const forbidden = "open" + "claw";

function projectDecisions(trace) {
  return (trace?.decisions ?? []).map((decision) => ({
    memoryId: decision.memoryId,
    action: decision.action,
    stage: decision.stage,
    reason: decision.reason,
  }));
}

function projectGuards(trace) {
  return (trace?.guards ?? []).map((guard) => ({
    name: guard.name,
    passed: guard.passed,
    reason: guard.reason,
    memoryId: guard.memoryId ?? null,
  }));
}

function entry(partial) {
  return {
    id: partial.id,
    text: partial.text ?? partial.summary ?? partial.id,
    summary: partial.summary ?? partial.text ?? partial.id,
    category: partial.category ?? "note",
    coreMemoryScore: partial.coreMemoryScore ?? 0,
    agentId: partial.agentId ?? "a1",
    scope: partial.scope ?? "agent-private",
    chunkGroupId: partial.chunkGroupId ?? "",
    sourceTurnId: partial.sourceTurnId ?? "",
    validFrom: partial.validFrom ?? 0,
    validUntil: partial.validUntil ?? 0,
  };
}

function memory(partial) {
  return {
    entry: entry(partial),
    score: partial.score ?? 0,
    source: partial.source ?? "vector",
    graphSource: partial.graphSource ?? "",
  };
}

function stable(value) {
  return JSON.stringify(value);
}

export async function recordRerank(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const head = readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
  // A sparse checkout may be detached. Accept the commit file or a ref.
  const commit = head.startsWith("ref:")
    ? readFileSync(path.join(root, ".git", head.slice(5).trim()), "utf8").trim()
    : head;
  if (commit !== PLUGIN_COMMIT) {
    throw new Error(`plugin checkout is ${commit}, expected ${PLUGIN_COMMIT}`);
  }

  const first = await capture(root);
  const second = await capture(root);
  if (stable(first) !== stable(second)) {
    throw new Error("rerank recorder produced two different results");
  }
  mkdirSync(goldenDir, { recursive: true });
  for (const [name, value] of Object.entries(first)) {
    writeJson(path.join(goldenDir, name), value);
  }
  process.stdout.write(`recorded ${Object.keys(first).length} rerank goldens from ${PLUGIN_COMMIT.slice(0, 12)}\n`);
}

async function capture(root) {
  const installed = await installDriver(root);
  const driver = await import(installed.url);
  const budget = await import(pathToFileURL(path.join(root, "lib", "recall-budget.js")));
  const pipeline = await import(pathToFileURL(path.join(root, "lib", "recall-pipeline.js")));
  const filterMod = await import(pathToFileURL(path.join(root, "lib", "jev-recall-filter.js")));
  const traceMod = await import(pathToFileURL(path.join(root, "lib", "recall-decision-trace.js")));

  const recordedFrom = {
    tag: "v7.18.31",
    commit: PLUGIN_COMMIT,
    node: process.version,
    unicode: process.versions.unicode,
    icu: process.versions.icu,
  };

  const files = {};
  files["G-RERANK-1.json"] = file(recordedFrom, "G-RERANK-1", await rule1(driver, traceMod, budget, true));
  files["G-RERANK-1b.json"] = file(recordedFrom, "G-RERANK-1b", await rule1(driver, traceMod, budget, false));
  files["G-RERANK-2.json"] = file(recordedFrom, "G-RERANK-2", [await rule2(pipeline)]);
  files["G-RERANK-3.json"] = file(recordedFrom, "G-RERANK-3", await rule3(driver, traceMod));
  files["G-RERANK-4.json"] = file(recordedFrom, "G-RERANK-4", await rule4(driver, traceMod));
  files["G-RERANK-5.json"] = file(recordedFrom, "G-RERANK-5", await rule5(driver, traceMod));
  const acl = await rule6(driver, traceMod);
  files["G-RERANK-6.json"] = file(recordedFrom, "G-RERANK-6", acl);
  files["G-ACL-BEFORE-RERANK.json"] = file(recordedFrom, "G-ACL-BEFORE-RERANK", acl);
  files["G-RERANK-7.json"] = file(recordedFrom, "G-RERANK-7", [await rule7(pipeline)]);
  files["G-RERANK-8.json"] = file(recordedFrom, "G-RERANK-8", [await rule8(pipeline, traceMod)]);
  files["G-ACL-FINAL.json"] = file(recordedFrom, "G-ACL-FINAL", await finalAcl(driver, traceMod));
  files["dedupe.json"] = file(recordedFrom, "dedupe", await dedupeRuns(driver, traceMod));
  files["prefilter.json"] = file(recordedFrom, "prefilter", await prefilterRuns(filterMod));
  files["budget-resolve.json"] = file(recordedFrom, "budget-resolve", resolveRuns(budget));
  rmSync(installed.directory, { recursive: true, force: true });
  return files;
}

function file(recordedFrom, id, runs) {
  return { id, recordedFrom, runs };
}

async function installDriver(root) {
  const sourcePath = path.join(root, "lib", "recall-pipeline.js");
  const source = readFileSync(sourcePath, "utf8");
  const start = source.indexOf("  // 5. Provider-aware Rerank");
  const endMarker = "  phaseTimer?.end(\"acl\");";
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("rerank block markers missing");
  const slice = source.slice(start, end + endMarker.length);
  const needle = '  ordered = filterRecallCandidatesByAcl(ordered, aclCtx, trace, logger, "acl");';
  if (slice.split(needle).length !== 2) {
    throw new Error("final ACL call was not found once in the rerank block");
  }
  const patched = slice.replace(
    needle,
    `  if (Array.isArray(args.leak)) ordered = ordered.concat(args.leak);
  const aclPresented = ordered.length;
  ordered = filterRecallCandidatesByAcl(ordered, aclCtx, trace, logger, "acl");
  args.aclRemoved = aclPresented - ordered.length;`,
  );
  const libUrl = pathToFileURL(path.join(root, "lib")).href;
  const rewritten = source.replaceAll('from "./', `from "${libUrl}/`);
  const driver = `${rewritten}
export async function drivePostHydration(args) {
  let boosted = args.boosted;
  const query = args.query;
  const reranker = args.reranker;
  const topN = args.topN;
  const rerankCandidates = args.rerankCandidates;
  const deferFinalCap = args.deferFinalCap;
  const hardCandidateLimit = args.hardCandidateLimit;
  const dedupEnabled = args.dedupEnabled;
  const dedupJaccard = args.dedupJaccard;
  const budget = args.budget;
  const canonicalHits = args.canonicalHits;
  const rerankerTimeoutMs = args.rerankerTimeoutMs;
  const rerankerFallbackOnError = args.rerankerFallbackOnError;
  const summaryMaxWords = args.summaryMaxWords;
  const trace = args.trace;
  const logger = null;
  const phaseTimer = null;
  const retrievalLogger = null;
  const agentId = args.agentId;
  const workspaceKey = null;
  const aclCtx = args.aclCtx;
  const maybeSoftBudgetFallback = () => null;
${patched}
  return ordered;
}
`;
  const directory = mkdtempSync(path.join(tmpdir(), "re04-t3-driver-"));
  const filePath = path.join(directory, "recall-pipeline.mjs");
  writeFileSync(filePath, driver);
  return { url: pathToFileURL(filePath).href, directory };
}

function aclContext(agentId) {
  return {
    agentId,
    workspaceId: null,
    workspaceIdentity: null,
    userPrincipal: null,
    workspaceAliases: { paths: Object.freeze([]), aliases: Object.freeze([]) },
  };
}

function rerankerFor(spec, spy) {
  if (!spec) return null;
  return {
    emptyResultIsValid: spec.emptyResultIsValid === true,
    async rerank(query, docs, topN) {
      spy.saw = { docs: docs.slice(), topN };
      if (spec.error === "timeout") {
        const error = new Error("reranker timeout");
        throw error;
      }
      if (spec.error === "generic") throw new Error("reranker failed");
      return spec.hits;
    },
  };
}

async function drive(driver, traceMod, request, rows) {
  const trace = traceMod.createRecallDecisionTrace({
    query: request.query,
    config: { topN: request.topN, budget: request.budget, recallMinScore: 0.15, importanceBoost: 0 },
  });
  const spy = { saw: null };
  const canonicalHits = Array.from({ length: request.canonicalCount ?? 0 }, () => ({}));
  let threw = false;
  let errorName = null;
  let ordered = [];
  const call = {
    boosted: rows,
    query: request.query,
    reranker: rerankerFor(request.rerank, spy),
    topN: request.topN,
    rerankCandidates: request.rerankCandidates,
    deferFinalCap: request.deferFinalCap,
    hardCandidateLimit: request.candidateHardLimit,
    dedupEnabled: request.dedupEnabled,
    dedupJaccard: request.dedupJaccard,
    budget: request.budget,
    canonicalHits,
    rerankerTimeoutMs: request.rerankerTimeoutMs,
    rerankerFallbackOnError: request.rerankerFallbackOnError,
    summaryMaxWords: request.summaryMaxWords,
    trace,
    agentId: request.agentId,
    aclCtx: aclContext(request.agentId),
    leak: Array.isArray(request.leak) ? request.leak.map((row) => memory(row)) : null,
  };
  try {
    ordered = await driver.drivePostHydration(call);
  } catch (error) {
    threw = true;
    errorName = error?.name || "Error";
    ordered = [];
  }
  const result = {
    threw,
    errorName,
    ids: ordered.map((row) => row.entry.id),
    rerankScores: ordered.map((row) => (row.rerankScore === undefined ? null : row.rerankScore)),
    sources: ordered.map((row) => row.source),
    saw: spy.saw,
    decisions: projectDecisions(trace),
    guards: projectGuards(trace),
  };
  if (Array.isArray(request.leak)) result.aclRemoved = call.aclRemoved;
  return {
    name: request.name,
    kind: "pipeline",
    request: { ...request, rerank: request.rerank },
    rows: rows.map(publicRow),
    result,
  };
}

function publicRow(row) {
  return {
    id: row.entry.id,
    text: row.entry.text,
    summary: row.entry.summary,
    category: row.entry.category,
    coreMemoryScore: row.entry.coreMemoryScore,
    agentId: row.entry.agentId,
    scope: row.entry.scope,
    chunkGroupId: row.entry.chunkGroupId,
    sourceTurnId: row.entry.sourceTurnId,
    validFrom: row.entry.validFrom,
    validUntil: row.entry.validUntil,
    score: row.score,
    source: row.source,
    graphSource: row.graphSource,
  };
}

function baseRequest(name, extra) {
  return {
    name,
    query: "recall",
    topN: 12,
    budget: 12,
    rerankCandidates: 20,
    deferFinalCap: false,
    dedupEnabled: true,
    dedupJaccard: 0.78,
    candidateHardLimit: 100,
    summaryMaxWords: 150,
    rerankerTimeoutMs: 0,
    rerankerFallbackOnError: true,
    canonicalCount: 0,
    agentId: "a1",
    rerank: null,
    ...extra,
  };
}

const mixed = [
  memory({ id: "episodic-a", summary: "episodic-a", score: 0.9, category: "note" }),
  memory({ id: "project-b", summary: "project-b", score: 0.5, category: "project" }),
  memory({ id: "core-c", summary: "core-c", score: 0.4, category: "note", coreMemoryScore: 0.7 }),
  memory({ id: "graph-d", summary: "graph-d", score: 0.3, source: "graph" }),
  memory({ id: "graph-e", summary: "graph-e", score: 0.2, source: "graph" }),
];

async function rule1(driver, traceMod, budgetMod, preserve) {
  const hits = mixed.map((_, index) => ({ index, score: 1 - index / 10 }));
  const request = baseRequest(preserve ? "rerank-preserves-order" : "no-rerank-tier-order", {
    topN: 5,
    budget: 5,
    rerankCandidates: 20,
    rerank: preserve ? { emptyResultIsValid: false, hits } : null,
  });
  const pipelineRun = await drive(driver, traceMod, request, mixed.map(cloneMemory));
  const canonical = [{ entry: { id: "canonical-k" }, score: 1 }];
  const allocation = budgetMod.applyRecallBudget(mixed.map(cloneMemory), {
    canonical,
    budget: 3,
    preserveOrder: preserve,
  });
  const direct = {
    name: preserve ? "direct-preserve-order" : "direct-tier-order",
    kind: "budget",
    preserveOrder: preserve,
    budget: 3,
    canonical: [{ id: "canonical-k" }],
    rows: mixed.map(publicRow),
    result: {
      ids: allocation.selected.map((item) => item.entry?.id ?? item.id ?? ""),
      tierCounts: allocation.tierCounts,
    },
  };
  return [pipelineRun, direct];
}

function cloneMemory(row) {
  return {
    entry: { ...row.entry },
    score: row.score,
    source: row.source,
    graphSource: row.graphSource,
  };
}

async function rule2(pipeline) {
  const merged = pipeline.mergeNamespaceRecallResults([
    {
      namespace: "ns-a",
      memories: [
        { entry: { id: "r1", text: "r1", summary: "r1", agentId: "a1" }, score: 0.1, rerankScore: 0.9 },
        { entry: { id: "r2", text: "r2", summary: "r2", agentId: "a1" }, score: 0.2, rerankScore: 0.8 },
      ],
    },
    {
      namespace: "ns-b",
      memories: [
        { entry: { id: "u1", text: "u1", summary: "u1", agentId: "a1" }, score: 0.99 },
      ],
    },
  ], { maxOut: 10, dedupEnabled: false });
  return {
    name: "merge-keeps-rerank-order",
    kind: "merge",
    ids: (merged.memories ?? []).map((row) => row.entry.id),
    rerankScores: (merged.memories ?? []).map((row) => (row.rerankScore === undefined ? null : row.rerankScore)),
  };
}

async function rule3(driver, traceMod) {
  const rows = Array.from({ length: 8 }, (_, index) => memory({
    id: `m${index}`,
    summary: `m${index}`,
    score: 1 - index / 10,
  }));
  const hits = rows.map((_, index) => ({ index, score: 1 - index / 20 }));
  const cases = [
    ["cap-above-topn", { topN: 2, rerankCandidates: 4 }],
    ["topn-above-cap", { topN: 5, rerankCandidates: 2 }],
    ["cap-zero-means-all", { topN: 3, rerankCandidates: 0 }],
    ["single-row-skips-rerank", { topN: 3, rerankCandidates: 4, rowCount: 1 }],
  ];
  const runs = [];
  for (const [name, extra] of cases) {
    const count = extra.rowCount ?? rows.length;
    const slice = rows.slice(0, count).map(cloneMemory);
    const request = baseRequest(name, {
      topN: extra.topN,
      budget: 20,
      rerankCandidates: extra.rerankCandidates,
      dedupEnabled: true,
      rerank: { emptyResultIsValid: false, hits: hits.slice(0, count) },
    });
    runs.push(await drive(driver, traceMod, request, slice));
  }
  return runs;
}

async function rule4(driver, traceMod) {
  const rows = [0, 1, 2].map((index) => memory({ id: `d${index}`, summary: `d${index}`, score: 1 - index / 10 }));
  const request = baseRequest("duplicate-index-once", {
    topN: 3,
    budget: 10,
    rerankCandidates: 10,
    rerank: {
      emptyResultIsValid: false,
      hits: [
        { index: 1, score: 0.9 },
        { index: 1, score: 0.8 },
        { index: 0, score: 0.7 },
        { index: 9, score: 0.6 },
        { index: 1.5, score: 0.5 },
        { index: 2, score: 0.4 },
      ],
    },
  });
  return [await drive(driver, traceMod, request, rows.map(cloneMemory))];
}

async function rule5(driver, traceMod) {
  const rows = [0, 1, 2, 3].map((index) => memory({
    id: `e${index}`,
    summary: `e${index}`,
    score: 1 - index / 10,
  }));
  const cases = [
    ["empty-is-valid", { emptyResultIsValid: true, hits: [], error: null }, { topN: 2 }],
    ["empty-falls-back", { emptyResultIsValid: false, hits: [], error: null }, { topN: 2 }],
    ["timeout-falls-back", { emptyResultIsValid: false, hits: [], error: "timeout" }, { topN: 2, rerankerTimeoutMs: 5000 }],
    ["timeout-rethrows", { emptyResultIsValid: false, hits: [], error: "generic" }, { topN: 2, rerankerFallbackOnError: false, rerankerTimeoutMs: 5000 }],
  ];
  const runs = [];
  for (const [name, rerank, extra] of cases) {
    const request = baseRequest(name, { budget: 10, rerankCandidates: 10, rerank, ...extra });
    runs.push(await drive(driver, traceMod, request, rows.map(cloneMemory)));
  }
  return runs;
}

async function rule6(driver, traceMod) {
  const rows = [
    memory({ id: "own-1", summary: "alpha bravo", text: "alpha bravo", agentId: "a1", score: 0.9 }),
    memory({ id: "foreign", summary: "foreign charlie", text: "foreign charlie", agentId: "a2", score: 0.8 }),
    memory({ id: "own-2", summary: "delta echo", text: "delta echo", agentId: "a1", score: 0.7 }),
  ];
  const request = baseRequest("acl-before-rerank", {
    topN: 5,
    budget: 5,
    rerankCandidates: 10,
    rerank: {
      emptyResultIsValid: false,
      hits: [
        { index: 0, score: 0.4 },
        { index: 1, score: 0.3 },
      ],
    },
  });
  return [await drive(driver, traceMod, request, rows.map(cloneMemory))];
}

async function finalAcl(driver, traceMod) {
  const rows = [
    memory({ id: "own-1", summary: "alpha bravo", text: "alpha bravo", agentId: "a1", score: 0.9 }),
    memory({ id: "own-2", summary: "delta echo", text: "delta echo", agentId: "a1", score: 0.7 }),
  ];
  const leak = memory({
    id: "foreign-leak",
    summary: "foreign charlie",
    text: "foreign charlie",
    agentId: "a2",
    score: 0.5,
  });
  const request = baseRequest("final-acl-drops-foreign-row", {
    topN: 5,
    budget: 5,
    rerankCandidates: 10,
    rerank: {
      emptyResultIsValid: false,
      hits: [
        { index: 0, score: 0.4 },
        { index: 1, score: 0.3 },
      ],
    },
    leak: [publicRow(leak)],
  });
  return [await drive(driver, traceMod, request, rows.map(cloneMemory))];
}

async function rule7(pipeline) {
  const directory = mkdtempSync(path.join(tmpdir(), "re04-t3-knowledge-"));
  try {
    mkdirSync(path.join(directory, "memory"), { recursive: true });
    writeFileSync(
      path.join(directory, "memory", "KNOWLEDGE.md"),
      "# One\n\nSection one text that is longer than thirty characters.\n\n# Two\n\nSection two text that is longer than thirty characters.\n",
    );
    let calls = 0;
    const embeddings = {
      async embed(text) {
        calls += 1;
        if (String(text).includes("Section two")) throw new Error("section failed");
        return [0, 0];
      },
    };
    await pipeline.getKnowledgeChunks(directory, embeddings, null, {});
    const afterFirst = calls;
    const cachePath = path.join(directory, ".adaptive-learning", "knowledge-cache.json");
    let cacheAfterFirst = false;
    try {
      statSync(cachePath);
      cacheAfterFirst = true;
    } catch {
      cacheAfterFirst = false;
    }
    const beforeSecond = calls;
    await pipeline.getKnowledgeChunks(directory, embeddings, null, {});
    return {
      name: "section-failure-skips-cache-on-plugin-line",
      kind: "knowledge",
      phase1: "pin writes the cache; this golden is the plugin line and is not a Rust assertion",
      embedsFirstCall: afterFirst,
      cacheWritten: cacheAfterFirst,
      embedsSecondCall: calls - beforeSecond,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function rule8(pipeline, traceMod) {
  const trace = traceMod.createRecallDecisionTrace({
    query: "graph",
    config: { topN: 5, budget: 5, recallMinScore: 0.15, importanceBoost: 0 },
  });
  const id = "11111111-1111-4111-8111-111111111111";
  const table = {
    query() {
      return {
        where() { return this; },
        limit() { return this; },
        async toArray() { return []; },
      };
    },
  };
  const out = await pipeline.hydrateGraphResults(
    table,
    [{ entry: { id, text: "", summary: "", agentId: "a1", scope: "agent-private" }, score: 0.5, source: "graph" }],
    null,
    {
      decisionTrace: trace,
      aclCtx: aclContext("a1"),
      now: 1768305600000,
      validAt: null,
    },
  );
  return {
    name: "hydration-miss-is-traced",
    kind: "hydration",
    ids: out.map((row) => row.entry.id),
    decisions: projectDecisions(trace),
  };
}

async function dedupeRuns(driver, traceMod) {
  const same = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const other = "quartz jug pack my box with five dozen liquor bottles";
  const runs = [];
  runs.push(await drive(driver, traceMod, baseRequest("near-duplicate", {
    topN: 5,
    budget: 10,
    rerank: identityHits(3),
  }), [
    memory({ id: "dup-a", summary: same, text: same, score: 0.9 }),
    memory({ id: "dup-b", summary: same, text: same, score: 0.8 }),
    memory({ id: "fresh", summary: other, text: other, score: 0.7 }),
  ].map(cloneMemory)));
  runs.push(await drive(driver, traceMod, baseRequest("disjoint-windows-stay", {
    topN: 5,
    budget: 10,
    rerank: identityHits(2),
  }), [
    memory({ id: "win-a", summary: same, text: same, score: 0.9, validFrom: 1000, validUntil: 2000 }),
    memory({ id: "win-b", summary: same, text: same, score: 0.8, validFrom: 2000, validUntil: 3000 }),
  ].map(cloneMemory)));
  runs.push(await drive(driver, traceMod, baseRequest("group-cap", {
    topN: 5,
    budget: 10,
    rerank: identityHits(3),
  }), [
    memory({ id: "g1", summary: "one two three", text: "one two three", score: 0.9, chunkGroupId: "group", sourceTurnId: "turn-1" }),
    memory({ id: "g2", summary: "four five six", text: "four five six", score: 0.8, chunkGroupId: "group", sourceTurnId: "turn-1" }),
    memory({ id: "g3", summary: "seven eight nine", text: "seven eight nine", score: 0.7, chunkGroupId: "group", sourceTurnId: "turn-1" }),
  ].map(cloneMemory)));
  runs.push(await drive(driver, traceMod, baseRequest("whole-replaces-parts", {
    topN: 5,
    budget: 10,
    rerank: identityHits(2),
  }), [
    memory({ id: "part", summary: "250 g flour and water", text: "250 g flour and water", score: 0.9, chunkGroupId: "group", sourceTurnId: "turn-9" }),
    memory({ id: "whole", summary: "full recipe with flour water salt", text: "full recipe with flour water salt", score: 0.8, sourceTurnId: "turn-9" }),
  ].map(cloneMemory)));
  runs.push(await drive(driver, traceMod, baseRequest("defer-slices-without-jaccard", {
    topN: 5,
    budget: 1,
    deferFinalCap: true,
    candidateHardLimit: 2,
    rerank: identityHits(3),
  }), [
    memory({ id: "s0", summary: same, text: same, score: 0.9 }),
    memory({ id: "s1", summary: same, text: same, score: 0.8 }),
    memory({ id: "s2", summary: other, text: other, score: 0.7 }),
  ].map(cloneMemory)));
  return runs;
}

function identityHits(count) {
  return {
    emptyResultIsValid: false,
    hits: Array.from({ length: count }, (_, index) => ({ index, score: 1 - index / 10 })),
  };
}

async function prefilterRuns(filterMod) {
  const runs = [];
  const judged = [
    "keep relevant",
    "drop high",
    "keep low confidence",
    "keep uncertain",
    "keep over one",
    "drop exact one",
  ];
  runs.push(await prefilter(filterMod, "removes-irrelevant-at-or-above-0-95", {
    documents: judged,
    answers: {
      d0: { choice: "relevant", confidence: 0.99 },
      d1: { choice: "irrelevant", confidence: 0.95 },
      d2: { choice: "irrelevant", confidence: 0.949 },
      d3: { choice: "uncertain", confidence: 0.99 },
      d4: { choice: "irrelevant", confidence: 1.01 },
      d5: { choice: "irrelevant", confidence: 1 },
    },
  }));
  runs.push(await prefilter(filterMod, "timeout-keeps-all", {
    documents: ["a", "b", "c"],
    throwName: "TimeoutError",
  }));
  runs.push(await prefilter(filterMod, "abort-keeps-all", {
    documents: ["a", "b"],
    throwName: "AbortError",
  }));
  runs.push(await prefilter(filterMod, "http-error-keeps-all", {
    documents: ["a", "b"],
    httpStatus: 500,
  }));
  runs.push(await prefilter(filterMod, "over-100-keeps-all-unjudged", {
    documents: Array.from({ length: 150 }, (_, index) => `doc-${index}`),
    answers: { d0: { choice: "irrelevant", confidence: 1 } },
  }));
  runs.push(await prefilter(filterMod, "query-over-10000-keeps-all", {
    query: "q".repeat(10001),
    documents: ["a", "b"],
    answers: { d0: { choice: "irrelevant", confidence: 1 } },
  }));
  const long = "L".repeat(80);
  runs.push(await prefilter(filterMod, "state-limit-skips-the-overflowing-document", {
    documents: ["short", long],
    maxStateChars: 120,
    answers: {
      d0: { choice: "irrelevant", confidence: 0.99 },
      d1: { choice: "irrelevant", confidence: 0.99 },
    },
  }));
  return runs;
}

async function prefilter(filterMod, name, spec) {
  let fetchCalled = 0;
  const fetchImpl = async () => {
    fetchCalled += 1;
    if (spec.throwName) {
      const error = new Error("fixture");
      error.name = spec.throwName;
      throw error;
    }
    if (spec.httpStatus) {
      return { ok: false, status: spec.httpStatus, async json() { return {}; } };
    }
    return { ok: true, status: 200, async json() { return { answers: spec.answers ?? {} }; } };
  };
  const filter = filterMod.createJevRecallFilter({
    apiKey: "fixture",
    timeoutMs: 30,
    maxStateChars: spec.maxStateChars ?? 60000,
    fetchImpl,
  });
  if (!filter) throw new Error("filter fixture was not constructed");
  const outcome = await filter(spec.query ?? "which documents help", spec.documents);
  return {
    name,
    kind: "prefilter",
    query: spec.query ?? "which documents help",
    documents: spec.documents,
    maxStateChars: spec.maxStateChars ?? 60000,
    answers: spec.answers ?? null,
    throwName: spec.throwName ?? null,
    httpStatus: spec.httpStatus ?? null,
    result: {
      indices: outcome.indices,
      fallback: outcome.fallback ?? null,
      evaluated: outcome.evaluated ?? null,
      removed: outcome.removed ?? null,
      fetchCalled,
    },
  };
}

function resolveRuns(budget) {
  const cases = [
    ["small", { promptLength: 10 }],
    ["normal", { promptLength: 50 }],
    ["complex-capped", { promptLength: 201 }],
    ["project-signal-capped", { promptLength: 10, hasProjectSignals: true }],
    ["expanded-cap", { promptLength: 201, tokenBudgetPct: 0.31 }],
    ["boundary-49", { promptLength: 49 }],
    ["boundary-200", { promptLength: 200, hasProjectSignals: false }],
  ];
  return cases.map(([name, input]) => ({
    name,
    kind: "resolve",
    input: {
      promptLength: input.promptLength,
      hasProjectSignals: input.hasProjectSignals ?? false,
      maxPromptMemories: input.maxPromptMemories ?? 12,
      tokenBudgetPct: input.tokenBudgetPct ?? 0.3,
    },
    result: budget.resolveRecallBudget({
      promptLength: input.promptLength,
      hasProjectSignals: input.hasProjectSignals ?? false,
      maxPromptMemories: input.maxPromptMemories ?? 12,
      tokenBudgetPct: input.tokenBudgetPct ?? 0.3,
    }),
  }));
}

function scrub(value) {
  if (typeof value === "string") {
    if (value.toLowerCase().includes(forbidden)) {
      throw new Error("refusing to write a golden that contains the forbidden token");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = scrub(child);
    return out;
  }
  return value;
}

function writeJson(filePath, value) {
  const text = `${JSON.stringify(scrub(value), null, 2)}\n`;
  if (text.toLowerCase().includes(forbidden)) {
    throw new Error(`refusing to write ${path.basename(filePath)}`);
  }
  writeFileSync(filePath, text);
}

// Direct budget rows are attached inside rule1 as a placeholder. Fill them here
// once the budget module is loaded: capture() calls fillDirect after rule1.
