import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriceBook, costMicros, type PriceTable } from "../../src/budget/prices.ts";

const T1: PriceTable = { version: "t1", effectiveFrom: Date.UTC(2026, 0, 1), models: { "m-a": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, "p/m-b": { input: 1, output: 2 } } };
const T2: PriceTable = { version: "t2", effectiveFrom: Date.UTC(2026, 6, 1), models: { "m-a": { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 } } };

describe("PriceBook", () => {
  it("picks the newest table effective at the event's time, not at now", () => {
    const b = new PriceBook([T2, T1]);
    assert.equal(b.at(Date.UTC(2026, 5, 30))?.version, "t1");
    assert.equal(b.at(Date.UTC(2026, 6, 1))?.version, "t2");
    assert.equal(b.at(Date.UTC(2025, 0, 1)), null);
    assert.equal(b.latest().version, "t2");
  });

  it("refuses duplicate versions and an empty book", () => {
    assert.throws(() => new PriceBook([T1, { ...T1 }]), /duplicate/);
    assert.throws(() => new PriceBook([]), /at least one/);
  });

  it("cost in integer micro-USD (USD per million tokens x tokens)", () => {
    const u = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 };
    assert.equal(costMicros(T1, "m-a", undefined, u), 3 * 1000 + 15 * 500 + Math.round(0.3 * 2000) + Math.round(3.75 * 100));
    assert.ok(Number.isInteger(costMicros(T1, "m-a", undefined, u)!));
  });

  it("looks up provider/model before the bare model; unknown model is unpriced (null)", () => {
    const u = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.equal(costMicros(T1, "m-b", "p", u), 30);
    assert.equal(costMicros(T1, "m-b", undefined, u), null);
    assert.equal(costMicros(T1, "nope", "p", u), null);
  });

  it("a missing cache price with cache tokens present is unpriced rather than free", () => {
    const u = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 };
    assert.equal(costMicros(T1, "p/m-b".split("/")[1]!, "p", u), null);
    assert.equal(costMicros(T1, "m-b", "p", { ...u, cacheReadTokens: 0 }), 30);
  });
});
