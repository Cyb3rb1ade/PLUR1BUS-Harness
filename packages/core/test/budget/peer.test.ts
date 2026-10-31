import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { PeerCallBudget } from "../../src/budget/peer.ts";

const identity = { person: "person", agent: "main", session: "session", turn: "turn", peer: "peer" };
const limits = { peerCalls: 2, turnCalls: 3, peerTokens: 100, turnTokens: 150 };
function fixture() {
  const path = join(tempDir("a2a-peer-budget-"), "budget.sqlite");
  return { path, budget: new PeerCallBudget({ path, now: () => 123 }) };
}

describe("A2A peer/turn budgets", () => {
  it("reserves capacity before a call and settles accepted token counts once", () => {
    const { budget } = fixture();
    try {
      const first = budget.reserve(identity, 70, limits);
      assert.equal(first.kind, "allow");
      assert.equal(budget.reserve(identity, 40, limits).kind, "refuse");
      if (first.kind !== "allow") assert.fail();
      budget.finish(first.id, 30);
      budget.finish(first.id, 30);
      assert.equal(budget.reserve(identity, 70, limits).kind, "allow");
      assert.equal(budget.reserve(identity, 0, limits).kind, "refuse", "two admitted calls exhaust the per-peer call cap");
    } finally { budget.close(); }
  });

  it("applies both peer and shared-turn ceilings without crossing person or turn identities", () => {
    const { budget } = fixture();
    try {
      assert.equal(budget.reserve(identity, 80, limits).kind, "allow");
      assert.equal(budget.reserve({ ...identity, peer: "other" }, 80, limits).kind, "refuse");
      assert.equal(budget.reserve({ ...identity, peer: "other" }, 70, limits).kind, "allow");
      assert.equal(budget.reserve({ ...identity, agent: "another-agent", peer: "third" }, 1, limits).kind, "refuse", "helpers cannot reset the shared turn budget");
      assert.equal(budget.reserve({ ...identity, person: "another" }, 80, limits).kind, "allow");
      assert.equal(budget.reserve({ ...identity, turn: "next" }, 80, limits).kind, "allow");
    } finally { budget.close(); }
  });

  it("persists reservations across connections and only refunds proven unused requests", () => {
    const { path, budget } = fixture();
    const first = budget.reserve(identity, 100, limits);
    assert.equal(first.kind, "allow");
    budget.close();
    const reopened = new PeerCallBudget({ path, now: () => 456 });
    try {
      assert.equal(reopened.reserve(identity, 1, limits).kind, "refuse");
      if (first.kind !== "allow") assert.fail();
      reopened.cancel(first.id);
      assert.equal(reopened.reserve(identity, 100, limits).kind, "allow");
    } finally { reopened.close(); }
  });

  it("refuses invalid identities, fractions and settlement beyond reserved capacity", () => {
    const { budget } = fixture();
    try {
      assert.throws(() => budget.reserve({ ...identity, turn: "" }, 0, limits), /invalid peer budget input/);
      assert.throws(() => budget.reserve(identity, -1, limits), /invalid peer budget input/);
      assert.throws(() => budget.reserve(identity, 0.5, limits), /invalid peer budget input/);
      const accepted = budget.reserve(identity, 20, limits);
      if (accepted.kind !== "allow") assert.fail();
      assert.throws(() => budget.finish(accepted.id, 21), /invalid peer budget input/);
      assert.equal(budget.reserve(identity, 81, limits).kind, "refuse");
    } finally { budget.close(); }
  });

  it("serializes reservations from independent database connections", () => {
    const { path, budget } = fixture();
    const other = new PeerCallBudget({ path, now: () => 123 });
    try {
      assert.equal(budget.reserve(identity, 80, limits).kind, "allow");
      assert.equal(other.reserve(identity, 21, limits).kind, "refuse");
      assert.equal(other.reserve(identity, 20, limits).kind, "allow");
      assert.equal(budget.reserve(identity, 0, limits).kind, "refuse");
    } finally { other.close(); budget.close(); }
  });
});
