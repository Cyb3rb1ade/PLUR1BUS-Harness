// dreams/cron: fixed expectations, derived from the documented cron semantics (5 fields, IANA zone, dom/dow OR rule,
// non-existent wall time skipped, ambiguous wall time at its first occurrence) and from calendar/zone facts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidTimezone, nextAfter, parseCron } from "../../src/dreams/cron.ts";
import { at, iso, mulberry32 } from "./helpers.ts";

const next = (expr: string, tz: string, from: string): string | null => at(nextAfter(parseCron(expr), tz, iso(from)));

describe("dreams/cron parseCron: field forms", () => {
  const cases: [string, Partial<Record<"minutes" | "hours" | "doms" | "months" | "dows", number[]>>][] = [
    ["* * * * *", { minutes: Array.from({ length: 60 }, (_, i) => i), hours: Array.from({ length: 24 }, (_, i) => i), months: Array.from({ length: 12 }, (_, i) => i + 1) }],
    ["*/15 * * * *", { minutes: [0, 15, 30, 45] }],
    ["5,35 1-3 * * *", { minutes: [5, 35], hours: [1, 2, 3] }],
    ["0 8-18/5 * * *", { hours: [8, 13, 18] }],
    ["10/20 * * * *", { minutes: [10, 30, 50] }],
    ["0 0 1,15 1 *", { doms: [1, 15], months: [1] }],
    ["0 0 * * 7", { dows: [0] }],
    ["0 0 * * 0,7", { dows: [0] }],
    ["0 0 * * 1-5", { dows: [1, 2, 3, 4, 5] }],
    ["0 0 * * 5,1,3", { dows: [1, 3, 5] }],
    ["  0   12  *  *  *  ", { minutes: [0], hours: [12] }],
  ];
  for (const [expr, want] of cases) {
    it(`"${expr}"`, () => {
      const c = parseCron(expr);
      for (const [k, v] of Object.entries(want)) assert.deepEqual(c[k as keyof typeof c], v, `${expr}: ${k}`);
    });
  }

  it("a field is restricted unless it starts with '*' (Vixie cron)", () => {
    const c = parseCron("0 0 * * *");
    assert.equal(c.domRestricted, false); assert.equal(c.dowRestricted, false);
    const d = parseCron("0 0 1 * 1");
    assert.equal(d.domRestricted, true); assert.equal(d.dowRestricted, true);
    const e = parseCron("0 0 */2 * */3");
    assert.equal(e.domRestricted, false); assert.equal(e.dowRestricted, false);
    assert.equal(parseCron("0 0 1-31 * 1-5").domRestricted, true, "a full range written as '1-31' is restricted: only a leading '*' counts");
  });

  const invalid = [
    "", "   ", "* * * *", "* * * * * *", "60 * * * *", "-1 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 0 *", "* * * 13 *", "* * * * 8",
    "*/0 * * * *", "*/ * * * *", "1-/2 * * * *", "5-3 * * * *", "a * * * *", "1,,2 * * * *", ",1 * * * *", "1/2/3 * * * *", "*/-1 * * * *", "1.5 * * * *", "@daily",
  ];
  for (const expr of invalid) {
    it(`rejects ${JSON.stringify(expr)}`, () => { assert.throws(() => parseCron(expr), /cron/i); });
  }
});

describe("dreams/cron isValidTimezone", () => {
  for (const tz of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) it(`accepts ${tz}`, () => { assert.equal(isValidTimezone(tz), true); });
  for (const tz of ["", "Mars/Olympus", "Europe/Berlino", "not a zone", "../etc/passwd"]) it(`rejects ${JSON.stringify(tz)}`, () => { assert.equal(isValidTimezone(tz), false); });
});

