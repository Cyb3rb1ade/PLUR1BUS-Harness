import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentHash, evaluate } from "../src/dreams/candidates.ts";
import type { CandidateInput } from "../src/dreams/types.ts";
import { HOUR, mkHarness } from "./helpers/dreams.ts";

describe("candidate gates (pure)", () => {
  const live = { expiresAt: 1000, uniqueQueries: 0, score: 0.99 };
  it("never promotes recalls = 0, whatever the raw score, and records the gate", () => {
    const d = evaluate({ ...live, recalls: 0 }, 10);
    assert.equal(d.promote, false); assert.equal(d.rejectedBy, "utility");
    assert.equal(d.gates.find((g) => g.gate === "utility")!.passed, false);
    assert.ok(d.gates.length >= 4, "every gate is on the record, not just the first failure");
  });
  it("promotes recalls >= 3 and unique_queries >= 3 with a passing score", () => {
    const d = evaluate({ expiresAt: 1000, recalls: 3, uniqueQueries: 3, score: 0.8 }, 10);
    assert.equal(d.promote, true); assert.equal(d.rejectedBy, null);
    assert.ok(d.gates.every((g) => g.passed));
  });
  it("expired candidates are ineligible regardless of score and recalls", () => {
    const d = evaluate({ expiresAt: 5, recalls: 9, uniqueQueries: 9, score: 1 }, 10);
    assert.equal(d.promote, false); assert.equal(d.rejectedBy, "expiry");
  });
  it("content hashing normalises whitespace and unicode form", () => {
    assert.equal(contentHash("  café\n"), contentHash("café"));
    assert.notEqual(contentHash("a"), contentHash("b"));
  });
});

describe("candidate guards in the deep phase (A5, dedupe, expiry)", () => {
  const pool = (items: CandidateInput[]) => ({ pull: () => items });

  it("A5 only the candidate with demonstrated utility is promoted; the other keeps its decision record", async () => {
    const items: CandidateInput[] = [
      { content: "high score, never recalled", recalls: 0, uniqueQueries: 0, score: 0.97 },
      { content: "durable fact", recalls: 3, uniqueQueries: 3, score: 0.8 },
    ];
    const h = mkHarness({ over: { candidates: pool(items) } });
    h.captures("bernd", 3);
    const run = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(run.outcome, "completed");
    assert.equal(run.counts.promoted, 1); assert.equal(run.counts.rejected, 1); assert.equal(run.counts.candidates, 2);
    const all = h.store.listCandidates("bernd");
    const rejected = all.find((c) => c.contentHash === contentHash("high score, never recalled"))!;
    assert.equal(rejected.state, "shortlisted");
    assert.equal((rejected.decision as { rejectedBy: string }).rejectedBy, "utility");
    const promoted = all.find((c) => c.contentHash === contentHash("durable fact"))!;
    assert.equal(promoted.state, "promoted");
    assert.ok((promoted.decision as { gates: { passed: boolean }[] }).gates.every((g) => g.passed));
  });

  it("with only unfit candidates a deep run records skipped/no_candidates instead of doing nothing quietly", async () => {
    const h = mkHarness({ over: { candidates: pool([{ content: "x", recalls: 0 }]) } });
    h.captures("bernd", 3);
    const run = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(run.outcome, "skipped"); assert.equal(run.reason, "no_candidates");
    assert.equal(h.engine.callsOf("consolidate-daily"), 0);
  });

  it("dedupes by content hash per agent and partition, and refreshes the recall signals of a known candidate", async () => {
    let items: CandidateInput[] = [{ content: "same", recalls: 1, uniqueQueries: 1 }];
    const h = mkHarness({ over: { candidates: { pull: () => items } } });
    h.captures("bernd", 3);
    const first = await h.sched.runPhase("bernd", "light", { trigger: "manual" });
    assert.equal(first.counts.candidates, 1);
    items = [{ content: "same", recalls: 4, uniqueQueries: 3, score: 0.9 }, { content: "same", partition: "workspace" }];
    h.captures("bernd", 1);
    const second = await h.sched.runPhase("bernd", "light", { trigger: "manual" });
    assert.equal(second.counts.deduped, 1); assert.equal(second.counts.candidates, 1, "the other partition is a distinct candidate");
    const mine = h.store.listCandidates("bernd").find((c) => c.partition === "agent-private")!;
    assert.equal(mine.recalls, 4);
    assert.equal(h.store.listCandidates("bernd").length, 2);
  });

  it("expires stale candidates after 72 h: ineligible regardless of score", async () => {
    const h = mkHarness({ over: { candidates: { pull: () => [] } } });
    h.store.insertCandidate({ candidateId: "c1", agentId: "bernd", partition: "agent-private", contentHash: contentHash("old"), sourceRunId: "r0", firstSeenAt: 0, expiresAt: 72 * HOUR + 1, recalls: 9, uniqueQueries: 9, score: 1 });
    h.sched.syncAgents();
    await h.clock.advance(73 * HOUR); h.captures("bernd", 3);
    const run = await h.sched.runPhase("bernd", "deep", { trigger: "manual" });
    assert.equal(run.counts.expired, 1);
    assert.equal(run.reason, "no_candidates");
    assert.equal(h.store.listCandidates("bernd")[0]!.state, "expired");
  });
});
