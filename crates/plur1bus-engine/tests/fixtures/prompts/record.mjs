// Record real prompt calls from the frozen engine with an offline provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const source = process.env.PLUR1BUS_ENGINE_SRC;
const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(source && repo && process.version === "v24.21.0", "pinned engine source, Git object store and Node 24.21.0 required");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verified = new Set();
function verify(path) {
  if (verified.has(path)) return;
  verified.add(path);
  const bytes = readFileSync(join(source, path));
  const original = execFileSync("git", ["-C", repo, "show", `${pin}:${path}`]);
  assert(bytes.equals(original), `source mismatch: ${path}`);
  for (const match of bytes.toString("utf8").matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+\.[cm]?js)["']/g)) {
    verify(posix.normalize(posix.join(dirname(path), match[1])));
  }
}

async function load(path) {
  verify(path);
  return import(pathToFileURL(join(source, path)));
}

const light = await load("lib/dreaming/light-dream.js");
const rem = await load("lib/dreaming/rem-dream.js");
const skills = await load("lib/jobs/skill-miner/llm-extractor.js");
const benefit = await load("lib/jobs/skill-miner/benefit-backfill.js");
const { createLlmResultCache } = await load("lib/llm-result-cache.js");
const sourceFiles = {
  "conversation-insights": "lib/dreaming/light-dream.js",
  "rem-pattern-analysis": "lib/dreaming/rem-dream.js",
  "skill-extraction": "lib/jobs/skill-miner/llm-extractor.js",
  "skill-benefit": "lib/jobs/skill-miner/benefit-backfill.js",
};
const volatile = "Synthetic evidence from a fixed fixture.";
const renders = {
  "conversation-insights": (text, callLlm) => light.extractKeyInsights([{ role: "user", content: text }], {}, callLlm),
  "rem-pattern-analysis": (text, callLlm) => rem.summarizeClusterWithLlm([{ text }], {}, callLlm),
  "skill-extraction": (text, callLlm) => skills.extractSkillFromEvidence({ memories: [{ text }] }, { llmCfg: {}, callLlm }),
};

async function record() {
  const records = {};
  for (const [name, call] of Object.entries(renders)) {
    const observed = [];
    for (const text of ["", volatile]) {
      await call(text, async (messages, cfg) => {
        observed.push({ content: messages[0].content, maxTokens: cfg.maxTokens, temperature: cfg.temperature });
        return "{}";
      });
    }
    assert.equal(observed.length, 2, name);
    records[name] = {
      source: sourceFiles[name], sourceSha256: sha(readFileSync(join(source, sourceFiles[name]))),
      emptySha256: sha(observed[0].content), populatedSha256: sha(observed[1].content),
      pinnedMaxTokens: observed[0].maxTokens, temperature: observed[0].temperature,
    };
  }
  // The proposal writer is outside this prompt fixture. The same pinned renderer is directly exported.
  records["skill-benefit"] = {
    source: sourceFiles["skill-benefit"], sourceSha256: sha(readFileSync(join(source, sourceFiles["skill-benefit"]))),
    emptySha256: sha(benefit.buildBenefitPrompt({})),
    populatedSha256: sha(benefit.buildBenefitPrompt({ description: volatile })),
  };
  const directory = mkdtempSync(join(tmpdir(), "ry-a-llm-cache-"));
  const cache = createLlmResultCache({ persist: true, baseDbPath: directory, now: () => 1_768_392_000_000 });
  const request = {
    scopeId: "fixture", purpose: "conversation-insights", endpoint: "https://fixture.invalid/v1",
    credential: "", model: "fixture-model",
    messages: [{ role: "user", content: "x😀".slice(0, 2) }],
    maxTokens: 600, jsonMode: false, disableThinking: false, headers: {},
  };
  let cacheKey;
  try {
    await cache.getOrCompute(request, async () => ({ text: "Recorded offline" }));
    await cache.close();
    const db = new DatabaseSync(join(directory, "llm-result-cache-v1", "fixture.db"), { readOnly: true });
    try { cacheKey = db.prepare("SELECT key_hash FROM llm_results").get().key_hash; }
    finally { db.close(); }
  } finally {
    await cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return { pin, node: process.version, volatile, records, cache: { request, cacheKey } };
}

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network access during prompt recording"); };
try {
  const first = await record();
  assert.deepEqual(first, await record());
  const { cache, ...prompts } = first;
  const output = JSON.stringify(prompts, null, 2) + "\n";
  const cacheOutput = JSON.stringify({ pin, node: process.version, ...cache }, null, 2) + "\n";
  writeFileSync(new URL("./cache-key.json", import.meta.url), cacheOutput);
  console.log(`Recorded the pinned SQLite cache key. SHA-256 ${sha(cacheOutput)}`);
  writeFileSync(new URL("./hashes.json", import.meta.url), output);
  console.log(`Recorded ${Object.keys(first.records).length} prompts twice. SHA-256 ${sha(output)}`);
} finally {
  globalThis.fetch = previousFetch;
}
