#!/usr/bin/env node
// RE-02/T4 fixtures, written by engine commit 9f34008c143c5da87b2194b5a28442b407ff8ba7.
// Run from the repository root after pnpm test:prep. Do not edit the generated databases or rows.json.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
assert.equal(process.version, "v24.21.0", "record with Node 24.21.0");
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(fixtureDir, "../../../../..");
const coreManifest = path.join(root, "packages/core/package.json");
const manifest = JSON.parse(readFileSync(coreManifest, "utf8"));
const specifier = manifest.dependencies["@cyb3rb1ade/plur1bus-memory"];
assert.ok(specifier.startsWith("git+https://") && specifier.endsWith(`#${PIN}`), "the engine must be the exact git pin");
assert.ok(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8").includes(`tar.gz/${PIN}`), "lockfile must resolve the exact engine pin");
let engineRoot;
try {
  engineRoot = path.dirname(createRequire(coreManifest).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
} catch {
  throw new Error("run pnpm test:prep (the engine package is not installed)");
}
const resolvedEngine = realpathSync(engineRoot);
const relativeEngine = path.relative(realpathSync(path.join(root, "node_modules")), resolvedEngine);
assert.ok(!path.isAbsolute(relativeEngine) && relativeEngine !== ".." && !relativeEngine.startsWith(`..${path.sep}`)
  && relativeEngine.startsWith(`.pnpm${path.sep}`), "installed engine must be inside the frozen workspace install, without a file/link override");
// A Windows checkout may convert the committed lockfile to CRLF; pnpm writes its install copy with LF.
const lockfile = (file) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
assert.equal(lockfile("node_modules/.pnpm/lock.yaml"), lockfile("pnpm-lock.yaml"),
  "installed lockfile must equal the committed frozen lockfile");
const engineModule = async (relative) => import(pathToFileURL(path.join(engineRoot, relative)).href);
const { createEmbeddingCache } = await engineModule("lib/embedding-cache.js");
const { createLlmResultCache } = await engineModule("lib/llm-result-cache.js");
const { bindHostPaths } = await engineModule("lib/host-paths.js");
const speaker = await engineModule("lib/speaker-mapping-store.js");
const ddl = {};
for (const [table, source] of [["embeddings", "embedding-cache.js"], ["llm_results", "llm-result-cache.js"], ["speaker_mappings", "speaker-mapping-store.js"]]) {
  const moduleText = readFileSync(path.join(engineRoot, "lib", source), "utf8");
  const match = moduleText.match(new RegExp("\\.exec\\(`(\\s*CREATE TABLE IF NOT EXISTS " + table + "[^]*?)`\\);"));
  assert.ok(match, `DDL must come verbatim from the ${table} module`);
  ddl[table] = match[1];
}
const scratch = mkdtempSync(path.join(tmpdir(), "re02-sqlite-"));
const now = 4_102_444_800_000;
const originalNow = Date.now;
const embeddingRows = [
  { text: "  ÄPFEL\ufeff", vector: [1, 0, 0] },
  { text: "Straße 🚀", vector: [0, 0.5, -0.25] },
];
const llmRows = [0, 1].map((index) => ({
  request: {
    scopeId: "a1", purpose: "capture-summary", endpoint: "https://fixture.invalid/v1", credential: null,
    model: "fixture-llm", messages: [{ role: "user", content: `Fixture question ${index}` }],
    maxTokens: 128, temperature: 0, jsonMode: false, disableThinking: true, headers: {},
  },
  value: { text: `Node answer ${index}`, usage: { inputTokens: 10 + index, outputTokens: 4 + index, providerCachedInputTokens: index } },
}));
const speakerRows = [0, 1].map((index) => ({
  agentId: "a1", speakerLabel: `speaker-${index}`, speakerDisplayName: `Node speaker ${index}`,
  attributionSource: "contextual_proposal", confidence: 0.75 + index * 0.125, confirmed: index,
  proposedAt: now + index, confirmedAt: index ? now + index : null, contextHint: index ? null : "Café 🚀",
}));
let embedding;
let llm;
try {
  Date.now = () => now;
  embedding = createEmbeddingCache({ persist: true, cacheBasePath: scratch, provider: "fixture", model: "fixture-embedding", dimensions: 3 });
  await embedding.getMany(embeddingRows.map((row) => row.text), { scopeId: "a1" }, async () => embeddingRows.map((row) => row.vector));
  embedding.close();
  llm = createLlmResultCache({ persist: true, baseDbPath: scratch, now: () => now, ttlMs: 300_000 });
  for (const row of llmRows) await llm.getOrCompute(row.request, async () => row.value);
  await llm.close();
  bindHostPaths({ stateDirOverride: () => scratch });
  for (const row of speakerRows) speaker.setSpeakerMapping(row);
  speaker.resetSpeakerMappingDbForTests();

  const embeddingPath = path.join(scratch, "embedding-cache-v2/a1.db");
  const llmPath = path.join(scratch, "llm-result-cache-v1/a1.db");
  const embeddingDb = new DatabaseSync(embeddingPath);
  const recordedEmbeddings = embeddingDb.prepare("SELECT key_hash, text_hash, vector FROM embeddings ORDER BY created_at, rowid").all();
  embeddingDb.close();
  const llmDb = new DatabaseSync(llmPath);
  const recordedLlm = llmDb.prepare("SELECT key_hash FROM llm_results ORDER BY created_at, rowid").all();
  llmDb.close();
  assert.equal(recordedEmbeddings.length, 2, "both embedding writes must have reached persistence");
  assert.equal(recordedLlm.length, 2, "both LLM writes must have reached persistence");
  for (const [source, target] of [
    [embeddingPath, "embeddings.sqlite"], [llmPath, "llm_results.sqlite"],
    [path.join(scratch, "cache/audio-diarization.db"), "speaker_mappings.sqlite"],
  ]) {
    assert.ok(!existsSync(`${source}-wal`) && !existsSync(`${source}-shm`), "close must checkpoint and remove WAL sidecars");
    cpSync(source, path.join(fixtureDir, target));
  }
  writeFileSync(path.join(fixtureDir, "rows.json"), `${JSON.stringify({
    engineCommit: PIN, now, ddl,
    embeddings: embeddingRows.map((row, index) => ({ ...row, keyHash: recordedEmbeddings[index].key_hash, textHash: recordedEmbeddings[index].text_hash })),
    llm: llmRows.map((row, index) => ({ ...row, keyHash: recordedLlm[index].key_hash })), speakers: speakerRows,
  }, null, 2)}\n`);
  const size = readdirSync(fixtureDir).reduce((sum, name) => sum + statSync(path.join(fixtureDir, name)).size, 0);
  console.log(`SQLite fixtures: ${size} bytes; 2 rows per table; engine ${PIN.slice(0, 8)}`);
} finally {
  Date.now = originalNow;
  embedding?.close();
  await llm?.close();
  speaker.resetSpeakerMappingDbForTests();
  bindHostPaths(null);
  rmSync(scratch, { recursive: true, force: true });
}
