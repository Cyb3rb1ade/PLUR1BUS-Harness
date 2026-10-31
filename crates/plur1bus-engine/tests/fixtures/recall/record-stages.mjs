// RE-04/T2 stage recorder. Loaded by record.mjs --stages.
// Runs the pinned Node pipeline twice per scenario and writes a golden only
// when the ordered ids, rounded scores, canonical headings and rejection
// entries agree. Wall-clock trace fields are not part of the snapshot.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const PIPELINE_SHA256 = "ade8fb665973fb71fedf076a0d4394da4f12f4e73ea5d76bd146f80e01360b6f";
const DIM = 384;
const NOW = Date.UTC(2026, 0, 13, 12);
const DAY_MS = 86_400_000;
const USER = `user:v1:${"a".repeat(64)}`;
const WORKSPACE = `workspace:v1:${"b".repeat(64)}`;

const here = path.dirname(new URL(import.meta.url).pathname);
const scenarioDir = path.join(here, "scenarios");
const goldenDir = path.join(here, "golden", "stages");
const storeV1 = path.resolve(here, "../store-v1");

function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest();
}

// Counter-mode expansion of sha256(utf-8 text). The first four bytes of each
// block become a uint32 mapped onto (-1, 1), then the vector is L2-normalised.
// The Rust HashEmbedder in src/recall/hash_embed.rs copies this byte for byte.
export function hashUnit(text) {
  const seed = sha256(Buffer.from(String(text), "utf8"));
  const values = new Array(DIM);
  let produced = 0;
  let counter = 0;
  while (produced < DIM) {
    const block = Buffer.concat([
      seed,
      Buffer.from([(counter >> 8) & 0xff, counter & 0xff]),
    ]);
    const digest = sha256(block);
    for (let offset = 0; offset + 4 <= digest.length && produced < DIM; offset += 4) {
      const unit = digest.readUInt32BE(offset);
      values[produced] = ((unit + 0.5) / 4294967296) * 2 - 1;
      produced += 1;
    }
    counter += 1;
  }
  return normalise(values);
}

function normalise(values) {
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return values.slice();
  return values.map((value) => value / norm);
}

