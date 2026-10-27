/**
 * Record the installed, exactly pinned Node engine's contract outputs.
 * From the repository root, with Node 24.21 and `pnpm test:prep` complete:
 *   node crates/plur1bus-engine/tests/fixtures/contract/record.mjs
 *
 * The host clock is fixed. The pin also reads Date directly and creates IDs
 * with crypto.randomUUID/Math.random, so this recording process fixes those
 * sources before importing it. Date-only mocking leaves real timers running.
 * The engine source and returned data shapes are never patched.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDir, "../../../../..");
const require = createRequire(join(repositoryRoot, "packages/core/package.json"));
const engineRoot = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const fixedNow = Date.parse("2026-10-15T12:00:00.000Z");
const originalRandomUUID = crypto.randomUUID;
const originalRandom = Math.random;
let id = 0;
let seed = 0x52453031;
let engine;
let home;

try {
  mock.timers.enable({ apis: ["Date"], now: fixedNow });
  crypto.randomUUID = () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, "0")}`;
  syncBuiltinESMExports();
  Math.random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };

  const [{ createEngine }, { canonicalIdentityPath, ipcAddress, isUnsafeLink, securePath }] = await Promise.all([
    import(pathToFileURL(join(engineRoot, "engine/create-engine.js")).href),
    import(pathToFileURL(join(engineRoot, "lib/platform.js")).href),
  ]);
  home = await mkdtemp(join(tmpdir(), "plur1bus-contract-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  const config = {
    baseDbPath: join(home, "memory"),
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: true,
    autoRecall: true,
    neo: { enabled: false },
    gc: { enabled: false },
    obsidianBridge: { enabled: false },
    merging: { enabled: false },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    temporalContext: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
  };
  const noop = () => {};
  const host = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    stateDir: join(home, "state"),
    configPath: () => join(home, "config.json"),
    config: () => config,
    workspaceDir: async () => workspace,
    clock: () => fixedNow,
    platform: { canonicalIdentityPath, ipcAddress, isUnsafeLink, securePath },
    runtime: null,
  };
  // Same flat embedder as packages/core/src/bin.ts, at the configured width.
  const flat = (width) => () => Array.from({ length: width }, (_, i) => (i === 0 ? 1 : 0));
  const embedder = (width, query = async () => {}) => {
    const vector = flat(width);
    const one = async () => vector();
    return {
      embed: one,
      embedQuery: async () => { await query(); return vector(); },
      embedPassage: one,
      embedBatch: async (texts) => texts.map(vector),
      shutdown: async () => {},
    };
  };
  engine = createEngine(host, config, { internals: { embeddings: embedder(384), reranker: null } });
  const principal = {
    agentId: "contract-agent",
    workspace: "workspace:v1:contract",
    channel: "cli",
    accountId: "contract-account",
    chat: { id: "contract-chat", kind: "direct" },
    trust: "proved",
  };
  const agent = { origin: "user", background: false };
  const signal = AbortSignal.timeout(30_000);
  const handle = engine.capture({
    agentId: principal.agentId,
    principal,
    agent,
    messages: [
      { role: "user", content: "Please remember that I always prefer green tea over coffee in the morning." },
      { role: "assistant", content: "Noted." },
    ],
    runId: "contract-capture",
    sessionKey: "agent:contract-agent:main",
    incognito: false,
    signal,
  });
  const capture = await handle.done;
  assert.equal(capture.stored, 1, "the fixture capture must write one real memory");
  assert.equal(capture.skipped, 0);
  const recall = await engine.recall({
    query: "What do I prefer to drink in the morning?",
    principal,
    agent,
    signal,
  });
  assert.equal(recall.degraded, null);
  assert.ok(recall.blocks.some((block) => block.name === "memories" && block.text.includes("green tea")));
  assert.ok(Number.isFinite(recall.capChars));
  const job = await engine.jobs.run("gc-run", principal.agentId, { trigger: "harness", signal });
  const memories = await engine.memory.list({ since: 0 }, principal, agent);
  assert.equal(memories.items.length, 1);
  const status = await engine.status();
  const fixtures = {
    "capture-result": capture,
    "recall-result": recall,
    "job-run": job,
    "memory-card": memories.items[0],
    "engine-status": status,
  };
  await mkdir(fixtureDir, { recursive: true });
  for (const [name, value] of Object.entries(fixtures)) {
    await writeFile(join(fixtureDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  console.log(`Recorded ${Object.keys(fixtures).length} contract fixtures.`);
} finally {
  try {
    await engine?.close({ budgetMs: 5_000 });
  } finally {
    try {
      if (home) await rm(home, { recursive: true, force: true });
    } finally {
      crypto.randomUUID = originalRandomUUID;
      syncBuiltinESMExports();
      Math.random = originalRandom;
      mock.timers.reset();
    }
  }
}
