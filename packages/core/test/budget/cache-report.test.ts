import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BudgetInputError, type UsageEvent } from "../../src/budget/service.ts";
import { open } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 6, 12);
const SINCE = NOW - 1000;
let n = 0;
const ev = (e: Partial<UsageEvent> & Pick<UsageEvent, "agent" | "model" | "inputTokens">): UsageEvent =>
  ({ outputTokens: 10, ts: SINCE + 10, requestId: `r-${n++}`, ...e });

describe("cache usage read model (D120 H2-1)", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });
  const mk = () => { const r = open(); closers.push(() => r.svc.close()); return r.svc; };

  it("groups by provider, agent and model with hand-computed sums, ordered", () => {
    const svc = mk();
    svc.recordUsage(ev({ agent: "bernd", model: "m-b", provider: "p-b", inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100 }));
    svc.recordUsage(ev({ agent: "bernd", model: "m-b", provider: "p-b", inputTokens: 1000, cacheReadTokens: 800 }));
    svc.recordUsage(ev({ agent: "bernd", model: "m-b", provider: "p-b", inputTokens: 500 }));
    svc.recordUsage(ev({ agent: "anna", model: "m-b", provider: "p-b", inputTokens: 200 }));
    svc.recordUsage(ev({ agent: "bernd", model: "m-a", provider: "p-b", inputTokens: 300 }));
    svc.recordUsage(ev({ agent: "bernd", model: "m-b", provider: "p-a", inputTokens: 400 }));
    const rows = svc.cacheUsage({ since: SINCE, until: NOW });
    assert.deepEqual(rows.map((r) => [r.provider, r.agentId, r.model]),
      [["p-a", "bernd", "m-b"], ["p-b", "anna", "m-b"], ["p-b", "bernd", "m-a"], ["p-b", "bernd", "m-b"]]);
    assert.deepEqual(rows[3], { provider: "p-b", agentId: "bernd", model: "m-b", calls: 3, uncachedCalls: 1, inputTokens: 2500, outputTokens: 30,
      cacheReadTokens: 1400, cacheWriteTokens: 100, cachingInputTokens: 2000, hitRatio: 1400 / 2500, hitRatioCaching: 0.7 });
  });
  it("includes ts === since and excludes ts === until", () => {
    const svc = mk();
    svc.recordUsage(ev({ agent: "a", model: "m", inputTokens: 10, ts: SINCE }));
    svc.recordUsage(ev({ agent: "a", model: "m", inputTokens: 20, ts: NOW }));
    const rows = svc.cacheUsage({ since: SINCE, until: NOW });
    assert.equal(rows.length, 1); assert.equal(rows[0]!.inputTokens, 10);
  });
  it("filters by agent", () => {
    const svc = mk();
    svc.recordUsage(ev({ agent: "a", model: "m", inputTokens: 10 }));
    svc.recordUsage(ev({ agent: "b", model: "m", inputTokens: 10 }));
    assert.deepEqual(svc.cacheUsage({ since: SINCE, until: NOW, agentId: "b" }).map((r) => r.agentId), ["b"]);
  });
  it("handles empty windows, zero input and reads above input", () => {
    const svc = mk();
    assert.deepEqual(svc.cacheUsage({ since: SINCE, until: NOW }), []);
    svc.recordUsage(ev({ agent: "z", model: "m", inputTokens: 0, outputTokens: 5 }));
    svc.recordUsage(ev({ agent: "c", model: "m", inputTokens: 100, cacheReadTokens: 300 }));
    const rows = svc.cacheUsage({ since: SINCE, until: NOW });
    assert.equal(rows.find((r) => r.agentId === "z")!.hitRatio, 0);
    assert.equal(rows.find((r) => r.agentId === "c")!.hitRatio, 1);
    assert.equal(rows.find((r) => r.agentId === "c")!.hitRatioCaching, 1);
  });
  it("rejects an invalid agentId", () => {
    const svc = mk();
    assert.throws(() => svc.cacheUsage({ since: SINCE, until: NOW, agentId: "bad id!" }), BudgetInputError);
  });
  it("rejects invalid bounds", () => {
    const svc = mk();
    for (const q of [{ since: NOW, until: SINCE }, { since: -1, until: NOW }, { since: 1.5, until: NOW }, { since: SINCE, until: Number.NaN }]) {
      assert.throws(() => svc.cacheUsage(q), BudgetInputError);
    }
  });
});
