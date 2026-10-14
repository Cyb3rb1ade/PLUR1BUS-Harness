// Recurring: the schedule checks behind the user-job editor. Pure functions; the editor only wires them to inputs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkSchedule, dstNote, formatRun, nextThree } from "../src/pages/recurring/schedule.ts";

const iso = (s: string): number => Date.parse(s);

describe("checkSchedule", () => {
  test("accepts a plain schedule and returns the trimmed values the page sends", () => {
    assert.deepEqual(checkSchedule("  0 9 * * *  ", " Europe/Berlin "), { ok: true, cron: "0 9 * * *", timezone: "Europe/Berlin" });
  });
  test("refuses what the schema refuses: a cron or timezone longer than 128 characters", () => {
    const longCron = Array.from({ length: 60 }, (_, i) => String(i)).join(",") + " * * * *"; // valid cron, 175 characters
    assert.ok(longCron.length > 128);
    assert.deepEqual(checkSchedule(longCron, "UTC"), { ok: false, reason: "length" });
    assert.deepEqual(checkSchedule("0 9 * * *", "Europe/" + "x".repeat(130)), { ok: false, reason: "length" });
  });
  test("names the field that is wrong", () => {
    assert.deepEqual(checkSchedule("nonsense", "UTC"), { ok: false, reason: "cron" });
    assert.deepEqual(checkSchedule("0 9 * * *", "Mars/Olympus"), { ok: false, reason: "timezone" });
    assert.deepEqual(checkSchedule("0 9 * * *", ""), { ok: false, reason: "timezone" });
    assert.deepEqual(checkSchedule("0 0 31 2 *", "UTC"), { ok: false, reason: "never" });
  });
});

describe("nextThree", () => {
  test("three runs in the zone's own wall clock across a DST change", () => {
    const runs = nextThree("30 9 * * *", "Europe/Berlin", iso("2026-03-27T12:00:00Z"));
    assert.deepEqual(runs.map((r) => new Date(r).toISOString()), ["2026-03-28T08:30:00.000Z", "2026-03-29T07:30:00.000Z", "2026-03-30T07:30:00.000Z"]);
  });
});

describe("formatRun", () => {
  test("shows the date and the offset of the zone, so a shift across DST is visible", () => {
    const winter = formatRun(iso("2026-03-28T08:30:00Z"), "Europe/Berlin", "en");
    const summer = formatRun(iso("2026-03-29T07:30:00Z"), "Europe/Berlin", "en");
    assert.match(winter, /Mar 28, 2026/);
    assert.match(winter, /GMT\+1/);
    assert.match(summer, /GMT\+2/);
    assert.match(formatRun(iso("2026-03-29T07:30:00Z"), "Europe/Berlin", "de"), /MESZ/);
  });
});

describe("dstNote", () => {
  test("a time that does not exist on the spring change is flagged as skipped, with the day", () => {
    const n = dstNote("30 2 * * *", "Europe/Berlin", iso("2026-03-01T00:00:00Z"));
    assert.equal(n?.kind, "skipped");
    assert.equal(new Date(n!.at).toISOString(), "2026-03-29T01:00:00.000Z");
  });
  test("a time that happens twice on the autumn change is flagged as repeated", () => {
    const n = dstNote("30 2 * * *", "Europe/Berlin", iso("2026-10-01T00:00:00Z"));
    assert.equal(n?.kind, "repeated");
    assert.equal(new Date(n!.at).toISOString(), "2026-10-25T01:00:00.000Z");
  });
  test("a schedule clear of the change, a zone without DST and a day the cron does not run on have no note", () => {
    assert.equal(dstNote("30 9 * * *", "Europe/Berlin", iso("2026-03-01T00:00:00Z")), null);
    assert.equal(dstNote("30 2 * * *", "UTC", iso("2026-03-01T00:00:00Z")), null);
    assert.equal(dstNote("30 2 * * 1", "Europe/Berlin", iso("2026-03-01T00:00:00Z")), null, "29 March 2026 is a Sunday");
    assert.equal(dstNote("30 2 15 6 *", "Europe/Berlin", iso("2026-03-01T00:00:00Z")), null);
  });
  test("finds the autumn change when the spring one does not touch the schedule", () => {
    const n = dstNote("30 2 * * *", "Europe/Berlin", iso("2026-04-01T00:00:00Z"));
    assert.equal(n?.kind, "repeated");
  });
});
