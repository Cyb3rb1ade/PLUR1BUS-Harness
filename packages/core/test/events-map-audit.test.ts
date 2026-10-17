import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { validateNotification } from "@plur1bus/rpc-schema";
import { mapEngineEvent } from "../src/events-map.ts";

const AGENT_EVENTS: Record<string, unknown> = {
  "recall.completed": { agentId: "bernd", timing: { totalMs: 5 }, degraded: null },
  "recall.degraded": { agentId: "bernd", degraded: { reason: "timeout", capability: "recall" } },
  "recall.block-clipped": { agentId: "bernd", block: "memories", from: 10, to: 5, reason: "memories-cap" },
  "recall.block-dropped": { agentId: "bernd", block: "skills", from: 10, to: 0, reason: "global-cap" },
  "job.run": { agentId: "bernd", runId: "r", job: "j", phase: null, trigger: "cron", outcome: "skipped", startedAt: 1, finishedAt: 2, durationMs: 1, attempt: 1 },
  "dream.completed": { agentId: "bernd" },
  "acl.denied": { agentId: "bernd" },
};

describe("mapEngineEvent fails closed", () => {
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "engine.event", "", "RECALL.COMPLETED", "recall.completed "]) {
    it(`unknown or inherited name ${JSON.stringify(name)} maps to nothing`, () => {
      assert.equal(mapEngineEvent(name, { agentId: "bernd" }), null);
    });
  }
  for (const payload of [undefined, null, 0, "bernd", [], [{ agentId: "bernd" }], () => ({ agentId: "bernd" })]) {
    it(`a non-object payload (${typeof payload}${Array.isArray(payload) ? "[]" : ""}) maps to nothing`, () => {
      for (const name of Object.keys(AGENT_EVENTS)) assert.equal(mapEngineEvent(name, payload), null, name);
    });
  }
  it("an agentId outside the AgentId pattern never reaches a notification typed with it", () => {
    for (const bad of ["", "Bernd", "a b", "../x", "-x", "x".repeat(65), 5, null, ["bernd"], { toString: () => "bernd" }]) {
      for (const [name, payload] of Object.entries(AGENT_EVENTS)) assert.equal(mapEngineEvent(name, { ...(payload as object), agentId: bad }), null, `${name} ${JSON.stringify(bad)}`);
    }
  });
});

describe("mapEngineEvent redaction", () => {
  it("drops every field the schema does not name, on every event", () => {
    for (const [name, payload] of Object.entries(AGENT_EVENTS)) {
      const m = mapEngineEvent(name, { ...(payload as object), internalPath: "/var/lib/engine/x", cost: { usd: 1 }, keys: ["k"], __proto__: { polluted: true } });
      assert.ok(m, name);
      assert.equal(JSON.stringify(m).includes("internalPath"), false, name);
      assert.equal(Object.hasOwn(m.params, "cost") || Object.hasOwn(m.params, "keys") || Object.hasOwn(m.params, "polluted"), false, name);
      assert.deepEqual(validateNotification(m.method, m.params), { ok: true }, name);
    }
  });
  it("keeps only reason, capability and detail of a degraded marker", () => {
    const m = mapEngineEvent("recall.degraded", { agentId: "bernd", degraded: { reason: "r", capability: "c", detail: "d", stack: "at /srv/x.js:1", path: "/srv/x" } });
    assert.deepEqual(m!.params.degraded, { reason: "r", capability: "c", detail: "d" });
  });
  it("memory.proposal carries no field beyond the schema's", () => {
    const m = mapEngineEvent("memory.proposal", { proposalId: "p", status: "pending", sharerAgentId: "a", proposerAgentId: "b", sharedId: "s", diff: "secret text", content: "secret text" });
    assert.deepEqual(Object.keys(m!.params).sort(), ["agentId", "proposalId", "proposerAgentId", "sharedId", "sharerAgentId", "status"]);
  });
  it("memory.proposal is addressed to exactly its two parties, never to everyone", () => {
    const m = mapEngineEvent("memory.proposal", { proposalId: "p", status: "pending", sharerAgentId: "a", proposerAgentId: "b", sharedId: "s" });
    assert.deepEqual(m!.audience, ["a", "b"]);
  });
});

describe("audience of per-agent events", () => {
  // KNOWN GAP (see report): every event below is delivered by params.agentId only to subscriptions that filter on that agent,
  // but to EVERY subscription without an agent filter, and events.subscribe checks no caller rights. Naming the agent as the
  // audience would close that, yet core.test.ts ("a subscriber without names gets recall.completed") depends on unfiltered delivery
  // and the Transport PR #468 consumes these events: that is a decision for the owner, not for this module.
  for (const name of Object.keys(AGENT_EVENTS)) {
    test.todo(`KNOWN GAP: ${name} names its agent as the audience instead of being delivered to every unfiltered subscription`);
  }
});
