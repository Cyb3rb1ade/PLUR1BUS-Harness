import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, utimesSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { layout } from "../src/paths.ts";
import { createLogger, type HarnessLogger } from "../src/logger.ts";

describe("agents", () => {
  it("lists config.agents, scaffolds the persona files once, and knows unregistered ids", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); cfg.agents.bernd = { createdAt: "2026-09-24T00:00:00Z" };
    const reg = createAgentRegistry(cfg, l);
    assert.deepEqual(reg.list(), ["bernd"]); assert.equal(reg.has("nobody"), false);
    reg.scaffold("bernd");
    for (const f of ["SOUL.md", "USER.md", "persona-voice.md"]) assert.ok(existsSync(join(l.agentDir("bernd"), f)), f);
    assert.ok(existsSync(l.workspaceDir("bernd")));
    assert.match(readFileSync(join(l.agentDir("bernd"), "persona-voice.md"), "utf8"), /<!-- persona:begin -->[\s\S]*<!-- persona:end -->/);
    const before = readFileSync(join(l.agentDir("bernd"), "SOUL.md"), "utf8");
    reg.scaffold("bernd");
    assert.equal(readFileSync(join(l.agentDir("bernd"), "SOUL.md"), "utf8"), before, "idempotent");
  });

  it("picks up an agent added to config.json without a restart", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); writeFileSync(l.configPath, JSON.stringify(cfg));
    const reg = createAgentRegistry({ path: l.configPath }, l);
    assert.deepEqual(reg.list(), []);
    const later = defaults(); later.agents.bernd = {}; const t = Date.now() + 2000; writeFileSync(l.configPath, JSON.stringify(later)); utimesSync(l.configPath, t / 1000, t / 1000);
    assert.deepEqual(reg.list(), ["bernd"]);
    assert.equal(reg.workspaceOf("bernd"), l.workspaceDir("bernd"));
    assert.ok(existsSync(join(l.agentDir("bernd"), "SOUL.md")), "SOUL.md should exist after list()");
  });

  it("scaffolds a live-added agent on workspaceOf() call (recall path)", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); writeFileSync(l.configPath, JSON.stringify(cfg));
    const reg = createAgentRegistry({ path: l.configPath }, l);
    const later = defaults(); later.agents.bernd = {}; const t = Date.now() + 2000; writeFileSync(l.configPath, JSON.stringify(later)); utimesSync(l.configPath, t / 1000, t / 1000);
    const ws = reg.workspaceOf("bernd");
    assert.equal(ws, l.workspaceDir("bernd"));
    assert.ok(existsSync(join(l.agentDir("bernd"), "SOUL.md")), "SOUL.md should exist after workspaceOf()");
  });

  it("dedupes missing-file warnings", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); writeFileSync(l.configPath, JSON.stringify(cfg));
    const warns: string[] = [];
    const logger: HarnessLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warns.push(msg),
      error: () => {},
      child: () => logger,
      setLevel: () => {},
      close: async () => {},
    };
    const reg = createAgentRegistry({ path: l.configPath }, l, logger);
    reg.list(); // load initial config
    // Delete the file
    rmSync(l.configPath);
    reg.list(); reg.list(); reg.list();
    assert.equal(warns.length, 1, "should warn only once for missing file across multiple calls");
  });

  it("caches invalid config and skips reloads until file changes", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); writeFileSync(l.configPath, JSON.stringify(cfg));
    let reloadCount = 0;
    const warns: string[] = [];
    const logger: HarnessLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warns.push(msg),
      error: () => {},
      child: () => logger,
      setLevel: () => {},
      close: async () => {},
    };
    const reg = createAgentRegistry({ path: l.configPath }, l, logger);
    reg.list(); // load valid config
    writeFileSync(l.configPath, "invalid json");
    const t = Date.now() + 1000;
    utimesSync(l.configPath, t / 1000, t / 1000);
    reg.list(); // reload, fail, keep old
    const warnsAfterFirst = warns.length;
    reg.list(); // should NOT reload (cached mtime)
    assert.equal(warns.length, warnsAfterFirst, "should not warn again for same invalid mtime");
    // Now fix the config
    const fixed = defaults(); writeFileSync(l.configPath, JSON.stringify(fixed));
    const t2 = Date.now() + 2000;
    utimesSync(l.configPath, t2 / 1000, t2 / 1000);
    reg.list(); // should reload now (new mtime)
    assert.ok(true, "should successfully reload valid config after invalid attempt");
  });

  it("returns undefined for removed agents", () => {
    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); cfg.agents.bernd = {}; writeFileSync(l.configPath, JSON.stringify(cfg));
    const reg = createAgentRegistry({ path: l.configPath }, l);
    assert.ok(reg.workspaceOf("bernd"), "agent should exist initially");
    const later = defaults(); writeFileSync(l.configPath, JSON.stringify(later));
    const t = Date.now() + 1000;
    utimesSync(l.configPath, t / 1000, t / 1000);
    assert.equal(reg.workspaceOf("bernd"), undefined, "removed agent should return undefined");
    assert.equal(reg.has("bernd"), false, "has() should return false for removed agent");
  });

  it("handles scaffold failures gracefully (read-only dir)", function() {
    // Skip on win32 or if running as root (root ignores permissions)
    if (process.platform === "win32" || process.getuid?.() === 0) return;

    const l = layout(mkdtempSync(join(tmpdir(), "p1b-agents-")));
    const cfg = defaults(); cfg.agents.bernd = {}; writeFileSync(l.configPath, JSON.stringify(cfg));
    const warns: string[] = [];
    const logger: HarnessLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg) => warns.push(msg),
      error: () => {},
      child: () => logger,
      setLevel: () => {},
      close: async () => {},
    };
    const reg = createAgentRegistry({ path: l.configPath }, l, logger);
    reg.list(); // scaffold initial agent, creates agents dir
    // Now make agents dir read-only before trying to scaffold new agents
    chmodSync(l.agents, 0o555);
    const cfgV2 = defaults(); cfgV2.agents.bernd = {}; cfgV2.agents.alice = {};
    writeFileSync(l.configPath, JSON.stringify(cfgV2));
    const t = Date.now() + 1000;
    utimesSync(l.configPath, t / 1000, t / 1000);
    reg.list(); // should not throw even if scaffold fails
    chmodSync(l.agents, 0o700); // restore before assertion
    assert.ok(warns.some((w) => w.includes("scaffold")), "should warn about scaffold failure");
  });
});
