import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { isCode, open, owner, projectWithAgents, wait } from "./helpers.ts";

describe("delegate", () => {
  it("returns a task that succeeds with a capped result and an artifact pointer", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker"], { returnTokens: 8 });
    const long = "WORD ".repeat(80);
    const handle = h.collab.delegate({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      task: long, acceptanceCriteria: "done",
    });
    assert.equal(handle.task.status, "queued");
    const done = await handle.done;
    assert.equal(done.status, "succeeded");
    assert.equal(done.truncated, true);
    assert.ok(done.result && done.result.includes("truncated"));
    assert.ok(done.artifactPointer && done.artifactPointer.startsWith("artifact:"));
    assert.ok(done.result.includes(done.artifactPointer));
    const full = h.collab.getTask(owner(), done.id);
    assert.ok(full.result && full.result.includes("truncated"));
  });

  it("never silently truncates: the marker names the pointer", async () => {
    const h = open();
    const p = await projectWithAgents(h, ["lead", "worker"], { returnTokens: 6 });
    const done = await h.collab.delegate({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      task: "abcdefghijklmnopqrstuvwxyz ".repeat(20), acceptanceCriteria: "x",
    }).done;
    assert.equal(done.truncated, true);
    assert.equal(done.result?.includes("[truncated"), true);
    assert.equal(done.result?.includes("artifact:"), true);
  });

  it("abort cancels in-flight delegates and their siblings on the chain", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = new FakeChatProvider({ gate: async () => { await gate; } });
    const h = open({ provider });
    const p = await projectWithAgents(h, ["lead", "worker", "spec"], { maxFanout: 3, maxDepth: 2 });
    const ac = new AbortController();
    const a = h.collab.delegate({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
      task: "one", acceptanceCriteria: "ok", signal: ac.signal,
    });
    await wait(20);
    const b = h.collab.delegate({
      principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "spec",
      task: "two", acceptanceCriteria: "ok", traceId: a.task.traceId, signal: ac.signal,
    });
    await wait(20);
    ac.abort();
    release();
    const [da, db] = await Promise.all([a.done, b.done]);
    assert.equal(da.status, "cancelled");
    assert.equal(db.status, "cancelled");
  });
});
