/** Tests for prompt-based memory import wizard and text export dialog. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMemoryExport } from "../../core/src/import/prompt/parse.ts";
import { recommendTargets } from "../../core/src/import/prompt/recommend.ts";
import { exportMemoriesAsText } from "../../core/src/import/prompt/export.ts";

describe("Prompt memory import & export web flows", () => {
  const sampleExport = `PLUR1BUS-MEMORY-EXPORT v1
## Instructions
[2024-01-01] [memory] - Always respond concisely.
## Identity
[2024-01-02] [memory] - User lives in Berlin.
## Career
[2024-01-03] [chat] - Senior Engineer at Acme.
## Projects
[2024-01-04] [memory] - PLUR1BUS: Multi-agent memory harness.
## Preferences
[2024-01-05] [memory] - Prefers dark mode.
## Other
[unknown] [memory] - Favorite number is 42.
STATUS: COMPLETE`;

  test("parser extracts 6 categories and correct source types", () => {
    const res = parseMemoryExport(sampleExport);
    assert.equal(res.status, "complete");
    assert.equal(res.entries.length, 6);

    const categories = res.entries.map((e) => e.category);
    assert.deepEqual(categories, [
      "Instructions",
      "Identity",
      "Career",
      "Projects",
      "Preferences",
      "Other",
    ]);

    assert.equal(res.entries[0]?.sourceType, "memory");
    assert.equal(res.entries[2]?.sourceType, "chat");
  });

  test("recommendations apply secure defaults", () => {
    const parsed = parseMemoryExport(sampleExport);
    const recs = recommendTargets(parsed.entries, {
      hasUserBinding: true,
      availableAgents: ["agent1"],
      currentAgentId: "agent1",
    });
    assert.equal(recs.length, 6);

    // Instructions -> propose-rule
    assert.equal(recs[0]?.target, "propose-rule");
    // Identity, Career, Preferences -> user
    assert.equal(recs[1]?.target, "user");
    assert.equal(recs[2]?.target, "user");
    assert.equal(recs[4]?.target, "user");
  });

  test("secrets are redacted and recommended to skip", () => {
    const textWithSecret = `PLUR1BUS-MEMORY-EXPORT v1
## Instructions
[2024-01-01] [memory] - Use key sk-ant-api03-abcdef123456789012345678901234567890123456789012345678901234567890
STATUS: COMPLETE`;
    const parsed = parseMemoryExport(textWithSecret);
    assert.equal(parsed.entries.length, 1);
    assert.ok(parsed.entries[0]?.warnings.includes("secret-redacted"));
    assert.ok(!parsed.entries[0]?.text.includes("abcdef1234567890"));

    const recs = recommendTargets(parsed.entries, {
      hasUserBinding: true,
      availableAgents: ["agent1"],
      currentAgentId: "agent1",
    });
    assert.equal(recs[0]?.target, "skip");
  });

  test("export generates matching format with 6 category headers", async () => {
    const mockCards = [
      { id: "c1", scope: "user", kind: "Preferences", text: "Likes green tea", createdAt: 1704067200000 },
      { id: "c2", scope: "user", kind: "Identity", text: "Name is Alice", createdAt: 1704153600000 },
    ];
    const mockEngine: any = {
      memory: {
        list: async () => ({ items: mockCards }),
      },
    };
    const exported = await exportMemoriesAsText({
      principal: {
        agentId: "agent1",
        workspace: "workspace:v1:main",
        user: "user:v1:alice" as any,
        channel: "cli",
        accountId: "default",
        chat: { id: "c1", kind: "direct" },
        trust: "proved",
      },
      engine: mockEngine,
    });

    assert.ok(exported.startsWith("PLUR1BUS-MEMORY-EXPORT v1"));
    assert.ok(exported.includes("## Identity"));
    assert.ok(exported.includes("## Preferences"));
    assert.ok(exported.includes("STATUS: COMPLETE"));

    // Roundtrip verification through parser
    const reparsed = parseMemoryExport(exported);
    assert.equal(reparsed.status, "complete");
    assert.equal(reparsed.entries.length, 2);
  });
});
