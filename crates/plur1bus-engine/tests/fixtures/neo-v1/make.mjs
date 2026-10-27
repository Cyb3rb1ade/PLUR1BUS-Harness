#!/usr/bin/env node
// RE-02/T5 fixture, written by engine commit 9f34008c143c5da87b2194b5a28442b407ff8ba7.
// Run from the repository root after pnpm test:prep. Generated files must not be edited by hand.
// The pin persists the generation in vector-index.json.file; it does not write generation.json.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
assert.equal(process.version, "v24.21.0", "record with Node 24.21.0");
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(fixtureDir, "../../../../..");
const coreManifest = path.join(root, "packages/core/package.json");
const specifier = JSON.parse(readFileSync(coreManifest, "utf8")).dependencies["@cyb3rb1ade/plur1bus-memory"];
assert.ok(specifier.startsWith("git+https://") && specifier.endsWith(`#${PIN}`), "the engine must be the exact git pin");
assert.ok(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8").includes(`tar.gz/${PIN}`), "lockfile must resolve the exact engine pin");
let engineRoot;
try {
  engineRoot = path.dirname(createRequire(coreManifest).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
} catch {
  throw new Error("run pnpm test:prep (the engine package is not installed)");
}
const relativeEngine = path.relative(realpathSync(path.join(root, "node_modules")), realpathSync(engineRoot));
assert.ok(!path.isAbsolute(relativeEngine) && relativeEngine !== ".." && !relativeEngine.startsWith(`..${path.sep}`)
  && relativeEngine.startsWith(`.pnpm${path.sep}`), "installed engine must be inside the frozen workspace install, without a file/link override");
assert.equal(readFileSync(path.join(root, "node_modules/.pnpm/lock.yaml"), "utf8"),
  readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), "installed lockfile must equal the committed frozen lockfile");
const engineModule = async (relative) => import(pathToFileURL(path.join(engineRoot, relative)).href);
const neo = await engineModule("lib/neo-arch.js");
const { appendConflictLog } = await engineModule("engine/commands/command-helpers.js");
const { appendDestructiveOpLog } = await engineModule("lib/sql-safety.js");
const { runConflictResolver } = await engineModule("lib/jobs/conflict-resolver.js");
const outcome = await engineModule("lib/reply-outcome-tracking.js");
const scratch = mkdtempSync(path.join(tmpdir(), "re02-neo-"));
const NOW = 1_800_000_000_000;
const RealDate = Date;
const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, -1]];

try {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  };
  const store = neo.createNeoStore(scratch, "fixture");
  const contents = ["Der erste feste Turn.", "Die zweite deterministische Nachricht.", "Ein dritter Turn mit Café.", `immer ${"x".repeat(3993)}🚀`];
  const turns = contents.map((content, index) => ({
    ...neo.createTurnEvent({ id: `node-turn-${index}`, workspaceKey: "fixture", agentId: "a1", sessionId: "s1", turnIndex: index,
      role: "user", content, createdAt: new RealDate(NOW + index).toISOString() }),
    ...(index < vectors.length ? { embedding: vectors[index] } : {}),
  }));
  store.appendTurns(turns);
  const candidates = neo.memoryCandidatesFromTurns(turns);
  store.appendCandidates(candidates);
  const reactions = neo.reactionSignalsFromTurns(turns);
  store.appendReactions(reactions);
  store.appendBehaviorCards(neo.behaviorCardsFromReactions(reactions));
  const report = neo.migrateInlineVectorsToSidecar(store.paths.workspaceDir);
  assert.equal(report.vectorsWritten, 3);
  assert.equal(report.mismatches, 0);
  store.appendRetrievalLedger({ agentId: "a1", workspaceKey: "fixture", query: "fester Turn", resultsCount: 1, selectedIds: ["node-turn-0"] });
  store.appendReconsolidationEvents({ idempotencyKey: "fixture-update", oldMemoryId: "node-turn-0", newMemoryId: "node-turn-0",
    action: "metadata_update", updateSource: "fixture", updateEvidence: "confirmed", confidence: 0.75, semanticDrift: 0, createdAt: NOW });
  store.writeRunState({ completed: { fixture: { completedAt: new RealDate(NOW).toISOString() } } });
  store.recordHook("fixture", { lastTurn: "node-turn-3" });

  const conflict = { timestamp: new RealDate(NOW - 2 * 86400000).toISOString(), topic: "fixture", newMemoryId: "new-memory",
    existingMemoryId: "old-memory", newText: "neue Aussage", existingText: "alte Aussage", pending: true };
  appendConflictLog(scratch, conflict);
  assert.equal(appendDestructiveOpLog(scratch, { operation: "memory.forget", agentId: "a1", id: "old-memory", timestamp: NOW }), true);
  await runConflictResolver({ workspaceDir: scratch, agentId: "a1", minAgeDays: 1, dryRun: false, llmCfg: {},
    callLlm: async () => JSON.stringify({ resolution: "keep_a", confidence: 0.95, reason: "recorded fixture decision" }) });
  outcome.recordPendingReplyOutcome(scratch, { id: "outcome-fixture", agentId: "a1", sessionKey: "s1", workspaceKey: "fixture",
    userPrompt: "Welche Nachricht war fest?", assistantText: "Der erste Turn.", memoryIds: ["node-turn-0"], now: NOW });
  await outcome.completePendingReplyOutcomes(scratch, { agentId: "a1", sessionKey: "s1", replyText: "Ja, genau richtig.", now: NOW + 1 });

  const files = readdirSync(store.paths.workspaceDir).filter((name) => name.endsWith(".json") || name.endsWith(".jsonl") || /^vectors\.\d+\.f32$/.test(name));
  assert.ok(!files.includes("generation.json"), "the pin does not create a separate generation file");
  for (const name of files) cpSync(path.join(store.paths.workspaceDir, name), path.join(fixtureDir, name));
  for (const name of ["conflict-log.jsonl", "conflict-resolved.jsonl", "destructive-ops.jsonl", "reply-outcomes.jsonl"]) {
    cpSync(path.join(scratch, ".adaptive-learning", name), path.join(fixtureDir, name));
  }
  const journal = readFileSync(path.join(fixtureDir, "turn-journal.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(journal.length, 4);
  assert.ok(!Object.hasOwn(JSON.parse(journal[3]), "statement"), "turn records use content, without an invented statement field");
  assert.ok(readFileSync(path.join(fixtureDir, "memory-candidates.jsonl"), "utf8").includes("\\ud83d"), "normalizedStatement must preserve the real UTF-16 cut");
  writeFileSync(path.join(fixtureDir, "expected.json"), `${JSON.stringify({ engineCommit: PIN,
    vectors: vectors.map((vector, index) => ({ id: `node-turn-${index}`, vector })), generationFile: "vector-index.json", turnCount: 4,
    loneSurrogateFile: "memory-candidates.jsonl", loneSurrogateField: "normalizedStatement" }, null, 2)}\n`);
  const size = readdirSync(fixtureDir).reduce((sum, name) => sum + statSync(path.join(fixtureDir, name)).size, 0);
  console.error(`neo-v1: ${size} bytes (generation in vector-index.json.file, no generation.json)`);
  if (process.argv.includes("--dump")) {
    const dump = Object.fromEntries(readdirSync(fixtureDir).filter((name) => /\.(json|jsonl)$/.test(name)).sort()
      .map((name) => [name, readFileSync(path.join(fixtureDir, name), "utf8")]));
    process.stdout.write(`${JSON.stringify(dump)}\n`);
  }
} finally {
  globalThis.Date = RealDate;
  rmSync(scratch, { recursive: true, force: true });
}
