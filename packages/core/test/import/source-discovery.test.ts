// A13 discovery runs actual source readers and keeps the existing CLI report projection byte-for-byte equivalent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "../../src/import/source.ts";
import { detect } from "../../src/import/detect.ts";
import { detectOpenclaw } from "../../src/import/sources/openclaw.ts";
import { targetIdentity } from "../../src/import/identity.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { treeDigest } from "./tree.ts";
import { createSourceDiscovery } from "../../src/import/source-discovery.ts";

const MARKER = "A13_SOURCE_SECRET_VALUE_NEVER_RETURNED";

describe("internal source discovery (A13)", () => {
  it("refuses total discovery limits across profiles and oversized plugin lists before target mutation", () => {
    const capture = createSourceDiscovery("hermes");
    capture.capture({ mcp_servers: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`server${i}`, {}])) }, "first");
    assert.throws(() => capture.capture({ mcp_servers: { extra: {} } }, "second"),
      (error: any) => error.reason === "extension-source-limit");
    assert.throws(() => createSourceDiscovery("hermes").capture({ plugins: Array.from({ length: 257 }, (_, i) => `plugin${i}`) }, null),
      (error: any) => error.reason === "extension-source-limit");
  });
  it("captures actual OpenClaw MCP/plugin configuration beside an unchanged legacy report", async () => {
    const source = tempDir("p1b-a13-source-");
    const home = tempDir("p1b-a13-home-");
    writeFileSync(join(source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.21" },
      mcp: { servers: { search: { url: "https://tools.example/mcp", headers: { Authorization: MARKER } } } },
      plugins: { entries: { example: { enabled: true, tools: [MARKER] } } },
    }));
    const sourceBefore = treeDigest(source);
    const homeBefore = treeDigest(home);
    const input = { sourceType: "openclaw" as const, home, source, env: {}, homedir: source };
    const result = await readSource(input);
    const discovery = result.discovery;
    assert.equal(discovery?.mcpCandidates.length, 1);
    assert.equal(discovery?.plugins.length, 1);
    assert.equal(discovery.plugins[0]!.classification, "unknown");
    const legacy = await detectOpenclaw({ ...input, target: targetIdentity(home) });
    assert.deepEqual(result.report, legacy);
    const cli = await detect(input);
    assert.equal("discovery" in cli, false);
    assert.equal("mcpCandidates" in cli, false);
    assert.equal("plugins" in cli, false);
    assert.equal(JSON.stringify({ discovery, cli }).includes(MARKER), false);
    assert.equal(treeDigest(source), sourceBefore);
    assert.equal(treeDigest(home), homeBefore);
  });

  it("captures Hermes root and selected profile MCP maps with distinct source identities", async () => {
    const source = tempDir("p1b-a13-hermes-");
    const home = tempDir("p1b-a13-home-");
    writeFileSync(join(source, "config.yaml"), `_config_version: 45\nmcp_servers:\n  search:\n    command: uvx\n    args: ["${MARKER}"]\nplugins: ["example"]\n`);
    mkdirSync(join(source, "profiles", "Work"), { recursive: true });
    writeFileSync(join(source, "profiles", "Work", "config.yaml"),
      "_config_version: 45\nmcp_servers:\n  search:\n    url: https://tools.example/mcp\n");
    const input = { sourceType: "hermes" as const, home, source, env: {}, homedir: source };
    const all = (await readSource(input)).discovery;
    assert.equal(all?.mcpCandidates.length, 2);
    assert.deepEqual(all.mcpCandidates.map(item => item.profile), ["default", "work"]);
    assert.notEqual(all.mcpCandidates[0]!.name, all.mcpCandidates[1]!.name);
    assert.equal(all.plugins[0]!.classification, "unknown");
    const selected = (await readSource({ ...input, profile: "Work" })).discovery;
    assert.equal(selected.mcpCandidates.length, 1);
    assert.equal(selected.mcpCandidates[0]!.profile, "work");
    assert.equal(JSON.stringify(all).includes(MARKER), false);
  });
});
