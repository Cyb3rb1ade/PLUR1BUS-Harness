import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createAgentRegistry } from "../src/agents.ts";
import { layout } from "../src/paths.ts";

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
});
