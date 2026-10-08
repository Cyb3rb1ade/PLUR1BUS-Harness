import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { open, owner, projectWithAgents, wait } from "./helpers.ts";

describe("collab shutdown", () => {
  it("waits for in-flight runs only up to its budget, then abandons them with an event", async () => {
    let started = false;
    // A runner that ignores its abort signal and never settles: the case that used to spin forever.
    const h = open({ runner: { run: () => { started = true; return new Promise(() => {}); } } });
    const p = await projectWithAgents(h, ["lead", "worker"]);
    const handle = h.collab.delegate({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", task: "never ends", acceptanceCriteria: "x" });
    for (let i = 0; i < 50 && !started; i++) await wait(2);
    assert.equal(started, true);
    const t0 = Date.now();
    await h.collab.shutdown(50);
    assert.ok(Date.now() - t0 < 2_000, "shutdown is bounded");
    const abandoned = h.events.find((e) => e.type === "chain.abandoned");
    assert.ok(abandoned, "abandonment is reported");
    assert.equal(abandoned.data.inflight, 1);
    void handle.done.catch(() => {});
  });

  it("a cooperative run still finishes inside the budget without an abandonment", async () => {
    const h = open({ runner: { run: (input) => new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) } });
    const p = await projectWithAgents(h, ["lead", "worker"]);
    const handle = h.collab.delegate({ principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker", task: "stops on abort", acceptanceCriteria: "x" });
    await wait(5);
    await h.collab.shutdown(2_000);
    assert.equal((await handle.done).status, "cancelled");
    assert.ok(!h.events.some((e) => e.type === "chain.abandoned"));
  });
});