function materialiseVector(spec, query) {
  if (spec.op === "hash") return hashUnit(spec.text);
  if (spec.op === "mix") {
    const left = materialiseVector(spec.left, query);
    const right = materialiseVector(spec.right, query);
    return normalise(left.map((value, index) => value + spec.scale * right[index]));
  }
  if (spec.op === "basis") {
    const values = new Array(DIM).fill(0);
    values[spec.index] = 1;
    return values;
  }
  if (spec.op === "flat") {
    const values = new Array(DIM).fill(0);
    values[0] = 1;
    return values;
  }
  throw new Error(`unknown vector op ${spec.op}`);
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function snapshot(result, cacheChunks) {
  return {
    orderedIds: result.memories.map((row) => row.entry.id),
    scores: result.memories.map((row) => round6(row.score)),
    canonical: (result.canonical ?? []).map((hit) => ({
      heading: hit.heading,
      score: round6(hit.score),
    })),
    rejections: (result.trace?.decisions ?? [])
      .filter((decision) => decision.action === "rejection")
      .map((decision) => ({
        memoryId: decision.memoryId ?? "",
        stage: decision.stage,
        reason: decision.reason,
      })),
    cacheChunks,
  };
}

function cacheChunkCount(workspaceDir) {
  if (!workspaceDir) return null;
  const file = path.join(workspaceDir, ".adaptive-learning", "knowledge-cache.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed.chunks) ? parsed.chunks.length : null;
  } catch {
    return null;
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function recordStages(engineRoot) {
  if (!process.version.startsWith("v24.21.")) {
    throw new Error(`expected Node 24.21.x, got ${process.version}`);
  }
  const pipelinePath = path.join(engineRoot, "lib/recall-pipeline.js");
  const digest = sha256(readFileSync(pipelinePath)).toString("hex");
  if (digest !== PIPELINE_SHA256) {
    throw new Error(`recall pipeline hash ${digest} is not pin ${PIN}`);
  }
  const pipeline = await import(pathToFileURL(pipelinePath).href);
  const { runRecallPipeline, parseKnowledgeMd } = pipeline;
  const { MemoryDB } = await import(pathToFileURL(path.join(engineRoot, "engine/store/memory-db.js")).href);
  mkdirSync(scenarioDir, { recursive: true });
  mkdirSync(goldenDir, { recursive: true });

  const root = mkdtempSync(path.join(tmpdir(), "re04-t2-record-"));
  try {
    const scenarios = buildScenarios();
    for (const scenario of scenarios) {
      if (scenario.knowledge) {
        // parseKnowledgeMd appends a newline per line, so the embedded text is
        // not the file bytes. The query has to be that embedded text or the
        // cosine is ~0 and the section never clears canonicalMinScore.
        const embedded = parseKnowledgeMd(scenario.knowledge.markdown)[0].text;
        scenario.query = embedded;
        scenario.queryVector = { op: "hash", text: embedded };
        for (const row of scenario.rows) row.vector = { op: "hash", text: embedded };
      }
      const first = await runPair(scenario, root, runRecallPipeline, MemoryDB);
      const second = await runPair(scenario, root, runRecallPipeline, MemoryDB);
      if (!same(first, second)) {
        throw new Error(
          `scenario ${scenario.name} is not deterministic\n${JSON.stringify(first)}\n${JSON.stringify(second)}`,
        );
      }
      assertBands(scenario);
      writeFileSync(
        path.join(scenarioDir, `${scenario.name}.json`),
        `${JSON.stringify(scenario, null, 2)}\n`,
      );
      writeFileSync(
        path.join(goldenDir, `${scenario.name}.json`),
        `${JSON.stringify({
          schema: "recall-stages/1",
          scenario: scenario.name,
          recordedFrom: {
            engine: "node",
            commit: PIN,
            pipelineSha256: PIPELINE_SHA256,
            node: process.version,
            now: NOW,
          },
          runs: first,
        }, null, 2)}\n`,
      );
      console.log(`${scenario.name}: ${first.map((run) => run.orderedIds.join(",")).join(" | ")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertBands(scenario) {
  if (!scenario.vectorCheck) return;
  const query = materialiseVector(scenario.queryVector, scenario.query);
  for (const check of scenario.vectorCheck) {
    const vector = materialiseVector(check.vector, scenario.query);
    const score = cosine(query, vector);
    if (check.min != null && score < check.min) {
      throw new Error(`${scenario.name} cosine ${score} < ${check.min}`);
    }
    if (check.max != null && score >= check.max) {
      throw new Error(`${scenario.name} cosine ${score} >= ${check.max}`);
    }
  }
}

function buildScenarios() {
  const query = "durable archive policy number forty two for the fixture recall";
  const keepText = "neighbour kept by the associative spread of the fixture recall";
  const dropText = "orthogonal graph endpoint excluded after hydration";
  const sectionText = [
    "# Durable archive policy",
    "",
    "The durable archive policy number forty two is the canonical fixture section.",
    "",
  ].join("\n");
  const agent = {
    agentId: "a1",
    storedBy: "a1",
    scope: "agent-private",
    ownerUserId: "",
    workspaceId: "",
    workspaceKey: "",
    status: "active",
    epistemicStatus: "observed",
    memoryStrength: 1,
    importance: 0.5,
    validFrom: 0,
    validUntil: 0,
    createdAt: NOW - DAY_MS,
  };
  const row = (n, text, extra = {}) => ({
    id: id(n),
    text,
    vector: { op: "hash", text },
    ...agent,
    ...extra,
  });
  const privateCtx = {
    agentId: "a1",
    workspaceId: "",
    workspaceIdentity: "",
    userPrincipal: "",
  };
  const fixtureCtx = {
    agentId: "a1",
    workspaceId: WORKSPACE,
    workspaceIdentity: WORKSPACE,
    userPrincipal: USER,
  };
  const base = {
    now: NOW,
    validAt: null,
    recallMinScore: 0.15,
    topN: 12,
    candidateTopK: 40,
    candidateHardLimit: 100,
    canonicalMinScore: 0.3,
    canonicalMaxItems: 5,
    deferFinalCap: true,
    associativeEnabled: false,
    edges: [],
    knowledge: null,
    queryVector: { op: "hash", text: query },
    vectorCheck: null,
  };
  return [
    {
      ...base,
      name: "plain",
      query: "project fixture item",
      store: "store-v1",
      queryVector: { op: "flat" },
      context: fixtureCtx,
      rows: [],
    },
    {
      ...base,
      name: "temporal-last-week",
      query: "what happened last week",
      queryVector: { op: "hash", text: "what happened last week" },
      context: privateCtx,
      rows: [
        row(1, "recent fixture fact inside the last week window", {
          createdAt: NOW - DAY_MS,
          memoryStrength: 1.2,
          vector: { op: "hash", text: "what happened last week" },
        }),
        row(2, "older fixture fact outside the last week window", {
          createdAt: NOW - 30 * DAY_MS,
          memoryStrength: 1.5,
          vector: { op: "hash", text: "what happened last week" },
        }),
        row(3, "second recent fixture fact inside the last week window", {
          createdAt: NOW - 2 * DAY_MS,
          memoryStrength: 0.8,
          vector: { op: "hash", text: "what happened last week" },
        }),
      ],
    },
    {
      ...base,
      name: "knowledge-section-hit",
      query: sectionText,
      queryVector: { op: "hash", text: sectionText },
      context: privateCtx,
      knowledge: { markdown: sectionText, failEmbeds: 0 },
      rows: [row(4, sectionText, { vector: { op: "hash", text: sectionText } })],
    },
    {
      ...base,
      name: "knowledge-section-failed-not-cached",
      query: sectionText,
      queryVector: { op: "hash", text: sectionText },
      context: privateCtx,
      knowledge: { markdown: sectionText, failEmbeds: 1 },
      rows: [row(5, sectionText, { vector: { op: "hash", text: sectionText } })],
    },
    {
      ...base,
      name: "graph-spread-adds-neighbours",
      query,
      context: privateCtx,
      topN: 1,
      candidateTopK: 1,
      associativeEnabled: true,
      rows: [
        row(6, query, { vector: { op: "hash", text: query } }),
        row(7, keepText, {
          vector: {
            op: "mix",
            scale: 0.5,
            left: { op: "hash", text: query },
            right: { op: "hash", text: keepText },
          },
        }),
      ],
      edges: [{ source: id(6), target: id(7), strength: 0.9, directed: false, type: "related" }],
      vectorCheck: [
        { vector: { op: "hash", text: query }, min: 0.99 },
        {
          vector: {
            op: "mix",
            scale: 0.5,
            left: { op: "hash", text: query },
            right: { op: "hash", text: keepText },
          },
          min: 0.25,
          max: 0.99,
        },
      ],
    },
    {
      ...base,
      name: "graph-only-hit-excluded",
      query,
      context: privateCtx,
      topN: 1,
      candidateTopK: 1,
      associativeEnabled: true,
      rows: [
        row(8, query, { vector: { op: "hash", text: query } }),
        row(9, dropText, { vector: { op: "basis", index: 0 } }),
      ],
      edges: [{ source: id(8), target: id(9), strength: 0.9, directed: false, type: "related" }],
      vectorCheck: [{ vector: { op: "basis", index: 0 }, max: 0.25 }],
    },
    {
      ...base,
      name: "archived-rows-never-return",
      query,
      context: privateCtx,
      rows: [
        row(10, query, { vector: { op: "hash", text: query }, memoryStrength: 1.1 }),
        row(11, "archived fixture fact that must not return", {
          vector: { op: "hash", text: query },
          status: "archived",
          memoryStrength: 1.4,
        }),
      ],
    },
    {
      ...base,
      name: "epistemic-untrusted-rows-ineligible",
      query,
      context: privateCtx,
      rows: [
        row(12, "observed fixture claim", {
          vector: { op: "hash", text: query },
          epistemicStatus: "observed",
          memoryStrength: 1,
        }),
        row(13, "explicit untrusted fixture claim", {
          vector: { op: "hash", text: query },
          epistemicStatus: "untrusted",
          memoryStrength: 1,
        }),
        row(14, "invalidated fixture claim", {
          vector: { op: "hash", text: query },
          epistemicStatus: "invalidated",
          memoryStrength: 1.3,
        }),
      ],
    },
    {
      ...base,
      name: "valid-time-window",
      query: "which fact is valid at the frozen instant",
      queryVector: { op: "hash", text: "which fact is valid at the frozen instant" },
      validAt: NOW,
      context: privateCtx,
      rows: [
        row(15, "open validity fixture fact", {
          vector: { op: "hash", text: "which fact is valid at the frozen instant" },
          validFrom: 0,
          validUntil: 0,
          memoryStrength: 1,
        }),
        row(16, "current validity fixture fact", {
          vector: { op: "hash", text: "which fact is valid at the frozen instant" },
          validFrom: NOW - 1000,
          validUntil: NOW + 1000,
          memoryStrength: 1.2,
        }),
        row(17, "future validity fixture fact", {
          vector: { op: "hash", text: "which fact is valid at the frozen instant" },
          validFrom: NOW + 5000,
          validUntil: NOW + 9000,
          memoryStrength: 1.4,
        }),
      ],
    },
  ];
}

async function runPair(scenario, root, runRecallPipeline, MemoryDB) {
  const runs = [];
  const passes = scenario.knowledge?.failEmbeds > 0 ? 2 : 1;
  // parseTemporal(query) ignores the pipeline's `now` and calls Date.now().
  // Freeze it so "last week" is the recorded instant, not the wall clock.
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
  const workspace = path.join(root, `${scenario.name}-ws`);
  mkdirSync(path.join(workspace, "memory"), { recursive: true });
  if (scenario.knowledge) {
    writeFileSync(path.join(workspace, "memory", "KNOWLEDGE.md"), scenario.knowledge.markdown);
  }
  const directory = scenario.store === "store-v1"
    ? storeV1
    : await writeStore(scenario, path.join(root, scenario.name), MemoryDB);
  const db = new MemoryDB(directory, DIM, null, { readOnly: true });
  await db.init();
  try {
    let remainingFailures = scenario.knowledge?.failEmbeds ?? 0;
    for (let pass = 0; pass < passes; pass += 1) {
      const embeddings = {
        embedQuery: async (text) => materialiseVector(scenario.queryVector, text),
        embed: async (text) => {
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new Error("section embed failed once");
          }
          return materialiseVector({ op: "hash", text }, text);
        },
      };
      const result = await runRecallPipeline({
        query: scenario.query,
        dbTable: db.table,
        embeddings,
        workspaceDir: scenario.knowledge ? workspace : null,
        topN: scenario.topN,
        candidateTopK: scenario.candidateTopK,
        candidateHardLimit: scenario.candidateHardLimit,
        recallMinScore: scenario.recallMinScore,
        canonicalMinScore: scenario.canonicalMinScore,
        canonicalMaxItems: scenario.canonicalMaxItems,
        canonicalEnabled: Boolean(scenario.knowledge),
        associativeEnabled: scenario.associativeEnabled,
        graphEdges: scenario.edges,
        deferFinalCap: true,
        decisionTrace: true,
        now: scenario.now,
        validAt: scenario.validAt,
        memoryCtx: scenario.context,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        reranker: null,
        readOnly: false,
      });
      runs.push(snapshot(result, cacheChunkCount(scenario.knowledge ? workspace : null)));
    }
  } finally {
    await db.shutdown();
  }
  return runs;
  } finally {
    Date.now = originalNow;
  }
}

async function writeStore(scenario, directory, MemoryDB) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const db = new MemoryDB(directory, DIM);
  await db.init();
  try {
    for (const row of scenario.rows) {
      const vector = materialiseVector(row.vector, scenario.query);
      await db.store({ ...row, vector, importance: row.importance ?? 0.5, category: "general" });
    }
  } finally {
    await db.shutdown();
  }
  writeFileSync(path.join(directory, "_schema.json"), `${JSON.stringify({
    schemaVersion: "1",
    writtenAt: "2026-01-13T12:00:00.000Z",
    engineVersion: "fixture-9f34008c",
  }, null, 2)}\n`);
  return directory;
}
