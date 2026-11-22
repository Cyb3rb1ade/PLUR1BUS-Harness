//! `packages/core/src/dreams/cron.ts` (P4-K K7a): the five-field cron evaluator with IANA zones that the user jobs schedule
//! with. It lives in the dreams directory in TypeScript and is shared by the dream scheduler; the dream scheduler itself is a
//! later K7 run, so this port sits beside the jobs that need it now and the dreams will use it from here.
//!
//! Semantics, as the TypeScript header says: Vixie cron where it matters. Day-of-month and day-of-week are OR-ed when both
//! are restricted (a field whose first character is `*` is unrestricted, whatever follows); a wall time that does not exist
//! (spring forward) is skipped; an ambiguous one (fall back) fires at its first occurrence only.
//!
//! Where the port had to choose: the TypeScript evaluator asks `Intl.DateTimeFormat` for the wall clock, this one asks
//! [`TzdbZones::local_minute`] (the same database, see `budget::zones`). An instant outside the range of a JavaScript `Date`
//! is a `RangeError` there and a [`CronError`] here. A wall year below 100 is not modelled (`Date.UTC` maps 0 to 99 to 1900 to
//! 1999 in JavaScript); it is an error here, which no real clock reaches.
use crate::budget::period::Zones;
use crate::budget::zones::{LocalMinute, TzdbZones};
use std::fmt;

/// A parse or evaluation failure; the text is the TypeScript `Error` message where there is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CronError(pub String);

impl fmt::Display for CronError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CronError {}

/// `ParsedCron`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedCron {
    /// Minutes, ascending.
    pub minutes: Vec<u32>,
    /// Hours, ascending.
    pub hours: Vec<u32>,
    /// Days of the month, ascending.
    pub doms: Vec<u32>,
    /// Months, ascending.
    pub months: Vec<u32>,
    /// Days of the week, 0 (Sunday) to 6, ascending; 7 is folded to 0.
    pub dows: Vec<u32>,
    /// The day-of-month field does not start with `*`.
    pub dom_restricted: bool,
    /// The day-of-week field does not start with `*`.
    pub dow_restricted: bool,
}

const RANGES: [(&str, f64, f64); 5] = [
    ("minute", 0.0, 59.0),
    ("hour", 0.0, 23.0),
    ("day-of-month", 1.0, 31.0),
    ("month", 1.0, 12.0),
    ("day-of-week", 0.0, 7.0),
];

/// `/^\d+$/` (ASCII digits only, at least one).
fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `Number(s)` of an all-digit string: a double, `Infinity` past the range.
fn digits_to_number(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::INFINITY)
}

fn parse_field(src: &str, name: &str, lo: f64, hi: f64) -> Result<(Vec<u32>, bool), CronError> {
    let mut out: Vec<u32> = Vec::new();
    // Vixie: a field whose first character is `*` is unrestricted for the day rule, whatever follows (`*/2` included).
    let restricted = !src.starts_with('*');
    for part in src.split(',') {
        let pieces: Vec<&str> = part.split('/').collect();
        let range_src = pieces[0];
        let step_src = pieces.get(1).copied();
        if range_src.is_empty() || pieces.len() > 2 {
            return Err(CronError(format!("invalid cron {name} field: {src}")));
        }
        let mut step = 1.0;
        if let Some(s) = step_src {
            if !all_digits(s) || digits_to_number(s) < 1.0 {
                return Err(CronError(format!("invalid cron {name} step: {src}")));
            }
            step = digits_to_number(s);
        }
        let (from, to);
        if range_src == "*" {
            from = lo;
            to = hi;
        } else {
            // `/^(\d+)(?:-(\d+))?$/`
            let (a, b) = match range_src.split_once('-') {
                Some((a, b)) => (a, Some(b)),
                None => (range_src, None),
            };
            if !all_digits(a) || b.is_some_and(|b| !all_digits(b)) {
                return Err(CronError(format!("invalid cron {name} field: {src}")));
            }
            from = digits_to_number(a);
            to = match b {
                Some(b) => digits_to_number(b),
                None if step_src.is_some() => hi,
                None => from,
            };
            if from < lo || to > hi || from > to {
                return Err(CronError(format!("cron {name} out of range: {src}")));
            }
        }
        let mut v = from;
        while v <= to {
            // `from` and `to` lie in `lo..=hi`, so `v` is a small whole number.
            let n = v as u32;
            if !out.contains(&n) {
                out.push(n);
            }
            v += step;
        }
    }
    out.sort_unstable();
    Ok((out, restricted))
}

