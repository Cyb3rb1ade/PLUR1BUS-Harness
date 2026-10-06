import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BudgetExceededError, BudgetInputError } from "../../src/budget/service.ts";
import { Clock, open, PRICES_V1, PRICES_V2 } from "./helpers.ts";

const usd = (n: number) => Math.round(n * 1_000_000);
const call = (svc: ReturnType<typeof open>["svc"], agent: string, inTok: number, outTok = 0, model = "m-small") => svc.recordUsage({ agent, model, inputTokens: inTok, outputTokens: outTok });

describe("limits", () => {
  it("soft warns (once per period), hard refuses with a clear error, resets next day", () => {
    const { svc, clock, events } = open();
    svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", soft: 1000, hard: 2000 });

    assert.deepEqual(svc.check("a1", "m-small", { inputTokens: 500 }), { allowed: true, breaches: [], warnings: [] });
    call(svc, "a1", 900);
    const d = svc.check("a1", "m-small", { inputTokens: 200 }); // 900 + 200 = 1100 > soft
    assert.equal(d.allowed, true);
    assert.equal(d.warnings.length, 1);
    assert.equal(d.warnings[0]!.notified, true);
    assert.deepEqual(events.map((e) => [e.kind, e.agentId, e.limit]), [["budget.soft", "a1", 1000]]);
    const d2 = svc.check("a1", "m-small", { inputTokens: 200 });
    assert.equal(d2.warnings[0]!.notified, false); // same period: not re-notified
    assert.equal(events.length, 1);

    call(svc, "a1", 1000); // 1900 used
    assert.throws(() => svc.enforce("a1", "m-small", { inputTokens: 200 }), (e: unknown) => {
      assert.ok(e instanceof BudgetExceededError);
      assert.match(e.message, /agent a1 daily tokens hard limit 2000 tokens would be exceeded \(used 1900 tokens/);
      assert.equal(e.decision.breaches[0]!.kind, "hard");
      assert.equal(e.decision.breaches[0]!.resetsAt, Date.UTC(2026, 9, 7));
      return true;
    });
    assert.equal(svc.check("a1", "m-small", { inputTokens: 100 }).allowed, true); // lands exactly on the limit: allowed

    clock.set(Date.UTC(2026, 9, 7, 0, 0, 0)); // the next UTC day: reset
    assert.equal(svc.check("a1", "m-small", { inputTokens: 1500 }).breaches.length, 0);
    const d3 = svc.check("a1", "m-small", { inputTokens: 1500 }); // soft again, new period => notified again
    assert.equal(d3.warnings.length, 1);
    assert.equal(d3.warnings[0]!.notified, false);
    assert.equal(events.length, 2);
  });

  it("a refused call does not notify", () => {
    const { svc, events } = open();
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", soft: 10, hard: 100 });
    svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", hard: 50 });
    const d = svc.check("a1", "m-small", { inputTokens: 60 });
    assert.equal(d.allowed, false);
    assert.equal(events.length, 0);
  });

  it("agent and global limits both apply; one agent's usage does not count against another agent's own limit", () => {
    const { svc } = open();
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 1000 });
    svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", hard: 600 });
    call(svc, "a1", 500); call(svc, "a2", 400); // global 900
    assert.deepEqual(svc.check("a1", "m-small", { inputTokens: 150 }).breaches.map((b) => b.scope), ["agent", "global"]); // 650 > 600, 1050 > 1000
    assert.deepEqual(svc.check("a1", "m-small", { inputTokens: 100 }).breaches.map((b) => b.scope), []); // exactly on both limits
    assert.deepEqual(svc.check("a2", "m-small", { inputTokens: 150 }).breaches.map((b) => b.scope), ["global"]); // a2 has no limit of its own
    assert.equal(svc.check("a2", "m-small", { inputTokens: 100 }).allowed, true);
  });

  it("cost limits use the price table; an unpriced model under a hard cost limit is refused", () => {
    const { svc } = open();
    svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "cost", soft: usd(0.5), hard: usd(1) });
    // m-large: 10 USD/M in, 50 USD/M out. 60k in = 0.60 USD.
    call(svc, "a1", 60_000, 0, "m-large");
    const warn = svc.check("a1", "m-large", { inputTokens: 10_000 }); // 0.70 > soft 0.50
    assert.equal(warn.allowed, true);
    assert.equal(warn.warnings.length, 1);
    const refuse = svc.check("a1", "m-large", { inputTokens: 10_000, outputTokens: 10_000 }); // 0.60 + 0.10 + 0.50 > 1.00
    assert.equal(refuse.allowed, false);
    assert.match(refuse.breaches[0]!.kind, /hard/);
    const unpriced = svc.check("a1", "mystery", { inputTokens: 1 });
    assert.equal(unpriced.allowed, false);
    assert.equal(unpriced.breaches[0]!.kind, "unpriced-model");
    assert.match(new BudgetExceededError(unpriced, "a1", "mystery").message, /no price/);
    // token limits don't care about prices
    svc.setLimit({ scope: "agent", agentId: "a3", period: "day", metric: "tokens", hard: 10 });
    assert.equal(svc.check("a3", "mystery", { inputTokens: 1 }).allowed, true);
    // a soft-only cost limit cannot be evaluated for an unpriced model, and does not refuse
    svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "cost", hard: null, soft: usd(0.5) });
    assert.equal(svc.check("a1", "mystery", { inputTokens: 1 }).allowed, true);
  });

  it("recording usage that crosses a limit emits the soft and the hard event once", () => {
    const { svc, events } = open();
    svc.setLimit({ scope: "agent", agentId: "a1", period: "month", metric: "tokens", soft: 100, hard: 200 });
    call(svc, "a1", 50);
    assert.equal(events.length, 0);
    call(svc, "a1", 60); // 110 > soft
    call(svc, "a1", 10);
    call(svc, "a1", 100); // 220 > hard
    call(svc, "a1", 100);
    assert.deepEqual(events.map((e) => e.kind), ["budget.soft", "budget.hard"]);
  });

  it("the month period resets on the first of the next month, in the configured zone", () => {
    const clock = new Clock(Date.UTC(2026, 9, 31, 21, 0)); // 22:00 CET on 31 Oct? CET is +1 after the DST end on 25 Oct
    const { svc } = open({ clock, tz: "Europe/Berlin" });
    svc.setLimit({ scope: "global", period: "month", metric: "tokens", hard: 100 });
    call(svc, "a1", 100);
    assert.equal(svc.check("a1", "m-small", { inputTokens: 1 }).allowed, false);
    clock.set(Date.UTC(2026, 9, 31, 22, 59, 59, 999)); // 23:59:59.999 local: still October
    assert.equal(svc.check("a1", "m-small", { inputTokens: 1 }).allowed, false);
    clock.set(Date.UTC(2026, 9, 31, 23, 0, 0)); // 00:00 local on 1 Nov
    assert.equal(svc.check("a1", "m-small", { inputTokens: 1 }).allowed, true);
    assert.equal(svc.status().periods[1]!.key, "2026-11");
  });

  it("changing the time zone re-buckets the same history", () => {
    const clock = new Clock(Date.UTC(2026, 9, 6, 23, 30));
    const { svc } = open({ clock });
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 100 });
    call(svc, "a1", 100); // 23:30 UTC on the 6th
    clock.set(Date.UTC(2026, 9, 7, 0, 30)); // 00:30 UTC on the 7th: a new UTC day...
    assert.equal(svc.check("a1", "m-small", { inputTokens: 1 }).allowed, true);
    svc.setTimeZone("Europe/Berlin"); // ...but 02:30 on the 7th is the same Berlin day? No: 23:30Z = 01:30 on the 7th Berlin
    assert.equal(svc.check("a1", "m-small", { inputTokens: 1 }).allowed, false);
    assert.equal(svc.timeZone(), "Europe/Berlin");
    assert.throws(() => svc.setTimeZone("Nowhere/Land"), /time zone/);
  });

  it("price versioning: old events keep the price they were recorded with", () => {
    const clock = new Clock(Date.UTC(2026, 9, 9, 12)); // before v2 is effective
    const { svc } = open({ clock, tables: [PRICES_V1, PRICES_V2] });
    const a = call(svc, "a1", 1_000_000);
    assert.deepEqual([a.priceVersion, a.costMicros], ["v1", 1_000_000]);
    clock.set(Date.UTC(2026, 9, 10, 12)); // v2 in force: m-small input is 2 USD/M
    const b = call(svc, "a1", 1_000_000);
    assert.deepEqual([b.priceVersion, b.costMicros], ["v2", 2_000_000]);
    // an event stamped before the change is still priced with the table in force at its own time
    const late = svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1_000_000, outputTokens: 0, ts: Date.UTC(2026, 9, 9, 13) });
    assert.deepEqual([late.priceVersion, late.costMicros], ["v1", 1_000_000]);
    assert.equal(svc.status().periods[1]!.total.costMicros, 4_000_000);
    assert.equal(svc.status().priceVersion, "v2");
  });

  it("setLimit merges bounds, clears with null, validates", () => {
    const { svc } = open();
    assert.deepEqual(svc.setLimit({ scope: "global", period: "day", metric: "cost", soft: 5 }), { scope: "global", period: "day", metric: "cost", soft: 5, hard: null });
    assert.deepEqual(svc.setLimit({ scope: "global", period: "day", metric: "cost", hard: 9 }), { scope: "global", period: "day", metric: "cost", soft: 5, hard: 9 });
    assert.throws(() => svc.setLimit({ scope: "global", period: "day", metric: "cost", soft: 10 }), /soft limit must not exceed/);
    assert.throws(() => svc.setLimit({ scope: "agent", period: "day", metric: "cost", hard: 1 }), BudgetInputError);
    assert.throws(() => svc.setLimit({ scope: "global", agentId: "a1", period: "day", metric: "cost", hard: 1 }), BudgetInputError);
    assert.throws(() => svc.setLimit({ scope: "global", period: "week" as never, metric: "cost", hard: 1 }), BudgetInputError);
    assert.throws(() => svc.setLimit({ scope: "global", period: "day", metric: "cost", hard: -1 }), BudgetInputError);
    assert.equal(svc.setLimit({ scope: "global", period: "day", metric: "cost", soft: null, hard: null }), null);
    assert.deepEqual(svc.limits(), []);
  });

  it("status reports used and state per limit", () => {
    const { svc } = open();
    svc.setLimit({ scope: "agent", agentId: "a1", period: "day", metric: "tokens", soft: 100, hard: 200 });
    call(svc, "a1", 100);
    assert.equal(svc.status().limits[0]!.state, "soft");
    call(svc, "a1", 100);
    const l = svc.status().limits[0]!;
    assert.deepEqual([l.used, l.state], [200, "hard"]);
  });
});
