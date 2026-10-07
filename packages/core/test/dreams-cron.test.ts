import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidTimezone, nextAfter, parseCron } from "../src/dreams/cron.ts";

const iso = (s: string) => Date.parse(s);
const at = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("dreams cron", () => {
  it("steps and lists in UTC", () => {
    const c = parseCron("0 */4 * * *");
    assert.equal(at(nextAfter(c, "UTC", iso("2026-10-06T00:00:00Z"))), "2026-10-06T04:00:00.000Z");
    assert.equal(at(nextAfter(c, "UTC", iso("2026-10-06T20:00:01Z"))), "2026-10-07T00:00:00.000Z");
    const d = parseCron("15 1,13 * * *");
    assert.equal(at(nextAfter(d, "UTC", iso("2026-10-06T01:15:00Z"))), "2026-10-06T13:15:00.000Z");
  });

  it("is strictly after the instant", () => {
    const c = parseCron("0 4 * * *");
    assert.equal(at(nextAfter(c, "UTC", iso("2026-10-06T04:00:00Z"))), "2026-10-07T04:00:00.000Z");
  });

  it("honours the timezone", () => {
    const c = parseCron("0 4 * * *");
    assert.equal(at(nextAfter(c, "Europe/Berlin", iso("2026-10-06T00:00:00Z"))), "2026-10-06T02:00:00.000Z"); // CEST +2
    assert.equal(at(nextAfter(c, "Europe/Berlin", iso("2026-12-06T00:00:00Z"))), "2026-12-06T03:00:00.000Z"); // CET +1
  });

  it("skips a wall time that does not exist (spring forward) and runs the first of an ambiguous one (fall back)", () => {
    const c = parseCron("30 2 * * *");
    assert.equal(at(nextAfter(c, "Europe/Berlin", iso("2026-03-28T12:00:00Z"))), "2026-03-30T00:30:00.000Z");
    assert.equal(at(nextAfter(c, "Europe/Berlin", iso("2026-10-24T12:00:00Z"))), "2026-10-25T00:30:00.000Z");
  });

  it("day-of-week, ranges, 7 = Sunday, and the dom/dow OR rule", () => {
    assert.equal(at(nextAfter(parseCron("0 3 * * 7"), "UTC", iso("2026-10-06T00:00:00Z"))), "2026-10-11T03:00:00.000Z"); // Sunday
    assert.equal(at(nextAfter(parseCron("0 3 * * 1-5"), "UTC", iso("2026-10-09T04:00:00Z"))), "2026-10-12T03:00:00.000Z"); // Fri -> Mon
    // dom 15 OR Monday: from Tue 2026-10-06 the next is Mon 2026-10-12
    assert.equal(at(nextAfter(parseCron("0 3 15 * 1"), "UTC", iso("2026-10-06T00:00:00Z"))), "2026-10-12T03:00:00.000Z");
  });

  it("rejects malformed expressions and timezones", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *", "* * 0 * *", "* * * 13 *", "* * * * 8"]) {
      assert.throws(() => parseCron(bad), /cron/i, bad);
    }
    assert.equal(isValidTimezone("Europe/Berlin"), true);
    assert.equal(isValidTimezone("Mars/Olympus"), false);
  });

  it("returns null for an expression that never fires", () => {
    assert.equal(nextAfter(parseCron("0 0 31 2 *"), "UTC", iso("2026-01-01T00:00:00Z")), null);
  });
});
