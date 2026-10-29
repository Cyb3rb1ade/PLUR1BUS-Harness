import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults, validate } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { selectEngine } from "../../src/engine/select.ts";
import { EngineClient } from "../../src/engine/client.ts";
import { createHarnessHost } from "../../src/host.ts";
import type { HarnessLogger } from "../../src/logger.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { lifecycleEngine } from "../../src/agents/admission.ts";
import { AgentLifecycle } from "../../src/agents/lifecycle.ts";
import { join } from "node:path";

const logger: HarnessLogger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger, setLevel() {}, setRotation() {}, close: async () => {} };

describe("engine implementation configuration", () => {
  it("defaults to node and validates the explicit implementation", () => {
    assert.equal(defaults().engine.implementation, "node");
    for (const implementation of ["node", "rust"] as const) {
      const cfg = defaults(); cfg.engine.implementation = implementation;
      assert.equal(validate(cfg).ok, true);
    }
    const cfg = defaults();
    assert.equal(validate({ ...cfg, engine: { ...cfg.engine, implementation: "other" } }).ok, false);
  });

  it("keeps the harness implementation selector out of EngineConfig", () => {
    const cfg = defaults(); cfg.engine.implementation = "rust";
    assert.equal(Object.hasOwn(buildEngineConfig(cfg, layout("/tmp/harness-engine")), "implementation"), false);
  });

  it("selects the existing Node engine and the RPC client through the configuration", async () => {
    const cfg = defaults();
    const l = layout(tempDir("engine-select-"));
    const engineConfig = buildEngineConfig(cfg, l);
    const host = createHarnessHost({ layout: l, config: cfg, engineConfig,
      logger,
      agents: { list: () => [], has: () => false, workspaceOf: () => undefined, scaffold() {} }, events() {} });
    const node = selectEngine(cfg, host, engineConfig);
    assert.equal(node instanceof EngineClient, false);
    assert.equal(typeof node.recall, "function");
    await node.close();
    cfg.engine.implementation = "rust";
    const rust = selectEngine(cfg, host, engineConfig);
    assert.ok(rust instanceof EngineClient);
    await rust.close();
  });

  it("retains class methods and getters through lifecycle admission", async () => {
    const home = tempDir("engine-lifecycle-");
    const lifecycle = new AgentLifecycle({ path: join(home, "lifecycle.sqlite") });
    const client = new EngineClient({ home });
    try {
      const guarded = lifecycleEngine(client, lifecycle);
      assert.equal(guarded.contract, client.contract);
      assert.equal(typeof guarded.recall, "function");
      await assert.rejects(guarded.recall({} as never), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "engine-unavailable");
      await guarded.close();
    } finally { await client.close(); lifecycle.close(); }
  });
});
