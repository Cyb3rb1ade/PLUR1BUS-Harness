// Node reader for RE-02/T4 SQLite round trips, engine commit 9f34008c143c5da87b2194b5a28442b407ff8ba7.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Read databases through the installed engine, using private scratch layouts for its scope routing. */
export async function checkSqlite(directory) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  let engineRoot;
  try {
    engineRoot = path.dirname(createRequire(path.join(root, "packages/core/package.json")).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
  } catch {
    throw new Error("run pnpm test:prep (the engine package is not installed)");
  }
  const engineModule = async (relative) => import(pathToFileURL(path.join(engineRoot, relative)).href);
  const { createEmbeddingCache } = await engineModule("lib/embedding-cache.js");
  const { createLlmResultCache } = await engineModule("lib/llm-result-cache.js");
  const { bindHostPaths } = await engineModule("lib/host-paths.js");
  const speaker = await engineModule("lib/speaker-mapping-store.js");
  const rows = JSON.parse(readFileSync(path.join(root, "crates/plur1bus-engine/tests/fixtures/sqlite/rows.json"), "utf8"));
  const scratch = mkdtempSync(path.join(tmpdir(), "re02-sqlite-reader-"));
  let embedding;
  let llm;
  const originalNow = Date.now;
  try {
    for (const [source, target] of [["embeddings.sqlite", "embedding-cache-v2/a1.db"],
      ["llm_results.sqlite", "llm-result-cache-v1/a1.db"], ["speaker_mappings.sqlite", "cache/audio-diarization.db"]]) {
      const destination = path.join(scratch, target);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(directory, source), destination);
    }
    Date.now = () => rows.now;
    embedding = createEmbeddingCache({ persist: true, cacheBasePath: scratch, provider: "fixture", model: "fixture-embedding", dimensions: 3 });
    const embeddings = await embedding.getMany(rows.embeddings.map((row) => row.text), { scopeId: "a1" });
    llm = createLlmResultCache({ persist: true, baseDbPath: scratch, now: () => rows.now });
    const llmResults = [];
    for (const row of rows.llm) llmResults.push(await llm.getOrCompute(row.request, () => { throw new Error("Node did not find the Rust-written LLM row"); }));
    bindHostPaths({ stateDirOverride: () => scratch });
    const speakers = speaker.getSpeakerMappingsByAgent("a1").sort((a, b) => a.speakerLabel.localeCompare(b.speakerLabel));
    return { embeddings, llm: llmResults, speakers };
  } finally {
    embedding?.close();
    await llm?.close();
    speaker.resetSpeakerMappingDbForTests();
    bindHostPaths(null);
    Date.now = originalNow;
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkSqlite(process.argv[2])));
}
