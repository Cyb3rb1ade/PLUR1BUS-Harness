import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createHarnessHost } from "../src/host.ts";
import { buildEngineConfig } from "../src/engine-config.ts";
import { createLogger } from "../src/logger.ts";
import { layout } from "../src/paths.ts";
import { createAgentRegistry } from "../src/agents.ts";

describe("harness host", () => {
  it("implements HostServices without routing, pathOverrides or runtime", async () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-host-")));
    const cfg = defaults(); cfg.agents.bernd = {};
    const reg = createAgentRegistry(cfg, l); reg.scaffold("bernd");
    const events: unknown[] = [];
    const host = createHarnessHost({ layout: l, logger: createLogger({ file: l.logFile("core"), level: "info", role: "core" }), config: cfg, engineConfig: buildEngineConfig(cfg, l), agents: reg, events: (n, p) => events.push([n, p]) });
    assert.equal(host.stateDir, l.state);
    assert.equal(host.configPath(), l.configPath);
    assert.equal(host.routing, undefined); assert.equal(host.pathOverrides, undefined); assert.equal(host.runtime, null);
    assert.equal(host.llm, undefined); assert.equal(host.secrets, undefined);
    assert.equal(await host.workspaceDir("bernd"), l.workspaceDir("bernd"));
    assert.equal(await host.workspaceDir("nobody"), undefined);
    assert.equal((host.config() as any).baseDbPath, l.lancedb);
    host.events!.emit("x", { a: 1 }); assert.deepEqual(events, [["x", { a: 1 }]]);
    assert.equal(typeof host.platform.securePath, "function");
  });
});
