import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { createAuditChain, ANCHOR_NAME } from "../../src/audit/chain.ts";
import { createLogger } from "../../src/logger.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

it("reports crash disagreement at core startup without logging record content or repairing the anchor", async () => {
  const home = tempDir("audit-startup-"); const l = layout(home);
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const chain = createAuditChain({ dir: l.logs });
  const record = { at: 1, actor: { user: "u", host: "h" }, action: "test", target: "CRASH_RECORD_CANARY", detail: {} };
  chain.append(record);
  const anchor = readFileSync(path.join(l.logs, ANCHOR_NAME), "utf8");
  chain.append({ ...record, at: 2 });
  writeFileSync(path.join(l.logs, ANCHOR_NAME), anchor);
  const file = path.join(home, "startup.log");
  const logger = createLogger({ file, role: "core", level: "debug" });
  const core = createCore({ home, logger, testInternals: flatTestInternals() });
  try {
    await core.start();
    const text = readFileSync(file, "utf8");
    assert.match(text, /anchor-behind/);
    assert.equal(text.includes("CRASH_RECORD_CANARY"), false);
    assert.equal(readFileSync(path.join(l.logs, ANCHOR_NAME), "utf8"), anchor);
  } finally { await core.stop({ budgetMs: 5000 }); await logger.close(); }
});