/// `parseCron(expr)`.
pub fn parse_cron(expr: &str) -> Result<ParsedCron, CronError> {
    let trimmed = crate::js::js_trim(expr);
    // `expr.trim().split(/\s+/)`: an empty text splits to one empty field, which the length check refuses as well.
    let fields: Vec<&str> = trimmed
        .split(crate::js::is_js_space)
        .filter(|f| !f.is_empty())
        .collect();
    if trimmed.is_empty() || fields.len() != 5 {
        return Err(CronError(format!(
            "invalid cron expression (5 fields expected): \"{expr}\""
        )));
    }
    let mut parsed = Vec::with_capacity(5);
    for (i, f) in fields.iter().enumerate() {
        let (name, lo, hi) = RANGES[i];
        parsed.push(parse_field(f, name, lo, hi)?);
    }
    let mut dows: Vec<u32> = parsed[4].0.iter().map(|d| d % 7).collect();
    dows.sort_unstable();
    dows.dedup();
    Ok(ParsedCron {
        minutes: parsed[0].0.clone(),
        hours: parsed[1].0.clone(),
        doms: parsed[2].0.clone(),
        months: parsed[3].0.clone(),
        dows,
        dom_restricted: parsed[2].1,
        dow_restricted: parsed[4].1,
    })
}

/// `isValidTimezone(tz)`.
pub fn is_valid_timezone(tz: &str) -> bool {
    TzdbZones.is_valid(tz)
}

