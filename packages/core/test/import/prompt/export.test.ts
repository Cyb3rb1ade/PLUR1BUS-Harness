import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportMemoriesAsText } from "../../../src/import/prompt/export.ts";
import { parseMemoryExport } from "../../../src/import/prompt/parse.ts";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

describe("exportMemoriesAsText", () => {
  it("exports user and agent memories in standard format and roundtrips with parseMemoryExport", async () => {
    const userCards = [
      {
        id: "c1",
        scope: "user",
        kind: "Identity",
        createdAt: new Date("2024-01-10T00:00:00Z").getTime(),
        text: "Alex, 34, engineer in Berlin.",
      },
      {
        id: "c2",
        scope: "user",
        kind: "Preferences",
        createdAt: new Date("2024-02-01T00:00:00Z").getTime(),
        text: "Prefers concise technical answers.",
      },
    ];

    const agentCards = [
      {
        id: "c3",
        scope: "agent-private",
        kind: "Projects",
        createdAt: new Date("2024-03-01T00:00:00Z").getTime(),
        text: "Project Apollo: distributed coordinator.",
      },
    ];

    const engine: any = {
      memory: {
        list: async (_q: any, _p: any, ctx: any) => {
          if (ctx.agentId === "bernd") {
            return { items: agentCards };
          }
          return { items: userCards };
        },
      },
    };

    const principal: E.Principal = {
      agentId: "bernd",
      workspace: "workspace:v1:main",
      user: "user:v1:u1" as any,
      channel: "cli",
      accountId: "default",
      chat: { id: "c1", kind: "direct" },
      trust: "proved",
    };

    const text = await exportMemoriesAsText({
      principal,
      engine,
      agentId: "bernd",
    });

    assert.ok(text.startsWith("PLUR1BUS-MEMORY-EXPORT v1\n"));
    assert.ok(text.endsWith("STATUS: COMPLETE\n"));
    assert.ok(text.includes("## Identity"));
    assert.ok(text.includes("[2024-01-10] [memory] - Alex, 34, engineer in Berlin."));
    assert.ok(text.includes("## Preferences"));
    assert.ok(text.includes("[2024-02-01] [memory] - Prefers concise technical answers."));
    assert.ok(text.includes("## Projects"));
    assert.ok(text.includes("[2024-03-01] [memory] - Project Apollo: distributed coordinator."));

    // Roundtrip verification: parseMemoryExport on the exported text returns the entries
    const parsed = parseMemoryExport(text);
    assert.equal(parsed.status, "complete");
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.entries[0]!.category, "Identity");
    assert.equal(parsed.entries[1]!.category, "Projects");
    assert.equal(parsed.entries[2]!.category, "Preferences");
  });

  it("redacts secrets during export", async () => {
    const cards = [
      {
        id: "c1",
        scope: "user",
        kind: "Identity",
        createdAt: new Date("2024-01-10T00:00:00Z").getTime(),
        text: "Secret token: sk-ant-api03-abcdef1234567890abcdef1234567890abcdef",
      },
    ];

    const engine: any = {
      memory: {
        list: async () => ({ items: cards }),
      },
    };

    const principal: E.Principal = {
      agentId: "bernd",
      workspace: "workspace:v1:main",
      user: "user:v1:u1" as any,
      channel: "cli",
      accountId: "default",
      chat: { id: "c1", kind: "direct" },
      trust: "proved",
    };

    const text = await exportMemoriesAsText({ principal, engine });
    assert.ok(!text.includes("sk-ant-api03-"));
  });
});
