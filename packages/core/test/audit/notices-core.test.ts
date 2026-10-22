import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { connect } from "../helpers/connect.ts";

test("Core startup observes pending and overflow from another writer through the real owner inbox", async () => {
  const home = tempDir("audit-notices-core-"), l = layout(home);
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(l.configPath, JSON.stringify(cfg)); mkdirSync(l.logs, { recursive: true });
  writeFileSync(join(l.logs, "audit-chain.pending.jsonl"), JSON.stringify({ pendingDropped: 3 }) + "\n" + JSON.stringify({ at: 1, action: "audit.config.set", detail: { secret: "must-not-escape" } }) + "\n");
  const core = createCore({ home, testInternals: flatTestInternals() }); await core.start();
  const client = await connect({ address: core.address, token: core.token });
  try {
    const list = await client.call<any>("inbox.list", {});
    const notices = list.entries.filter((e: any) => e.titleKey === "inbox.audit.warning");
    assert.equal(notices.length, 2);
    assert.deepEqual(notices.map((e: any) => e.params.code).sort(), ["pending", "pending-overflow"]);
    assert.doesNotMatch(JSON.stringify(notices), /must-not-escape/);
  } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
});

test("Core catches up a large historic audit log without waiting thirty seconds per MiB", async () => {
  const home = tempDir("audit-notice-backlog-"), l = layout(home), cfg = defaults();
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(l.configPath, JSON.stringify(cfg)); mkdirSync(l.logs, { recursive: true });
  const file = join(l.logs, "audit.log"); writeFileSync(file, ""); truncateSync(file, 121 * 1024 * 1024);
  appendFileSync(file, "\n" + JSON.stringify({ at: Date.now(), action: "audit.chain.pending_drained", detail: { count: 2, dropped: 3 } }) + "\n");
  const core = createCore({ home, testInternals: flatTestInternals() }); await core.start();
  const client = await connect({ address: core.address, token: core.token });
  try {
    const deadline = Date.now() + 5000; let codes: string[] = [];
    while (Date.now() < deadline) {
      const list = await client.call<any>("inbox.list", {}); codes = list.entries.map((e: any) => e.params.code);
      if (codes.includes("pending") && codes.includes("pending-overflow")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(codes.includes("pending"), "recent transient event must not expire behind old log bytes");
    assert.ok(codes.includes("pending-overflow"));
  } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
});
