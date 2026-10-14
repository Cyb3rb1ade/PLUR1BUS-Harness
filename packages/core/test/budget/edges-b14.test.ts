// b14: coverage for edges the earlier suites did not pin down (zones, thresholds, rollover).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallBudget } from "../../src/budget/calls.ts";
import { periodBounds } from "../../src/budget/period.ts";
import { PriceBook } from "../../src/budget/prices.ts";
import { open, PRICES_V1 } from "./helpers.ts";

describe("periodBounds: unusual zones", () => {
  it("a day that never happened (Pacific/Apia skipped 30 Dec 2011) neither loops nor leaves a gap", () => {
    const before = periodBounds(Date.UTC(2011, 11, 29, 12), "Pacific/Apia", "day");
    const after = periodBounds(Date.UTC(2011, 11, 30, 12), "Pacific/Apia", "day");
    assert.equal(before.key, "2011-12-29");
    assert.equal(after.key, "2011-12-31");
    assert.equal(before.end, after.start); // consecutive periods share their boundary
    assert.equal(before.end - before.start, 24 * 3_600_000); // the calendar skips a date, the clock does not skip time
  });
  it("a half-hour DST shift (Australia/Lord_Howe) gives a 23.5 h day", () => {
    const b = periodBounds(Date.UTC(2026, 9, 3, 20), "Australia/Lord_Howe", "day"); // DST starts 4 Oct 2026, 02:00 -> 02:30
    assert.equal(b.key, "2026-10-04");
    assert.equal(b.end - b.start, 23.5 * 3_600_000);
  });
  it("+14:00 (Pacific/Kiritimati) and -12:00 (Etc/GMT+12) put the same instant on different days", () => {
    const ts = Date.UTC(2026, 5, 15, 11);
    assert.equal(periodBounds(ts, "Pacific/Kiritimati", "day").key, "2026-06-16");
    assert.equal(periodBounds(ts, "Etc/GMT+12", "day").key, "2026-06-14");
  });
  it("the last millisecond of a local day belongs to it, the next one to the next day", () => {
    const b = periodBounds(Date.UTC(2026, 9, 6, 12), "Europe/Berlin", "day");
    assert.equal(periodBounds(b.end - 1, "Europe/Berlin", "day").key, "2026-10-06");
    assert.equal(periodBounds(b.end, "Europe/Berlin", "day").key, "2026-10-07");
  });
});

describe("call budget: thresholds and rollover", () => {
  const request = { principal: "u1", project: "p1", agent: "a1", model: "m-small", estimatedInputTokens: 30, maxOutputTokens: 10 };
  function fixture() {
    const f = open();
    const events: { type: string }[] = [];
    const gate = createCallBudget({ path: f.path, clock: f.clock, prices: new PriceBook([PRICES_V1]), emitter: { emit: (e) => events.push(e) } });
    return { ...f, gate, events, close() { gate.close(); f.svc.close(); } };
  }

  it("a token ceiling of exactly the estimate admits one call and refuses the next, whatever its size", () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: "agent", id: "a1", period: "day", metric: "tokens", hard: 40 });
      assert.equal(f.gate.checkBeforeCall(request).kind, "allow");
      const second = f.gate.checkBeforeCall({ ...request, estimatedInputTokens: 0, maxOutputTokens: 1 });
      assert.equal(second.kind, "refuse");
      assert.equal(f.gate.checkBeforeCall({ ...request, estimatedInputTokens: 0, maxOutputTokens: 0 }).kind, "allow"); // zero fits at exactly the ceiling
    } finally { f.close(); }
  });

  it("a cost ceiling lands exactly: 30*1 + 10*5 = 80 micro-USD fits a ceiling of 80, not 79", () => {
    const f = fixture();
    try {
      f.gate.setLimit({ scope: "global", id: "", period: "day", metric: "cost", hard: 79 });
      const refused = f.gate.checkBeforeCall(request);
      assert.equal(refused.kind, "refuse");
      f.gate.setLimit({ scope: "global", id: "", period: "day", metric: "cost", hard: 80 });
      const d = f.gate.checkBeforeCall(request);
      assert.equal(d.kind, "allow");
      if (d.kind === "allow") assert.equal(d.estimatedCostMicros, 80);
    } finally { f.close(); }
  });

  it("a reservation made before midnight still holds capacity after the day rolls over", () => {
    const f = fixture();
    try {
      f.clock.set(Date.UTC(2026, 9, 6, 23, 59, 59));
      f.gate.setLimit({ scope: "agent", id: "a1", period: "day", metric: "tokens", hard: 40 });
      assert.equal(f.gate.checkBeforeCall(request).kind, "allow");
      f.clock.advance(2000); // 00:00:01 on the 7th: the settled ledger is empty, the reservation is pending
      assert.equal(f.gate.checkBeforeCall(request).kind, "refuse");
    } finally { f.close(); }
  });

  it("settling after midnight charges the day of admission, and the new day starts clean", () => {
    const f = fixture();
    try {
      f.clock.set(Date.UTC(2026, 9, 6, 23, 59, 59));
      f.gate.setLimit({ scope: "agent", id: "a1", period: "day", metric: "tokens", hard: 40 });
      const d = f.gate.checkBeforeCall(request);
      assert.equal(d.kind, "allow");
      f.clock.advance(2000);
      if (d.kind === "allow") f.gate.settle(d.reservationId, { inputTokens: 30, outputTokens: 10 });
      assert.equal(f.gate.checkBeforeCall(request).kind, "allow");
    } finally { f.close(); }
  });
});