describe("dreams/cron nextAfter: fixed table", () => {
  // [expression, zone, from, expected next]. Dates: 2026-10-13 is a Tuesday; 2026-10-11 a Sunday.
  const table: [string, string, string, string | null][] = [
    ["* * * * *", "UTC", "2026-10-13T00:00:00Z", "2026-10-13T00:01:00.000Z"],
    ["* * * * *", "UTC", "2026-10-13T00:00:59.999Z", "2026-10-13T00:01:00.000Z"],
    ["0 0 * * *", "UTC", "2026-10-13T00:00:00.001Z", "2026-10-14T00:00:00.000Z"],
    ["0 0 * * *", "UTC", "2026-10-12T23:59:59.999Z", "2026-10-13T00:00:00.000Z"],
    ["59 23 31 12 *", "UTC", "2026-10-13T00:00:00Z", "2026-12-31T23:59:00.000Z"],
    ["0 0 1 1 *", "UTC", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00.000Z"],
    ["30 4 * * 0", "UTC", "2026-10-13T00:00:00Z", "2026-10-18T04:30:00.000Z"],
    ["0 9 * * 1-5", "UTC", "2026-10-16T09:00:00Z", "2026-10-19T09:00:00.000Z"], // Friday 09:00 -> Monday
    ["0 0 29 2 *", "UTC", "2026-10-13T00:00:00Z", "2028-02-29T00:00:00.000Z"], // next leap day
    ["0 0 29 2 *", "UTC", "2028-02-29T00:00:00Z", "2032-02-29T00:00:00.000Z"],
    ["0 0 31 * *", "UTC", "2026-10-31T00:00:00Z", "2026-12-31T00:00:00.000Z"], // November has no 31st
    ["0 0 30 2 *", "UTC", "2026-10-13T00:00:00Z", null],
    ["0 0 31 2 *", "UTC", "2026-10-13T00:00:00Z", null],
    ["0 0 31 4 *", "UTC", "2026-10-13T00:00:00Z", null],
    ["0 0 31 6,9,11 *", "UTC", "2026-10-13T00:00:00Z", null],
    // zones with fixed offsets and a non-hour offset
    ["0 4 * * *", "Asia/Kolkata", "2026-10-13T00:00:00Z", "2026-10-13T22:30:00.000Z"], // 04:00 IST (+05:30) on the 14th
    ["0 4 * * *", "Asia/Tokyo", "2026-10-13T00:00:00Z", "2026-10-13T19:00:00.000Z"],
    ["0 0 * * *", "America/New_York", "2026-10-13T00:00:00Z", "2026-10-13T04:00:00.000Z"], // EDT -4
    ["0 0 * * *", "America/New_York", "2026-12-13T00:00:00Z", "2026-12-13T05:00:00.000Z"], // EST -5
  ];
  for (const [expr, tz, from, want] of table) it(`${expr} in ${tz} after ${from} = ${want}`, () => { assert.equal(next(expr, tz, from), want); });

  it("a firing is strictly after the instant: feeding a result back advances to the next firing, never repeats", () => {
    const c = parseCron("*/20 * * * *");
    let t = iso("2026-10-13T00:00:00Z"); const seen: string[] = [];
    for (let i = 0; i < 5; i++) { t = nextAfter(c, "UTC", t)!; seen.push(at(t)!); }
    assert.deepEqual(seen, ["2026-10-13T00:20:00.000Z", "2026-10-13T00:40:00.000Z", "2026-10-13T01:00:00.000Z", "2026-10-13T01:20:00.000Z", "2026-10-13T01:40:00.000Z"]);
  });

  it("dom and dow are OR-ed when both are restricted, and a single restricted field decides alone", () => {
    // 15th OR Sunday: from Tue 13th the 15th (Thu) comes before Sunday the 18th
    assert.equal(next("0 3 15 * 0", "UTC", "2026-10-13T00:00:00Z"), "2026-10-15T03:00:00.000Z");
    // the 12th OR Sunday, from Monday 12th 03:00: the 12th has fired, the 13th is a Tuesday, the next Sunday is the 18th
    assert.equal(next("0 3 12 * 0", "UTC", "2026-10-12T03:00:00Z"), "2026-10-18T03:00:00.000Z");
    // only dom restricted: weekdays do not matter
    assert.equal(next("0 3 14 * *", "UTC", "2026-10-13T00:00:00Z"), "2026-10-14T03:00:00.000Z");
    // only dow restricted: the 1st does not matter
    assert.equal(next("0 3 * * 3", "UTC", "2026-10-13T00:00:00Z"), "2026-10-14T03:00:00.000Z"); // Wednesday
  });
});

describe("dreams/cron nextAfter: daylight saving time", () => {
  it("Berlin spring forward 2026-03-29: 02:30 does not exist and is skipped for that day", () => {
    // CET->CEST at 01:00Z; local 02:00..02:59 never happens
    assert.equal(next("30 2 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z"), "2026-03-30T00:30:00.000Z"); // 02:30 CEST on the 30th
    assert.equal(next("30 3 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z"), "2026-03-29T01:30:00.000Z"); // 03:30 CEST exists
  });
  it("Berlin fall back 2026-10-25: 02:30 exists twice and fires once, at its first occurrence", () => {
    // 02:30 CEST = 00:30Z (first); 02:30 CET = 01:30Z (second)
    assert.equal(next("30 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z"), "2026-10-25T00:30:00.000Z");
    assert.equal(next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z"), "2026-10-26T01:30:00.000Z", "the repeated hour does not fire again; the next day is CET");
  });
  it("New York spring forward 2026-03-08: 02:30 skipped; fall back 2026-11-01: 01:30 at its first occurrence", () => {
    assert.equal(next("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z"), "2026-03-09T06:30:00.000Z"); // 02:30 EDT on the 9th
    assert.equal(next("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z"), "2026-11-01T05:30:00.000Z"); // 01:30 EDT = 05:30Z (first)
    assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z"), "2026-11-02T06:30:00.000Z"); // 01:30 EST next day
  });
  it("a daily 04:00 follows the local clock across the change (the deep default)", () => {
    assert.equal(next("0 4 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z"), "2026-10-25T03:00:00.000Z"); // 04:00 CET (after fall back)
    assert.equal(next("0 4 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z"), "2026-03-29T02:00:00.000Z"); // 04:00 CEST
  });
  it("owner decision 2026-10-14: an hourly cron runs once per wall-clock hour; the doubled 02:00 hour runs once, at its first occurrence (2 h real-time gap accepted)", () => {
    const c = parseCron("0 * * * *"); const out: string[] = [];
    let t = iso("2026-10-24T23:30:00Z");
    for (let i = 0; i < 3; i++) { t = nextAfter(c, "Europe/Berlin", t)!; out.push(at(t)!); }
    // 02:00 CEST = 00:00Z (first occurrence, the only run of wall hour 02), then 03:00 CET = 02:00Z; nothing at 01:00Z
    assert.deepEqual(out, ["2026-10-25T00:00:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-25T03:00:00.000Z"]);
  });
  it("a sub-hourly wildcard cron also runs each wall-clock time once: the repeated 02:00-02:59 hour is not run a second time", () => {
    const c = parseCron("*/30 * * * *"); const out: string[] = [];
    let t = iso("2026-10-24T23:45:00Z");
    for (let i = 0; i < 5; i++) { t = nextAfter(c, "Europe/Berlin", t)!; out.push(at(t)!); }
    assert.deepEqual(out, ["2026-10-25T00:00:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-25T02:30:00.000Z", "2026-10-25T03:00:00.000Z"]);
  });
  it("a cron with fixed hours fires at the first occurrence only ('0 2,3 * * *')", () => {
    assert.equal(next("0 2,3 * * *", "Europe/Berlin", "2026-10-25T00:00:00Z"), "2026-10-25T02:00:00.000Z", "03:00 CET; the second 02:00 does not fire");
  });
  it("an hourly cron does not fire twice at spring forward (the missing hour has no wall time)", () => {
    const c = parseCron("0 * * * *"); const out: string[] = [];
    let t = iso("2026-03-29T00:30:00Z");
    for (let i = 0; i < 3; i++) { t = nextAfter(c, "Europe/Berlin", t)!; out.push(at(t)!); }
    assert.deepEqual(out, ["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z", "2026-03-29T03:00:00.000Z"]);
  });
  it("'*/n' in day-of-month is unrestricted for the OR rule, like Vixie cron: it ANDs with a restricted day-of-week", () => {
    // 2026-10-13 is a Tuesday and an odd day. dom */2 (odd days) AND dow 1 (Monday): the next such day is Monday 2026-10-19.
    assert.equal(next("0 3 */2 * 1", "UTC", "2026-10-13T00:00:00Z"), "2026-10-19T03:00:00.000Z");
    // and '*/2' alone is still every odd day
    assert.equal(next("0 3 */2 * *", "UTC", "2026-10-13T04:00:00Z"), "2026-10-15T03:00:00.000Z");
    // a dom that does not start with '*' is restricted: OR with day-of-week (1st or any Monday)
    assert.equal(next("0 3 1 * 1", "UTC", "2026-10-13T00:00:00Z"), "2026-10-19T03:00:00.000Z");
    assert.equal(next("0 3 * * 1", "UTC", "2026-10-13T00:00:00Z"), "2026-10-19T03:00:00.000Z");
  });
  it("'*/n' in day-of-week is unrestricted as well: '0 3 15 * */2' is the 15th AND even weekdays", () => {
    // 2026-10-15 is a Thursday (4): */2 = 0,2,4,6 -> matches. 2026-11-15 is a Sunday (0): matches too.
    assert.equal(next("0 3 15 * */2", "UTC", "2026-10-14T00:00:00Z"), "2026-10-15T03:00:00.000Z");
    assert.equal(next("0 3 15 * */2", "UTC", "2026-10-16T00:00:00Z"), "2026-11-15T03:00:00.000Z");
  });
});

describe("dreams/cron nextAfter: seeded oracle", () => {
  it("'m h * * *' in UTC equals a minute-by-minute scan (300 seeded cases)", () => {
    const seed = 0xd2ea45;
    const rnd = mulberry32(seed);
    const pick = (n: number) => Math.floor(rnd() * n);
    for (let i = 0; i < 300; i++) {
      const mins = [...new Set(Array.from({ length: 1 + pick(3) }, () => pick(60)))].sort((a, b) => a - b);
      const hrs = [...new Set(Array.from({ length: 1 + pick(3) }, () => pick(24)))].sort((a, b) => a - b);
      const from = iso("2026-01-01T00:00:00Z") + pick(365 * 24 * 60) * 60_000 + pick(60_000);
      const expr = `${mins.join(",")} ${hrs.join(",")} * * *`;
      // oracle: the first whole minute strictly after `from` whose UTC minute and hour are in the sets
      let probe = Math.floor(from / 60_000) * 60_000 + 60_000;
      while (!(mins.includes(new Date(probe).getUTCMinutes()) && hrs.includes(new Date(probe).getUTCHours()))) probe += 60_000;
      assert.equal(nextAfter(parseCron(expr), "UTC", from), probe, `seed=${seed} case=${i} expr="${expr}" from=${new Date(from).toISOString()}`);
    }
  });

  it("'m h * * dow' in UTC equals a minute-by-minute scan over 8 days (200 seeded cases)", () => {
    const seed = 0x51ced;
    const rnd = mulberry32(seed);
    const pick = (n: number) => Math.floor(rnd() * n);
    for (let i = 0; i < 200; i++) {
      const m = pick(60), h = pick(24);
      const dows = [...new Set(Array.from({ length: 1 + pick(3) }, () => pick(7)))].sort((a, b) => a - b);
      const from = iso("2026-06-01T00:00:00Z") + pick(200 * 24 * 60) * 60_000;
      const expr = `${m} ${h} * * ${dows.join(",")}`;
      let probe = Math.floor(from / 60_000) * 60_000 + 60_000;
      const limit = probe + 8 * 24 * 60 * 60_000;
      while (probe < limit && !(new Date(probe).getUTCMinutes() === m && new Date(probe).getUTCHours() === h && dows.includes(new Date(probe).getUTCDay()))) probe += 60_000;
      assert.equal(nextAfter(parseCron(expr), "UTC", from), probe, `seed=${seed} case=${i} expr="${expr}" from=${new Date(from).toISOString()}`);
    }
  });

  it("with a fixed-offset zone the result is the UTC oracle shifted by the offset (Asia/Kolkata, 200 seeded cases)", () => {
    const seed = 0x1ac0b;
    const rnd = mulberry32(seed);
    const pick = (n: number) => Math.floor(rnd() * n);
    const OFFSET = 330 * 60_000; // IST has no DST
    for (let i = 0; i < 200; i++) {
      const m = pick(60), h = pick(24);
      const from = iso("2026-02-01T00:00:00Z") + pick(300 * 24 * 60) * 60_000;
      let probe = Math.floor(from / 60_000) * 60_000 + 60_000;
      while (!(new Date(probe + OFFSET).getUTCMinutes() === m && new Date(probe + OFFSET).getUTCHours() === h)) probe += 60_000;
      assert.equal(nextAfter(parseCron(`${m} ${h} * * *`), "Asia/Kolkata", from), probe, `seed=${seed} case=${i} ${m} ${h} from=${new Date(from).toISOString()}`);
    }
  });
});
