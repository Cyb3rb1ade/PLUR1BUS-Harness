// Pure logic of the Usage & Quota page: tolerant parsing, limit state at the boundaries, amounts, set-params.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSetParams, groupLimits, limitView, microsToInput, normalizeStatus, parseAmount } from "../src/pages/budget/model.ts";

const lim = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ scope: "global", period: "day", metric: "cost", soft: 5_000_000, hard: 10_000_000, used: 0, state: "ok", ...o });

describe("limitView", () => {
  const view = (o: Record<string, unknown>) => limitView(normalizeStatus({ limits: [lim(o)] }).limits[0]!);
  test("the server's state wins; the bar runs against the hard limit, or the soft one when there is no hard", () => {
    assert.deepEqual([view({ used: 1_000_000 }).status, view({ used: 1_000_000 }).bound, view({ used: 1_000_000 }).percent], ["ok", 10_000_000, 10]);
    assert.equal(view({ used: 6_000_000, state: "soft" }).status, "warn");
    assert.equal(view({ used: 10_000_000, state: "hard" }).status, "exceeded");
    assert.equal(view({ hard: null, used: 1_000_000 }).bound, 5_000_000);
  });
  test("over the limit: percent above 100, bar value capped", () => {
    const v = view({ used: 15_000_000, state: "hard" });
    assert.equal(v.percent, 150); assert.equal(v.barValue, v.bound);
  });
  test("a missing or unknown state is derived at the boundaries: soft is reached AT the bound, hard too", () => {
    assert.equal(view({ used: 4_999_999, state: undefined }).status, "ok");
    assert.equal(view({ used: 5_000_000, state: "weird" }).status, "warn");
    assert.equal(view({ used: 9_999_999, state: undefined }).status, "warn");
    assert.equal(view({ used: 10_000_000, state: undefined }).status, "exceeded");
  });
  test("no bound at all: no bar, state ok; a zero bound has no bar either but is exceeded once used", () => {
    const none = view({ soft: null, hard: null, used: 7 });
    assert.deepEqual([none.bound, none.status], [null, "ok"]);
    const zero = view({ soft: null, hard: 0, used: 1, state: undefined });
    assert.deepEqual([zero.bound, zero.status], [0, "exceeded"]);
  });
});

describe("normalizeStatus and groups", () => {
  test("garbage gives an empty status; unknown scopes land in 'other'; negative or fractional numbers are dropped to 0", () => {
    assert.deepEqual(normalizeStatus(null).limits, []);
    const s = normalizeStatus({ limits: [lim(), lim({ scope: "agent", agentId: "a" }), lim({ scope: "project", agentId: "p" }), lim({ scope: "agent" }), { nope: 1 }, lim({ used: -4 })] });
    const g = groupLimits(s.limits);
    assert.equal(g.global.length, 2); assert.equal(g.agents.length, 1); assert.equal(g.other.length, 1);
    assert.equal(g.global[1]!.used, 0);
  });
  test("limits come out in a stable order whatever the server sends", () => {
    const a = groupLimits(normalizeStatus({ limits: [lim({ period: "month", metric: "tokens" }), lim({ period: "month", metric: "cost" }), lim({ period: "day", metric: "tokens" }), lim({ period: "day", metric: "cost" })] }).limits).global;
    assert.deepEqual(a.map((l) => `${l.period}/${l.metric}`), ["day/cost", "day/tokens", "month/cost", "month/tokens"]);
  });
  test("periods keep agents and models", () => {
    const u = { events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 1500, unpricedEvents: 1 };
    const s = normalizeStatus({ timeZone: "UTC", priceVersion: "v1", now: "2026-10-07T00:00:00Z", periods: [{ period: "day", key: "2026-10-07", total: u, agents: [{ agentId: "main", total: u, models: [{ model: "m", ...u }] }] }], limits: [] });
    assert.equal(s.periods[0]!.agents[0]!.models[0]!.model, "m"); assert.equal(s.periods[0]!.total.unpricedEvents, 1);
  });
});

describe("amounts", () => {
  test("cost: dollars with up to 6 decimals to micro-USD, comma or dot, no float drift", () => {
    assert.equal(parseAmount("cost", "5"), 5_000_000);
    assert.equal(parseAmount("cost", "0,25"), 250_000);
    assert.equal(parseAmount("cost", "0.1"), 100_000);
    assert.equal(parseAmount("cost", "1.000001"), 1_000_001);
    for (const bad of ["-1", "1.0000001", "abc", "1e3", "$5"]) assert.equal(parseAmount("cost", bad), "invalid", bad);
  });
  test("tokens: whole non-negative numbers; blank means none", () => {
    assert.equal(parseAmount("tokens", "1000"), 1000);
    assert.equal(parseAmount("tokens", " 0 "), 0);
    assert.equal(parseAmount("tokens", ""), null);
    for (const bad of ["1.5", "-2", "1,000", "99999999999999999999"]) assert.equal(parseAmount("tokens", bad), "invalid", bad);
  });
  test("micros back to an input string", () => { assert.equal(microsToInput(5_000_000), "5"); assert.equal(microsToInput(250_000), "0.25"); assert.equal(microsToInput(1_000_001), "1.000001"); });
});

describe("buildSetParams", () => {
  const key = { scope: "agent" as const, agentId: "main", period: "day" as const, metric: "cost" as const };
  test("a new limit leaves empty bounds out", () => {
    assert.deepEqual(buildSetParams(key, { soft: null, hard: 100 }, null), { limit: { ...key, hard: 100 } });
  });
  test("editing: an emptied bound that was set is cleared with null, an untouched empty one stays out", () => {
    assert.deepEqual(buildSetParams(key, { soft: null, hard: 100 }, { soft: 5, hard: 50 }), { limit: { ...key, soft: null, hard: 100 } });
    assert.deepEqual(buildSetParams(key, { soft: 7, hard: null }, { soft: null, hard: null }), { limit: { ...key, soft: 7 } });
  });
  test("global limits carry no agentId; remove clears both", () => {
    assert.deepEqual(buildSetParams({ scope: "global", period: "month", metric: "tokens" }, { soft: null, hard: null }, { soft: 1, hard: 2 }), { limit: { scope: "global", period: "month", metric: "tokens", soft: null, hard: null } });
  });
});
