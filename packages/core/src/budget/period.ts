// Budget periods (L8): the local calendar day or month an instant falls in, for an IANA time zone.
// No offset arithmetic: the start of a local date is found by searching the zone's own date function, so DST
// changes (23/25 h days) and skipped midnights come out right.

export type Period = "day" | "month";
export type CallPeriod = Period | "week";
export interface PeriodBounds { period: CallPeriod; key: string; start: number; end: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", calendar: "gregory", numberingSystem: "latn" }); }
    catch { throw new RangeError(`invalid time zone: ${timeZone}`); }
    formatters.set(timeZone, f);
  }
  return f;
}

export function validateTimeZone(timeZone: string): string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) throw new RangeError("invalid time zone");
  formatter(timeZone);
  return timeZone;
}

interface LocalDate { y: number; m: number; d: number }
function localDate(ts: number, timeZone: string): LocalDate {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}
const dateKey = (l: LocalDate) => l.y * 10_000 + l.m * 100 + l.d;

/** The first instant whose local date in `timeZone` is on or after y-m-d (month is 1-based; overflow rolls over). */
function startOfLocalDate(y: number, m: number, d: number, timeZone: string): number {
  const norm = new Date(Date.UTC(y, m - 1, d));
  const target = dateKey({ y: norm.getUTCFullYear(), m: norm.getUTCMonth() + 1, d: norm.getUTCDate() });
  const base = norm.getTime();
  let lo = base - 36 * 3_600_000; // local date < target here (offsets are within -12..+14 h)
  let hi = base + 36 * 3_600_000; // local date >= target here
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dateKey(localDate(mid, timeZone)) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

export function periodBounds(ts: number, timeZone: string, period: CallPeriod): PeriodBounds {
  if (!Number.isFinite(ts)) throw new RangeError("invalid timestamp");
  const l = localDate(ts, timeZone);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  if (period === "week") {
    const weekday = new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay();
    const monday = new Date(Date.UTC(l.y, l.m - 1, l.d - (weekday + 6) % 7));
    const y = monday.getUTCFullYear(), m = monday.getUTCMonth() + 1, d = monday.getUTCDate();
    return { period, key: `${pad(y, 4)}-${pad(m)}-${pad(d)}`, start: startOfLocalDate(y, m, d, timeZone), end: startOfLocalDate(y, m, d + 7, timeZone) };
  }
  if (period === "day") {
    return { period, key: `${pad(l.y, 4)}-${pad(l.m)}-${pad(l.d)}`, start: startOfLocalDate(l.y, l.m, l.d, timeZone), end: startOfLocalDate(l.y, l.m, l.d + 1, timeZone) };
  }
  return { period, key: `${pad(l.y, 4)}-${pad(l.m)}`, start: startOfLocalDate(l.y, l.m, 1, timeZone), end: startOfLocalDate(l.y, l.m + 1, 1, timeZone) };
}
