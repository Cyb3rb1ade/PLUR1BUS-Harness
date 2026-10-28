import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";

test("Core serves normally when the selected Rust engine is unavailable", async () => {
  const home = tempDir("rust-engine-core-");
  const cfg = defaults(); cfg.agents.alpha = {};
  cfg.engine = { implementation: "rust", neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  const core = createCore({ home, testInternals: flatTestInternals() });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const status = await client.call<any>("core.status");
    assert.equal(status.engine.ready, false);
    await assert.rejects(client.call("memory.recall", { agentId: "alpha", query: "hello", caller: { channel: "cli", accountId: "local", userId: "owner" } }),
      (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-unavailable");
    assert.ok(await client.call("agent.list"));
  } finally { await client?.close(); await core.stop(); }
});
