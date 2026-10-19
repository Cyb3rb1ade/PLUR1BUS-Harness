// Pure logic of the Usage & Quota page: tolerant parsing, limit state at the boundaries, amounts, set-params.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSetParams, groupLimits, limitView, normalizeStatus, parseAmount } from "../src/pages/budget/model.ts";

const lim = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ scope: "global", period: "day", metric: "tokens", soft: 5_000_000, hard: 10_000_000, used: 0, state: "ok", ...o });

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
  test("limits come out in a stable order whatever the server sends; a cost limit (no money dimension any more) is not shown", () => {
    const a = groupLimits(normalizeStatus({ limits: [lim({ period: "month" }), lim({ period: "month", metric: "cost" }), lim({ scope: "agent", agentId: "b" }), lim({ period: "day" }), lim({ scope: "agent", agentId: "a" })] }).limits);
    assert.deepEqual(a.global.map((l) => `${l.period}/${l.metric}`), ["day/tokens", "month/tokens"]);
    assert.deepEqual(a.agents.map((l) => l.agentId), ["a", "b"]);
  });
  test("periods keep agents and models", () => {
    const u = { events: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const s = normalizeStatus({ timeZone: "UTC", now: "2026-10-07T00:00:00Z", periods: [{ period: "day", key: "2026-10-07", total: { ...u, costMicros: 1500 }, agents: [{ agentId: "main", total: u, models: [{ model: "m", ...u }] }] }], limits: [] });
    assert.equal(s.periods[0]!.agents[0]!.models[0]!.model, "m"); assert.deepEqual(s.periods[0]!.total, u); // a stray money field is dropped
  });
});

describe("amounts", () => {
  test("tokens: whole non-negative numbers; blank means none; a dollar amount is not a token count", () => {
    assert.equal(parseAmount("1000"), 1000);
    assert.equal(parseAmount(" 0 "), 0);
    assert.equal(parseAmount(""), null);
    for (const bad of ["1.5", "-2", "1,000", "99999999999999999999", "$5", "0,25"]) assert.equal(parseAmount(bad), "invalid", bad);
  });
});

describe("buildSetParams", () => {
  const key = { scope: "agent" as const, agentId: "main", period: "day" as const, metric: "tokens" as const };
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
