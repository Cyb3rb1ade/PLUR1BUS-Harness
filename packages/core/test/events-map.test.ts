import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateNotification } from "@plur1bus/rpc-schema";
import { mapEngineEvent } from "../src/events-map.ts";

// One realistic payload per name the pinned engine emits (engine/recall/assemble-prompt-context.js,
// engine/jobs/job-registry.js:332, engine/memory-ops/proposals.js), plus the three it only declares (G11).
const PAYLOADS: Record<string, unknown> = {
  "recall.completed": {
    agentId: "bernd",
    timing: { phases: { embed: 12, search: 30 }, totalMs: 212, namespacePhases: [{ namespace: "agent", phase: "search", ms: 30 }] },
    degraded: null,
  },
  "recall.degraded": { agentId: "bernd", degraded: { reason: "timeout", capability: "recall", detail: "scheduler budget exceeded" } },
  "recall.block-clipped": { agentId: "bernd", block: "memories", kind: "clipped", from: 4200, to: 3000, reason: "memories-cap" },
  "recall.block-dropped": { agentId: "bernd", block: "skills", kind: "dropped", from: 800, to: 0, reason: "global-cap" },
  "job.run": {
    runId: "run-1", job: "dream-light", phase: "light", agentId: "bernd", trigger: "cron",
    startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_250, durationMs: 250, outcome: "skipped", reason: "already_processed", attempt: 1,
    cost: { ms: 250 }, counts: {}, keys: ["k1"], idempotencyKey: "k1", diary: { written: false },
  },
  "memory.proposal": { proposalId: "p-1", status: "pending", sharerAgentId: "bernd", proposerAgentId: "anna", sharedId: "m-copy" },
  "dream.completed": { agentId: "bernd" },
  "acl.denied": { agentId: "bernd" },
  "embedding.identity.changed": {},
};

describe("mapEngineEvent", () => {
  it("every mapped notification validates against its schema", () => {
    for (const [name, payload] of Object.entries(PAYLOADS)) {
      const m = mapEngineEvent(name, payload);
      assert.ok(m, `${name} maps`);
      assert.equal(m.method, name);
      assert.deepEqual(validateNotification(m.method, m.params), { ok: true }, name);
    }
  });

  it("recall.completed drops phases and namespacePhases", () => {
    const m = mapEngineEvent("recall.completed", PAYLOADS["recall.completed"]);
    assert.deepEqual(m, { method: "recall.completed", params: { agentId: "bernd", totalMs: 212, degraded: null } });
  });

  it("job.run drops counts, cost and keys", () => {
    const m = mapEngineEvent("job.run", PAYLOADS["job.run"]);
    assert.deepEqual(Object.keys(m!.params).sort(), ["agentId", "attempt", "durationMs", "finishedAt", "job", "outcome", "phase", "reason", "runId", "startedAt", "trigger"]);
  });

  it("memory.proposal audience is sharer and proposer", () => {
    const m = mapEngineEvent("memory.proposal", PAYLOADS["memory.proposal"]);
    assert.deepEqual(m, {
      method: "memory.proposal",
      params: { agentId: "bernd", proposalId: "p-1", status: "pending", sharerAgentId: "bernd", proposerAgentId: "anna", sharedId: "m-copy" },
      audience: ["bernd", "anna"],
    });
  });

  it("memory.proposal with foreign agent ids validates", () => {
    const m = mapEngineEvent("memory.proposal", { proposalId: "p-2", status: "accepted", sharerAgentId: "Anna.Main", proposerAgentId: "Bernd:Laptop", sharedId: "m-copy" });
    assert.ok(m);
    assert.equal(m.params.agentId, "Anna.Main");
    assert.deepEqual(m.audience, ["Anna.Main", "Bernd:Laptop"]);
    assert.deepEqual(validateNotification(m.method, m.params), { ok: true });
  });

  it("an unknown name and a payload with agentId \"Default Agent\" return null", () => {
    assert.equal(mapEngineEvent("recall.exploded", { agentId: "bernd" }), null);
    assert.equal(mapEngineEvent("recall.degraded", { ...(PAYLOADS["recall.degraded"] as object), agentId: "Default Agent" }), null);
    assert.equal(mapEngineEvent("recall.completed", { ...(PAYLOADS["recall.completed"] as object), agentId: "Default Agent" }), null);
    assert.equal(mapEngineEvent("acl.denied", { agentId: "Default Agent" }), null);
  });

  it("a payload missing a required field returns null", () => {
    assert.equal(mapEngineEvent("recall.completed", { agentId: "bernd", degraded: null }), null);
    assert.equal(mapEngineEvent("recall.block-dropped", { agentId: "bernd", block: "skills", from: 800, to: 0 }), null);
    const { runId: _r, ...noRunId } = PAYLOADS["job.run"] as Record<string, unknown>;
    assert.equal(mapEngineEvent("job.run", noRunId), null);
    assert.equal(mapEngineEvent("memory.proposal", { proposalId: "p-1", status: "pending", sharerAgentId: "bernd", sharedId: "m-copy" }), null);
    assert.equal(mapEngineEvent("dream.completed", {}), null);
    assert.equal(mapEngineEvent("recall.degraded", null), null);
  });
});
