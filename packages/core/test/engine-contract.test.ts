import { mkdirSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { buildEngineConfig } from "../src/engine-config.ts";
import { assertEngineContract, bindEngine } from "../src/engine.ts";
import { createHarnessHost } from "../src/host.ts";
import { createLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

// The engine's own `ContractVersion` type is pinned to the literal `"1.12.0"` at the current pin,
// so these fixtures (deliberately mismatched or malformed) are widened to plain strings — exactly
// what `assertEngineContract` must guard against at runtime, where the engine's declared type is
// no guarantee against a differently-pinned build.
function fixture(contract: string): Parameters<typeof assertEngineContract>[0] {
  return { contract } as Parameters<typeof assertEngineContract>[0];
}

describe("assertEngineContract", () => {
  it("accepts 1.8.0, 1.11.0, 1.12.0 and 1.99.0", () => {
    assert.doesNotThrow(() => assertEngineContract(fixture("1.8.0")));
    assert.doesNotThrow(() => assertEngineContract(fixture("1.11.0")));
    assert.doesNotThrow(() => assertEngineContract(fixture("1.12.0")));
    assert.doesNotThrow(() => assertEngineContract(fixture("1.99.0")));
  });

  it("refuses 2.0.0 with E_RPC_VERSION engine-contract-major", () => {
    try {
      assertEngineContract(fixture("2.0.0"));
      assert.fail("expected assertEngineContract to throw");
    } catch (e) {
      assert.ok(e instanceof RpcError);
      const err = e as RpcError;
      assert.equal(err.error, "E_RPC_VERSION");
      assert.equal(err.reason, "engine-contract-major");
      assert.equal(err.detail, "2.0.0");
    }
  });

  it("refuses a 1.x contract older than 1.8.0 with E_RPC_VERSION engine-contract-minor (S18)", () => {
    try {
      assertEngineContract(fixture("1.7.0"));
      assert.fail("expected assertEngineContract to throw");
    } catch (e) {
      assert.ok(e instanceof RpcError);
      const err = e as RpcError;
      assert.equal(err.error, "E_RPC_VERSION");
      assert.equal(err.reason, "engine-contract-minor");
      assert.equal(err.detail, "1.7.0");
    }
  });

  it("the pinned engine reports 1.12.0 and exposes memory.import, stores.adopt, memory.rebind and memory.unbind", async () => {
    const l = layout(tempDir("p1b-contract-112-"));
    for (const d of [l.state, l.logs, l.agents, l.lancedb]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const cfg = defaults();
    cfg.agents.bernd = {};
    const reg = createAgentRegistry(cfg, l);
    reg.scaffold("bernd");
    const logger = createLogger({ file: l.logFile("core"), level: "info", role: "core" });
    const engineConfig = buildEngineConfig(cfg, l);
    const host = createHarnessHost({ layout: l, logger, config: cfg, engineConfig, agents: reg, events: () => {} });
    const engine = bindEngine(host, engineConfig, flatTestInternals());
    try {
      assert.equal(engine.contract, "1.12.0");
      assert.equal(typeof engine.memory.import, "function");
      assert.equal(typeof engine.stores.adopt, "function");
      assert.equal(typeof engine.memory.rebind, "function");
      assert.equal(typeof engine.memory.unbind, "function");
    } finally {
      await engine.close({ budgetMs: 2000 });
      await logger.close();
    }
  });

  it("refuses a non-semver contract", () => {
    for (const bad of ["1.6", ""]) {
      try {
        assertEngineContract(fixture(bad));
        assert.fail(`expected assertEngineContract to throw for ${JSON.stringify(bad)}`);
      } catch (e) {
        assert.ok(e instanceof RpcError);
        const err = e as RpcError;
        assert.equal(err.error, "E_RPC_VERSION");
        assert.equal(err.reason, "engine-contract-major");
        assert.equal(err.detail, bad);
      }
    }
  });
});
