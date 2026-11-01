import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rollbackPromptImport } from "../../../src/import/prompt/execute.ts";
import { tempDir } from "../../helpers/temp-dir.ts";

describe("owner rollback of a foreign prompt import run (key chunks)", () => {
  it("sends the run's agent keys (created and linked) in chunks of at most 500 and keeps user-scope cards", async () => {
    const home = tempDir("p-rollback-chunks-");
    const runId = "prompt-1790000000000-abcd1234";
    const dir = join(home, "imports", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), JSON.stringify({
      runId, source: "prompt", status: "completed", importedBy: "admin-a", affectedAgents: ["default"], proposals: [],
    }));
    const lines: string[] = [];
    for (let i = 0; i < 1100; i++) {
      lines.push(JSON.stringify({ runId, action: "created", idempotencyKey: `a-${i}`, details: { agentId: "default", scope: "agent-private" } }));
    }
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({ runId, action: "linked", idempotencyKey: `l-${i}`, details: { agentId: "default", scope: "agent-private" } }));
    }
    for (let i = 0; i < 7; i++) {
      lines.push(JSON.stringify({ runId, action: "created", idempotencyKey: `u-${i}`, details: { agentId: "default", scope: "user" } }));
    }
    writeFileSync(join(dir, "ledger.jsonl"), lines.join("\n") + "\n");
    const calls: string[][] = [];
    const engine: any = {
      memory: {
        unimport: async (req: any) => {
          calls.push(req.idempotencyKeys);
          return { unimported: req.idempotencyKeys.length, failed: 0, remaining: 0, keptModified: 0 };
        },
      },
    };
    const res = await rollbackPromptImport({
      runId, home, engine, principal: { userId: "owner-b" } as any, callerUserId: "owner-b", isOwner: true,
    });
    assert.ok(calls.every((c) => c.length <= 500), "every unimport call carries at most 500 keys");
    assert.equal(calls.flat().length, 1130);
    assert.ok(!calls.flat().some((k) => k.startsWith("u-")), "user-scope keys are never sent");
    assert.equal(res.rolledBack, 1130);
    assert.equal(res.preservedUserScope, 7);
    assert.equal(res.keptModified, 0);
  });

  it("counts lifted links and keeps rolling back the other agents when one principal cannot be built", async () => {
    const home = tempDir("p-rollback-links-");
    const runId = "prompt-1790000000001-abcd1234";
    const dir = join(home, "imports", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), JSON.stringify({
      runId, source: "prompt", status: "completed", importedBy: "admin-a", affectedAgents: ["ghost", "default"], proposals: [],
    }));
    writeFileSync(join(dir, "ledger.jsonl"), "");
    const engine: any = {
      memory: {
        unimport: async () => ({ unimported: 0, failed: 0, remaining: 0, keptModified: 0, links: { selected: 3, unlinked: 3, alreadyUnlinked: 0, items: [] } }),
      },
    };
    const res = await rollbackPromptImport({
      runId, home, engine, principal: { userId: "admin-a" } as any, callerUserId: "admin-a",
      principalFor: (id: string) => {
        if (id === "ghost") throw new Error("ENOENT: no workspace directory");
        return { userId: "admin-a", agentId: id } as any;
      },
    });
    assert.equal(res.unlinked, 3, "a rollback that only unlinks reports the links");
    assert.equal(res.rolledBack, 0);
    assert.equal(res.failed, 1, "the agent without a workspace fails alone");
    assert.equal(res.remaining, 1);
  });
});
