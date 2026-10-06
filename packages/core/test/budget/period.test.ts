import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { periodBounds, validateTimeZone } from "../../src/budget/period.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("periodBounds", () => {
  it("UTC day and month", () => {
    const ts = Date.UTC(2026, 9, 6, 13, 30);
    const d = periodBounds(ts, "UTC", "day");
    assert.equal(d.key, "2026-10-06");
    assert.equal(iso(d.start), "2026-10-06T00:00:00.000Z");
    assert.equal(iso(d.end), "2026-10-07T00:00:00.000Z");
    const m = periodBounds(ts, "UTC", "month");
    assert.equal(m.key, "2026-10");
    assert.equal(iso(m.start), "2026-10-01T00:00:00.000Z");
    assert.equal(iso(m.end), "2026-11-01T00:00:00.000Z");
  });

  it("the boundary instant belongs to the new period, the millisecond before to the old one", () => {
    const edge = Date.UTC(2026, 9, 7);
    assert.equal(periodBounds(edge, "UTC", "day").key, "2026-10-07");
    assert.equal(periodBounds(edge - 1, "UTC", "day").key, "2026-10-06");
  });

  it("the same instant is a different day in another zone", () => {
    const ts = Date.UTC(2026, 9, 6, 23, 30); // 01:30 on the 7th in Berlin (CEST, +2)
    assert.equal(periodBounds(ts, "UTC", "day").key, "2026-10-06");
    const b = periodBounds(ts, "Europe/Berlin", "day");
    assert.equal(b.key, "2026-10-07");
    assert.equal(iso(b.start), "2026-10-06T22:00:00.000Z");
    assert.equal(iso(b.end), "2026-10-07T22:00:00.000Z");
  });

  it("a day with the DST change is 25 h (fall back) or 23 h (spring forward)", () => {
    const fall = periodBounds(Date.UTC(2026, 9, 25, 12), "Europe/Berlin", "day");
    assert.equal(fall.key, "2026-10-25");
    assert.equal((fall.end - fall.start) / 3_600_000, 25);
    const spring = periodBounds(Date.UTC(2026, 2, 29, 12), "Europe/Berlin", "day");
    assert.equal(spring.key, "2026-03-29");
    assert.equal((spring.end - spring.start) / 3_600_000, 23);
  });

  it("month bounds follow the zone offset at each end (Los Angeles, PDT to PST in November)", () => {
    const b = periodBounds(Date.UTC(2026, 10, 15), "America/Los_Angeles", "month");
    assert.equal(b.key, "2026-11");
    assert.equal(iso(b.start), "2026-11-01T07:00:00.000Z"); // still PDT (UTC-7) on 1 Nov, DST ends on the 1st at 02:00
    assert.equal(iso(b.end), "2026-12-01T08:00:00.000Z"); // PST (UTC-8)
  });

  it("year rollover and a half-hour zone", () => {
    const b = periodBounds(Date.UTC(2026, 11, 31, 20, 0), "Asia/Kolkata", "month"); // 01:30 on 1 Jan 2027 local
    assert.equal(b.key, "2027-01");
    assert.equal(iso(b.start), "2026-12-31T18:30:00.000Z");
  });

  it("a zone whose midnight is skipped starts the day at the first valid instant", () => {
    // America/Sao_Paulo skipped 00:00 on the first Sunday of November in some years; the logic must still be monotonic.
    const a = periodBounds(Date.UTC(2018, 10, 4, 12), "America/Sao_Paulo", "day");
    assert.equal(a.key, "2018-11-04");
    assert.ok(a.end > a.start);
    assert.equal(periodBounds(a.start, "America/Sao_Paulo", "day").key, "2018-11-04");
    assert.equal(periodBounds(a.start - 1, "America/Sao_Paulo", "day").key, "2018-11-03");
  });

  it("rejects an unknown zone", () => {
    assert.throws(() => periodBounds(0, "Mars/Olympus", "day"), /time zone/);
    assert.throws(() => validateTimeZone("not a zone"), /time zone/);
    assert.equal(validateTimeZone("Europe/Berlin"), "Europe/Berlin");
  });
});
