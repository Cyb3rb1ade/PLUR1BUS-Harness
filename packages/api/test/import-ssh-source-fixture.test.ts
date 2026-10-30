/** Both SSH acceptance sources exercise real supported readers before the full native transport test consumes them. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSource } from "../../core/src/import/source.ts";
import { createSshSources } from "./fixtures/import-ssh-source-tree.ts";

test("known-home sources contain real persona, cards, skill, plugin classification and sanitized MCP metadata for each family", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ssh-source-tree-"));
  const home = await mkdtemp(join(tmpdir(), "ssh-target-tree-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const fixture = await createSshSources(root);
  assert.equal(fixture.sources.length, 2);
  for (const source of fixture.sources) {
    const read = await readSource({
      sourceType: source.family,
      source: source.localPath,
      home,
      env: {},
      homedir: source.localPath,
    });
    assert.equal(read.report.version.supported, true);
    assert.equal(read.report.agents.length, 1);
    assert.equal(read.report.agents[0]!.agentId, source.agentId);
    assert.equal(read.report.other.memoryFiles, 1);
    assert.equal(read.skills.length, 1);
    assert.equal(read.skills[0]!.name, source.skill);
    assert.equal(read.discovery.plugins.length, 1);
    assert.equal(read.discovery.plugins[0]!.classification, "unknown");
    assert.equal(read.discovery.mcpCandidates.length, 1);
    assert.equal(read.discovery.mcpCandidates[0]!.transport.type, "http");
    assert.deepEqual(read.discovery.mcpCandidates[0]!.requiredSecrets, [{ slot: "AUTHORIZATION" }]);
    assert.equal(JSON.stringify(read.discovery).includes(fixture.canary), false);
  }
});
