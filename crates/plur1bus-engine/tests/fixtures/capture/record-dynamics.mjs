// RE-05/T3 pure dynamics and deferred-queue goldens, always from verified pinned sources.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const repository = process.env.PLUR1BUS_ENGINE_GIT;
if (!source || !repository) throw new Error("PLUR1BUS_ENGINE_SRC and PLUR1BUS_ENGINE_GIT required");
if (process.version !== "v24.21.0") throw new Error("Node v24.21.0 required");
const files = ["lib/memory-dynamics.js", "lib/deferred-dynamics-queue.js", "lib/safe-logging.js",
  "lib/log-redact.js", "lib/process-singleton.js"];
const sourcesSha256 = {};
for (const file of files) {
  const pinned = execFileSync("git", ["-C", repository, "show", `${pin}:${file}`]);
  const actual = readFileSync(join(source, file));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (hash(pinned) !== hash(actual)) throw new Error(`Pinned source hash mismatch: ${file}`);
  sourcesSha256[file] = hash(actual);
}
const dynamics = await import(pathToFileURL(join(source, files[0])));
const deferred = await import(pathToFileURL(join(source, files[1])));
const rows = [
  {},
  { category: "fact", memoryStrength: 0.8, halfLifeDays: 30, createdAt: 1000 },
  { category: "project", importance: 0.7, emotionalIntensity: 0.9, createdAt: 1000 },
  { category: "person", importance: 0.94, emotionalIntensity: 0.99, halfLifeDays: 42 },
  { category: "work", importance: 0.95, emotionalIntensity: 0 },
  { category: "other", importance: 0.2, memoryStrength: 0, halfLifeDays: 0, lastDynamicsAt: 1 },
  { category: "general", memoryClass: "core", memoryStrength: 0.2, retrievalCount: 3 },
  { neverForget: true, importance: 0.1, halfLifeDays: 30 },
  { neverForget: 1, memoryStrength: 0.1 },
  { neverForget: "1", memoryClass: "CORE", importance: "0.95" },
  { category: "decision", memoryStrength: 0.83, halfLifeDays: 13.75, createdAt: 1000, retrievalCount: 4 },
  { category: "unknown", memoryClass: "dream", importance: 0.6, emotionalIntensity: 0.4 },
  { status: "", importance: null, memoryStrength: "invalid", halfLifeDays: "invalid" },
  { status: null, importance: 0.8, emotionalIntensity: 0.8, lastDynamicsAt: 0, coreMemoryReason: "fixture" },
  { memoryStrength: 0.2, halfLifeDays: 3650, createdAt: 1000, lastStrengthenedAt: 1000 },
  { category: "FACT", memoryStrength: 0.5, halfLifeDays: -1, lastDynamicsAt: 1000, lastStrengthenedAt: 0 },
  { importance: "0x1", halfLifeDays: "0b11110", memoryStrength: "0o1", createdAt: 1000 },
];
const cases = [];
const add = (name, args, value) => cases.push({ name, args: JSON.stringify(args), raw: JSON.stringify(value) });
for (const row of rows) {
  add("isLiveRow", [row], dynamics.isLiveRow(row));
  add("isManualCoreMarker", [row], dynamics.isManualCoreMarker(row));
  add("isCoreMemory", [row], dynamics.isCoreMemory(row));
  add("computeFlashbulbScore", [row], dynamics.computeFlashbulbScore(row));
  add("computeCoreMemoryScore", [row], dynamics.computeCoreMemoryScore(row));
  for (const now of [1000, 86401000, 123457789, 2592001000, -1]) {
    add("computeDecayedStrength", [row, now], dynamics.computeDecayedStrength(row, now));
    add("applyRetrievalReinforcement", [row, now], dynamics.applyRetrievalReinforcement(row, now));
    add("applyDailyDecay", [row, now], dynamics.applyDailyDecay(row, now));
  }
  for (const sessions of [1, 2, 5]) {
    add("computePromotionCandidate", [row, sessions], dynamics.computePromotionCandidate(row, sessions));
  }
  for (const opts of [{}, { flashbulbEncodingEnabled: false }, { flashbulbEncodingEnabled: true },
    { intensityHalfLifeFactor: 0 }, { intensityHalfLifeFactor: 2 }]) {
    add("applyDynamicsDefaults", [row, 123457789, {}, opts], dynamics.applyDynamicsDefaults(row, 123457789, {}, opts));
  }
  for (const floor of [90, 3650]) {
    add("applyFlashbulbEncoding", [row, 1000, 0.8, 600, floor], dynamics.applyFlashbulbEncoding(row, 1000, 0.8, 600, floor));
  }
  add("applyCoreMemoryEncoding", [row, 1000, 0.95], dynamics.applyCoreMemoryEncoding(row, 1000, 0.95));
}
for (const category of ["fact", "general", "other", "person", "work", "project", "decision", "unknown", "FACT"]) {
  for (const memoryClass of [null, "core", "dream", "standard"]) {
    for (const overrides of [{}, { transient: 11, episodic: 22, longContext: 33, project: 44, dream: 55 }]) {
      add("resolveHalfLifeDays", [category, memoryClass, overrides], dynamics.resolveHalfLifeDays(category, memoryClass, overrides));
    }
  }
}
for (const importance of [null, "invalid", 0, 0.399, 0.4, 0.699, 0.7, 0.949, 0.95, 1]) {
  for (const flashbulb of [false, true]) {
    add("resolveHalfLifeFromEncoding", [importance, flashbulb], dynamics.resolveHalfLifeFromEncoding(importance, { flashbulb }));
  }
}
for (const base of [0, -1, null, "invalid", 30, "30", 180]) {
  for (const intensity of [null, 0, 0.5, 1, 2, -1, "invalid"]) {
    for (const factor of [0, 1, 2, -1, "invalid"]) {
      add("modulateHalfLifeDays", [base, intensity, factor], dynamics.modulateHalfLifeDays(base, intensity, factor));
    }
  }
}
const deferredCases = [];
for (const params of [
  { timestamp: 1000 },
  { agentId: "fixture", workspaceKey: "workspace:v1:fixture", query: "Synthetic statement",
    resultsCount: 2, selectedIds: ["a", "b"], timestamp: 1000 },
  { query: "", queryHash: "provided", agentId: "", workspaceKey: null,
    resultsCount: 0, selectedIds: "invalid", timestamp: null },
  { query: ["synthetic", "query"], resultsCount: null, selectedIds: [null, 1], timestamp: 1000 },
]) {
  const entry = dynamics.createRetrievalLedgerEntry(params);
  entry.id = "__UUID__";
  add("createRetrievalLedgerEntry", [params], entry);
}
for (const options of [{ maxBacklog: 2, fallbackDelayMs: 100 }, { maxBacklog: 0, fallbackDelayMs: 0 },
  { maxBacklog: -1, fallbackDelayMs: 0 }, { maxBacklog: 2.5, fallbackDelayMs: 100 },
  { maxBacklog: "2", fallbackDelayMs: null }, { maxBacklog: "invalid", fallbackDelayMs: "invalid" }]) {
  const timers = new Map();
  let nextTimer = 0;
  const order = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const queue = deferred.createDeferredDynamicsQueue({ ...options, now: () => 1000,
    setTimer: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id) });
  const states = [];
  for (let index = 0; index < 4; index += 1) {
    const accepted = queue.enqueue("a", async () => {
      order.push(index);
      if (index === 0) await blocked;
    }, { entries: index });
    states.push({ accepted, stats: JSON.stringify(queue.stats()), pending: queue.pending("a"), timers: timers.size });
  }
  release();
  await queue.kick("a");
  states.push({ stats: JSON.stringify(queue.stats()), pending: queue.pending("a"), timers: timers.size });
  queue.close();
  const acceptedAfterClose = queue.enqueue("a", async () => {});
  await queue.drain();
  deferredCases.push({ options, states, order, acceptedAfterClose });
}
const directory = join(dirname(fileURLToPath(import.meta.url)), "golden");
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, "dynamics.json"), `${JSON.stringify({ provenance: { engine: "node", commit: pin,
  node: process.version, flags: ["--dynamics"], sourcesSha256, disabledOptions: [],
  scope: "all pure dynamics exports; retrieval ledger id normalized to __UUID__; deferred queue uses deterministic injected timers" },
  cases, deferredCases, deferredKey: deferred.SHARED_DYNAMICS_QUEUE_KEY }, null, 2)}\n`);
