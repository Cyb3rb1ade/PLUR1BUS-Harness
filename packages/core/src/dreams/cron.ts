// A 5-field cron evaluator with IANA timezones (ADR-009 "Per-phase surface": explicit timezone, never host-local).
// No dependencies: Intl does the zone arithmetic. Semantics follow Vixie cron where it matters here: day-of-month and
// day-of-week are OR-ed when both are restricted; a wall time that does not exist (spring forward) is skipped; an
// ambiguous one (fall back) fires at its first occurrence.

export interface ParsedCron {
  minutes: readonly number[]; hours: readonly number[]; doms: readonly number[]; months: readonly number[]; dows: readonly number[];
  domRestricted: boolean; dowRestricted: boolean;
}

const RANGES: [string, number, number][] = [["minute", 0, 59], ["hour", 0, 23], ["day-of-month", 1, 31], ["month", 1, 12], ["day-of-week", 0, 7]];

function parseField(src: string, name: string, lo: number, hi: number): { values: number[]; restricted: boolean } {
  const out = new Set<number>();
  let restricted = true;
  for (const part of src.split(",")) {
    const [rangeSrc, stepSrc, extra] = part.split("/");
    if (rangeSrc === undefined || rangeSrc === "" || extra !== undefined) throw new Error(`invalid cron ${name} field: ${src}`);
    let step = 1;
    if (stepSrc !== undefined) {
      if (!/^\d+$/.test(stepSrc) || Number(stepSrc) < 1) throw new Error(`invalid cron ${name} step: ${src}`);
      step = Number(stepSrc);
    }
    let from: number; let to: number;
    if (rangeSrc === "*") {
      from = lo; to = hi;
      if (stepSrc === undefined && src === "*") restricted = false;
    } else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rangeSrc);
      if (!m) throw new Error(`invalid cron ${name} field: ${src}`);
      from = Number(m[1]); to = m[2] !== undefined ? Number(m[2]) : (stepSrc !== undefined ? hi : from);
      if (from < lo || to > hi || from > to) throw new Error(`cron ${name} out of range: ${src}`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), restricted };
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (expr.trim() === "" || fields.length !== 5) throw new Error(`invalid cron expression (5 fields expected): "${expr}"`);
  const parsed = fields.map((f, i) => parseField(f, RANGES[i]![0], RANGES[i]![1], RANGES[i]![2]));
  const dows = [...new Set(parsed[4]!.values.map((d) => d % 7))].sort((a, b) => a - b);
  return {
    minutes: parsed[0]!.values, hours: parsed[1]!.values, doms: parsed[2]!.values, months: parsed[3]!.values, dows,
    domRestricted: parsed[2]!.restricted, dowRestricted: parsed[4]!.restricted,
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try { formatter(tz); return true; } catch { return false; }
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number }
function wallOf(ms: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute! };
}
const offsetMs = (ms: number, tz: string): number => {
  const w = wallOf(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000;
};
const same = (a: Wall, b: Wall) => a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;

/** The earliest instant whose wall clock in `tz` reads `w`, or null when that wall time does not exist. */
function wallToUtc(w: Wall, tz: string): number | null {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let best: number | null = null;
  for (const probe of [guess - 86_400_000, guess + 86_400_000]) {
    const t = guess - offsetMs(probe, tz);
    if (same(wallOf(t, tz), w) && (best === null || t < best)) best = t;
  }
  return best;
}

/** The first firing strictly after `fromMs`, or null when the expression can never fire (e.g. 31 February). */
export function nextAfter(c: ParsedCron, tz: string, fromMs: number): number | null {
  const start = wallOf(fromMs, tz);
  const cursor = new Date(Date.UTC(start.y, start.mo - 1, start.d));
  for (let day = 0; day < 366 * 8; day++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const y = cursor.getUTCFullYear(), mo = cursor.getUTCMonth() + 1, d = cursor.getUTCDate(), dow = cursor.getUTCDay();
    if (!c.months.includes(mo)) continue;
    const domOk = c.doms.includes(d), dowOk = c.dows.includes(dow);
    const dayOk = c.domRestricted && c.dowRestricted ? domOk || dowOk : c.domRestricted ? domOk : c.dowRestricted ? dowOk : true;
    if (!dayOk) continue;
    for (const h of c.hours) for (const mi of c.minutes) {
      const t = wallToUtc({ y, mo, d, h, mi }, tz);
      if (t !== null && t > fromMs) return t;
    }
  }
  return null;
}
