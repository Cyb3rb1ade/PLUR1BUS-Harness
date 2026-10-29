// Import acceptance through the actual installed Engine and public Core recall; no vector capture is seeded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { planAndMigrateAgent } from "../../src/import/importers/openclaw-agents.ts";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const caller = { channel: "cli", accountId: "local", userId: "owner" };

test("imported memory/KNOWLEDGE.md is returned by actual Engine recall without capture", { timeout: 60_000 }, async () => {
  const source = tempDir("a2-import-recall-source-");
  mkdirSync(join(source, "memory"));
  const importedFact = "The Atlas deployment window is Tuesday after the security review.";
  writeFileSync(join(source, "memory", "KNOWLEDGE.md"), `# Atlas deployment policy\n\n${importedFact}\n`);
  const home = tempDir("a2-import-recall-home-");
  const l = layout(home);
  const { report } = await planAndMigrateAgent({ agentId: "bernd", workspace: source, workspaceSource: "fixture", agentDir: null, foundIn: [] }, source, l, new Set(), true);
  assert.ok(report.files.some(file => file.targetFile === "memory/KNOWLEDGE.md" && file.action === "created"));
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = {
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 },
  };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const core = createCore({ home, testInternals: flatTestInternals() });
  await core.start();
  const client = await connect({ address: core.address, token: core.token });
  try {
    const recalled = await client.call<{ degraded: unknown; blocks: { text: string }[] }>("memory.recall", {
      caller, agentId: "bernd", query: "Atlas deployment policy security review Tuesday",
      budget: { softMs: 15_000, hardMs: 20_000, capChars: 12_000 },
    });
    assert.equal(recalled.degraded, null);
    assert.ok(recalled.blocks.some(block => block.text.includes(importedFact)), JSON.stringify(recalled));
  } finally {
    await client.close();
    await core.stop({ budgetMs: 5000 });
  }
});
