// A2 consumer acceptance uses the actual installed Engine, a real Core socket and real output files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const fact = "Remember this: we decided to deploy the Atlas production service only on Tuesdays after the security review.";
const caller = { channel: "cli", accountId: "local", userId: "owner" };

test("knowledge.update proves the installed contract gap or promotes a real captured and classified fact through Core", { timeout: 60_000 }, async (t) => {
  const home = tempDir("a2-engine-acceptance-");
  const l = layout(home);
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = {
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false }, duplicateThreshold: 1.01, runtime: { recallTimeoutMs: 10_000 },
    schicht15: { enabled: true, minImportance: 0.7, maxPromotionsPerRun: 0 },
  };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const purposes: string[] = [];
  const core = createCore({ home, testInternals: flatTestInternals(), inspectHost: (host) => {
    host.runtime = { llm: { async complete(params) {
      const request = params as { purpose?: string };
      purposes.push(request.purpose ?? "");
      return { text: JSON.stringify({ importance: 0.9, intensity: 0, dominant: "neutral", emotions: {}, reason: "durable production deployment policy" }), provider: "fixture", model: "fixture", usage: {} };
    } } };
  } });
  await core.start();
  const client = await connect({ address: core.address, token: core.token });
  try {
    const status = await client.call<any>("core.status");
    assert.match(status.contract, /^1\.\d+\.\d+$/);
    const ready = Number(status.contract.split(".")[1]) >= 17;
    if (process.env.PLUR1BUS_REQUIRE_CURATED_ENGINE === "1" || process.env.PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE) {
      assert.ok(ready, `Controller-pin acceptance requires Engine contract >=1.17; got ${status.contract}`);
    }
    const run = () => client.call<any>("jobs.run", { job: "knowledge.update", args: { agentId: "bernd" } });
    if (!ready) {
      const unavailable = await run();
      assert.equal(unavailable.job, "knowledge.update");
      assert.equal(unavailable.outcome, "skipped");
      assert.equal(unavailable.reason, "engine-contract-unavailable");
      const history = await client.call<any>("jobs.history", { job: "knowledge.update" });
      assert.ok(history.runs.some((row: any) => row.runId === unavailable.runId && row.reason === "engine-contract-unavailable"));
      assert.equal(existsSync(join(l.workspaceDir("bernd"), "memory", "KNOWLEDGE.md")), false);
      assert.deepEqual(purposes, [], "missing contract never invokes the LLM");
      t.diagnostic(`Executable Controller-pin gap: installed Engine ${status.contract}; real 1.17 acceptance branch remains required.`);
      return;
    }
    const captured = await client.call<any>("memory.capture", {
      caller, agentId: "bernd", runId: randomUUID(), sessionKey: "agent:bernd:cli:direct:a2", wait: true, waitMs: 30_000,
      messages: [{ role: "user", content: fact }, { role: "assistant", content: "I will remember the deployment policy." }],
    });
    assert.ok(captured.stored > 0, `real capture did not store a fact: ${JSON.stringify(captured)}`);
    // Auto-capture deliberately keeps importance unresolved until this existing classifier runs.
    const refined = await client.call<any>("jobs.run", { job: "emotion-refine", agentId: "bernd" });
    assert.equal(refined.outcome, "completed", JSON.stringify(refined));
    assert.ok(purposes.length > 0, "the actual Engine classifier consumed the local LLM fixture");
    const pendingPath = join(l.workspaceDir("bernd"), ".adaptive-learning", "knowledge-pending.json");
    assert.ok(existsSync(pendingPath), "classified high-importance auto-capture must enter the Engine pending queue");
    const before = JSON.parse(readFileSync(pendingPath, "utf8"));
    const pending = before.pending.filter((row: any) => row.sourceAgent === "bernd" && row.importance >= 0.7);
    assert.ok(pending.length > 0, "pending contains a genuine classified capture, never a seeded substitute");
    const llmCalls = purposes.length;
    const promoted = await run();
    assert.equal(promoted.outcome, "completed", JSON.stringify(promoted));
    const knowledgePath = join(l.workspaceDir("bernd"), "memory", "KNOWLEDGE.md");
    assert.ok(existsSync(knowledgePath), "system job wrote the canonical Engine file");
    const knowledge = readFileSync(knowledgePath, "utf8");
    assert.ok(knowledge.includes(fact));
    assert.ok(pending.some((row: any) => knowledge.includes(row.memoryId)), "written evidence references a captured source ID");
    assert.equal(JSON.parse(readFileSync(pendingPath, "utf8")).pendingCount, 0);
    assert.equal(purposes.length, llmCalls, "knowledge promotion is model-free");
    await run();
    assert.equal(readFileSync(knowledgePath, "utf8"), knowledge, "repeated scheduled maintenance is idempotent");
    const recalled = await client.call<any>("memory.recall", { caller, agentId: "bernd", query: "When may the Atlas production service deploy?", budget: { softMs: 15_000, hardMs: 20_000, capChars: 12_000 } });
    assert.equal(recalled.degraded, null);
    assert.ok(recalled.blocks.some((block: any) => block.text.includes(fact)), "public recall returns the integrated deployment policy");
  } finally {
    await client.close();
    await core.stop({ budgetMs: 5000 });
  }
});
