import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "./helpers.ts";

describe("budget status token breakdown", () => {
  it("preserves raw counts and separates fresh input from weighted totals at every level", () => {
    const { svc } = open();
    try {
      svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 });
      for (const [weight, counted] of [[1, 1100], [0.1, 290], [0, 200]] as const) {
        svc.setCacheReadWeight(weight);
        const status = svc.status();
        assert.equal(status.cacheReadWeight, weight);
        for (const period of status.periods) {
          const agent = period.agents[0]!;
          for (const total of [period.total, agent.total, agent.models[0]!]) {
            assert.deepEqual(
              [total.inputTokens, total.freshInputTokens, total.cacheReadTokens, total.cacheWriteTokens, total.outputTokens, total.countedTokens],
              [1000, 50, 900, 50, 100, counted],
            );
          }
        }
      }
      const empty = svc.status({ agentId: "nobody" });
      assert.deepEqual(empty.periods[0]!.agents, []);
      assert.equal(empty.periods[0]!.total.freshInputTokens, 0);
      assert.equal(empty.periods[0]!.total.countedTokens, 0);
    } finally { svc.close(); }
  });

  it("rounds once per aggregate rather than adding rounded model totals", () => {
    const { svc } = open();
    try {
      for (const model of ["m-small", "m-large"]) {
        svc.recordUsage({ agent: "a1", model, inputTokens: 1, outputTokens: 0, cacheReadTokens: 1 });
      }
      svc.recordUsage({ agent: "a2", model: "m-small", inputTokens: 10, outputTokens: 2 });
      svc.setCacheReadWeight(0.1);
      const day = svc.status().periods[0]!;
      assert.equal(day.total.countedTokens, 13);
      assert.equal(day.agents[0]!.total.countedTokens, 1);
      assert.deepEqual(day.agents[0]!.models.map(m => m.countedTokens), [1, 1]);
      assert.equal(svc.status({ agentId: "a1" }).periods[0]!.total.countedTokens, 1);
    } finally { svc.close(); }
  });

  it("clamps fresh input per event without losing an unrelated event's fresh tokens", () => {
    const { svc } = open();
    try {
      svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 10, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 5 });
      svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 20, outputTokens: 2 });
      svc.setCacheReadWeight(0);
      const total = svc.status().periods[0]!.total;
      assert.deepEqual(
        [total.inputTokens, total.freshInputTokens, total.cacheReadTokens, total.cacheWriteTokens, total.outputTokens, total.countedTokens],
        [30, 20, 30, 5, 3, 23],
      );
    } finally { svc.close(); }
  });

  it("persists combined settings and rolls back an invalid update after staging writes", () => {
    const { svc, dir, clock } = open();
    svc.updateSettings({ timeZone: "Europe/Berlin", cacheReadWeight: 0, limit: { scope: "global", period: "day", metric: "tokens", hard: 123 } });
    const before = svc.status();
    assert.throws(() => svc.updateSettings({ timeZone: "UTC", cacheReadWeight: NaN, limit: { scope: "global", period: "day", metric: "tokens", hard: 456 } }), RangeError);
    assert.deepEqual(svc.status(), before);
    svc.close();
    const reopened = open({ dir, clock });
    try {
      assert.equal(reopened.svc.cacheReadWeight(), 0);
      assert.equal(reopened.svc.timeZone(), "Europe/Berlin");
      assert.equal(reopened.svc.limits()[0]!.hard, 123);
    } finally { reopened.svc.close(); }
  });
});