fn wall_of(ms: i64, tz: &str) -> Result<LocalMinute, CronError> {
    // The formatter is built first in TypeScript, so an unknown zone is named before an instant `Date` cannot hold.
    if !is_valid_timezone(tz) {
        return Err(CronError(format!("Invalid time zone specified: {tz}")));
    }
    TzdbZones
        .local_minute(ms, tz)
        .ok_or_else(|| CronError("Invalid time value".into()))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number, the inverse of [`days_from_civil`].
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.UTC(y, mo - 1, d, h, mi)` of a wall reading, for a year of 100 or more.
fn wall_ms(w: &LocalMinute) -> i64 {
    days_from_civil(i64::from(w.y), i64::from(w.mo), i64::from(w.d)) * 86_400_000
        + i64::from(w.h) * 3_600_000
        + i64::from(w.mi) * 60_000
}

/// `offsetMs`: the wall clock of `ms` read as if it were UTC, minus `ms` cut to the minute.
fn offset_ms(ms: i64, tz: &str) -> Result<i64, CronError> {
    Ok(wall_ms(&wall_of(ms, tz)?) - ms.div_euclid(60_000) * 60_000)
}

/// The earliest instant whose wall clock in `tz` reads `w`, or `None` when that wall time does not exist.
fn wall_to_utc(w: &LocalMinute, tz: &str) -> Result<Option<i64>, CronError> {
    let guess = wall_ms(w);
    let mut best: Option<i64> = None;
    for probe in [guess - 86_400_000, guess + 86_400_000] {
        let t = guess - offset_ms(probe, tz)?;
        if wall_of(t, tz)? == *w && best.is_none_or(|b| t < b) {
            best = Some(t);
        }
    }
    Ok(best)
}

/// Vixie's day rule: OR when both day fields are restricted (do not start with `*`), AND otherwise.
fn day_matches(c: &ParsedCron, dom_ok: bool, dow_ok: bool) -> bool {
    if c.dom_restricted && c.dow_restricted {
        dom_ok || dow_ok
    } else {
        dom_ok && dow_ok
    }
}

/// `nextAfter(c, tz, fromMs)`: the first firing strictly after `from_ms`, or `None` when the expression can never fire
/// (31 February). An error where the TypeScript code throws (an unknown zone, an instant `Date` cannot hold).
pub fn next_after(c: &ParsedCron, tz: &str, from_ms: i64) -> Result<Option<i64>, CronError> {
    let start = wall_of(from_ms, tz)?;
    if start.y < 100 {
        return Err(CronError(
            "a wall year below 100 is not modelled (Date.UTC maps it to 19xx)".into(),
        ));
    }
    let first_day = days_from_civil(i64::from(start.y), i64::from(start.mo), i64::from(start.d));
    for day in 0..366 * 8 {
        let n = first_day + day;
        let (y, mo, d) = civil_from_days(n);
        // 1970-01-01 was a Thursday.
        let dow = (n + 4).rem_euclid(7) as u32;
        if !c.months.contains(&(mo as u32)) {
            continue;
        }
        let dom_ok = c.doms.contains(&(d as u32));
        let dow_ok = c.dows.contains(&dow);
        if !day_matches(c, dom_ok, dow_ok) {
            continue;
        }
        for &h in &c.hours {
            for &mi in &c.minutes {
                let w = LocalMinute {
                    y: y as i32,
                    mo: mo as u32,
                    d: d as u32,
                    h,
                    mi,
                };
                if let Some(t) = wall_to_utc(&w, tz)? {
                    if t > from_ms {
                        return Ok(Some(t));
                    }
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_without_a_range_runs_to_the_top_of_the_field() {
        let c = parse_cron("5/20 * * * *").unwrap();
        assert_eq!(c.minutes, vec![5, 25, 45]);
    }

    #[test]
    fn the_day_of_week_seven_is_sunday() {
        let c = parse_cron("0 0 * * 7").unwrap();
        assert_eq!(c.dows, vec![0]);
        assert!(!c.dom_restricted && c.dow_restricted);
    }

    #[test]
    fn javascript_white_space_separates_fields_and_ascii_digits_only_count() {
        assert!(parse_cron("\u{feff}0\u{2028}0 * *\u{a0}*\u{feff}").is_ok());
        assert!(parse_cron("0 0 * * \u{0661}").is_err());
        assert!(parse_cron("0 0 * * *\u{200b}").is_err());
        assert!(parse_cron("").is_err());
        assert!(parse_cron("0 0 * *").is_err());
        assert!(parse_cron("0 0 * * * *").is_err());
    }

    #[test]
    fn an_empty_part_a_double_slash_and_a_trailing_slash_are_refused() {
        for bad in [
            "1,,2 * * * *",
            "1//2 * * * *",
            "5/ * * * *",
            "/5 * * * *",
            "*-5 * * * *",
            "-1 * * * *",
            "+1 * * * *",
            "1.5 * * * *",
            "0x1 * * * *",
            "1/0 * * * *",
            "60 * * * *",
            "5-3 * * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
        ] {
            assert!(parse_cron(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_huge_number_is_out_of_range_not_a_panic() {
        let big = "9".repeat(400);
        assert!(parse_cron(&format!("{big} * * * *")).is_err());
        let c = parse_cron(&format!("0/{big} * * * *")).unwrap();
        assert_eq!(c.minutes, vec![0]);
    }

    #[test]
    fn february_thirtieth_never_fires() {
        let c = parse_cron("0 0 30 2 *").unwrap();
        assert_eq!(next_after(&c, "UTC", 0), Ok(None));
    }

    #[test]
    fn an_instant_a_date_cannot_hold_is_an_error() {
        let c = parse_cron("* * * * *").unwrap();
        assert!(next_after(&c, "UTC", crate::budget::MAX_TS + 1).is_err());
        assert!(next_after(&c, "No/Such_Zone", 0).is_err());
    }
}
