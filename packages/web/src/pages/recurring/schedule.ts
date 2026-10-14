// Schedule checks and display for the user-job editor: pure functions, no DOM. The cron evaluator is the core's own
// (src/dreams/cron.ts), so the preview shows what the server will do, including its DST rules: a wall time that does not exist
// (spring forward) is skipped that day, an ambiguous one (fall back) fires once, at its first occurrence.
import { isValidTimezone, nextAfter, parseCron, type ParsedCron } from "../../../../core/src/dreams/cron.ts";

/** rpc.schema.json: `schedule.cron` and `schedule.timezone` are at most 128 characters. */
export const MAX_SCHEDULE_FIELD = 128;

export type ScheduleCheck =
  | { ok: true; cron: string; timezone: string }
  | { ok: false; reason: "length" | "cron" | "timezone" | "never" };

/** Checks what the editor would send. Surrounding whitespace is dropped (pasted values carry it); the trimmed values are what is sent. */
export function checkSchedule(cron: string, timezone: string): ScheduleCheck {
  const c = cron.trim(), tz = timezone.trim();
  if (c.length > MAX_SCHEDULE_FIELD || tz.length > MAX_SCHEDULE_FIELD) return { ok: false, reason: "length" };
  let parsed: ParsedCron;
  try { parsed = parseCron(c); } catch { return { ok: false, reason: "cron" }; }
  if (tz === "" || !isValidTimezone(tz)) return { ok: false, reason: "timezone" };
  if (nextAfter(parsed, tz, Date.now()) === null) return { ok: false, reason: "never" };
  return { ok: true, cron: c, timezone: tz };
}

export function nextThree(cron: string, timezone: string, from = Date.now()): number[] {
  const tz = timezone.trim();
  if (!isValidTimezone(tz)) return [];
  try {
    const parsed = parseCron(cron.trim());
    const runs: number[] = [];
    let at = from;
    for (let i = 0; i < 3; i++) {
      const next = nextAfter(parsed, tz, at);
      if (next === null) break;
      runs.push(next);
      at = next;
    }
    return runs;
  } catch {
    return [];
  }
}

/** The date of an instant in the task's zone ("Mar 29, 2026"). */
export function formatDay(at: number, timezone: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: timezone.trim() }).format(new Date(at));
}

/** A run in the task's own zone with its date and offset ("Mar 29, 2026, 09:30 GMT+2"), so a shift across a DST change shows. */
export function formatRun(at: number, timezone: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone: timezone.trim(),
  }).format(new Date(at));
}

export type DstNote = { kind: "skipped" | "repeated"; /** The instant of the clock change. */ at: number };

const MIN = 60_000;
const wallFormats = new Map<string, Intl.DateTimeFormat>();
function offsetMin(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  let f = wallFormats.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); wallFormats.set(tz, f); }
  for (const part of f.formatToParts(new Date(ms)))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  return (Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!) - Math.floor(ms / MIN) * MIN) / MIN;
}

/** Whether the cron fires on the wall-clock minute `wall` (minutes since epoch, read as UTC fields), by the core's day rules. */
function firesOnWall(c: ParsedCron, wall: number): boolean {
  const d = new Date(wall * MIN);
  const dom = d.getUTCDate(), dow = d.getUTCDay();
  if (!c.months.includes(d.getUTCMonth() + 1) || !c.hours.includes(d.getUTCHours()) || !c.minutes.includes(d.getUTCMinutes())) return false;
  const domOk = c.doms.includes(dom), dowOk = c.dows.includes(dow);
  return c.domRestricted && c.dowRestricted ? domOk || dowOk : c.domRestricted ? domOk : c.dowRestricted ? dowOk : true;
}

/** The first clock change within a year of `from` that skips or doubles a run of this schedule, or null. */
export function dstNote(cron: string, timezone: string, from = Date.now()): DstNote | null {
  const tz = timezone.trim();
  if (!isValidTimezone(tz)) return null;
  let c: ParsedCron;
  try { c = parseCron(cron.trim()); } catch { return null; }
  const day = 24 * 60 * MIN;
  let prevAt = from, prevOff = offsetMin(from, tz);
  for (let i = 1; i <= 400; i++) {
    const at = from + i * day, off = offsetMin(at, tz);
    if (off !== prevOff) {
      // The change lies in (prevAt, at]: find its first minute.
      let lo = Math.floor(prevAt / MIN), hi = Math.floor(at / MIN);
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (offsetMin(mid * MIN, tz) === prevOff) lo = mid; else hi = mid; }
      const change = hi, delta = off - prevOff;
      // Spring forward: the wall minutes [change + prevOff, change + off) do not exist. Fall back: [change + off, change + prevOff) happen twice.
      const start = delta > 0 ? change + prevOff : change + off;
      for (let w = start; w < start + Math.abs(delta); w++) if (firesOnWall(c, w)) return { kind: delta > 0 ? "skipped" : "repeated", at: change * MIN };
    }
    prevAt = at; prevOff = off;
  }
  return null;
}
