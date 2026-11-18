//! The production [`Zones`]: the IANA time-zone database `chrono-tz` compiles in (the workspace's, the one the engine
//! locks), answering what `Intl.DateTimeFormat(..., { timeZone })` answers in TypeScript.
//!
//! What ICU accepts and this follows:
//! - a zone or link name of the database, matched without regard to ASCII case (`utc`, `EUROPE/BERLIN`);
//! - an offset identifier: a sign (`+`, `-` or U+2212), two digits of hours (00 to 23) and optionally two digits of minutes
//!   (00 to 59), with or without a colon (`+01`, `+0100`, `+01:00`).
//!
//! Where the two differ is in `docs/phase4/p4-k-inventory.md`, K1: the release of the database each side carries, and the
//! names that only one of them knows.
use super::period::{civil_from_days, LocalDate, Zones};
use super::MAX_TS;
use chrono::Datelike;
use chrono_tz::Tz;

/// [`Zones`] over the compiled-in IANA database.
#[derive(Clone, Copy, Debug, Default)]
pub struct TzdbZones;

enum Zone {
    Named(Tz),
    /// Minutes east of UTC.
    Fixed(i64),
}

/// `+HH`, `+HHMM` or `+HH:MM` as minutes east of UTC.
fn offset_minutes(zone: &str) -> Option<i64> {
    let (sign, rest) = match zone.chars().next()? {
        '+' => (1, zone.get(1..)?),
        '-' => (-1, zone.get(1..)?),
        '\u{2212}' => (-1, zone.get('\u{2212}'.len_utf8()..)?),
        _ => return None,
    };
    let b = rest.as_bytes();
    let two = |i: usize| -> Option<i64> {
        let (hi, lo) = (*b.get(i)?, *b.get(i + 1)?);
        (hi.is_ascii_digit() && lo.is_ascii_digit())
            .then(|| i64::from(hi - b'0') * 10 + i64::from(lo - b'0'))
    };
    let (h, m) = match b.len() {
        2 => (two(0)?, 0),
        4 => (two(0)?, two(2)?),
        5 if b.get(2) == Some(&b':') => (two(0)?, two(3)?),
        _ => return None,
    };
    (h <= 23 && m <= 59).then_some(sign * (h * 60 + m))
}

fn resolve(zone: &str) -> Option<Zone> {
    if let Ok(tz) = zone.parse::<Tz>() {
        return Some(Zone::Named(tz));
    }
    if let Some(minutes) = offset_minutes(zone) {
        return Some(Zone::Fixed(minutes));
    }
    // The database is keyed by exact name; ICU folds ASCII case. A few hundred names, and only on the path of a name that
    // is not written the database's way.
    chrono_tz::TZ_VARIANTS
        .iter()
        .find(|tz| tz.name().eq_ignore_ascii_case(zone))
        .map(|tz| Zone::Named(*tz))
}

impl Zones for TzdbZones {
    fn is_valid(&self, zone: &str) -> bool {
        resolve(zone).is_some()
    }

    fn local_date(&self, ts_ms: i64, zone: &str) -> Option<LocalDate> {
        if !(-MAX_TS..=MAX_TS).contains(&ts_ms) {
            return None;
        }
        match resolve(zone)? {
            Zone::Fixed(minutes) => {
                let (y, m, d) = civil_from_days((ts_ms + minutes * 60_000).div_euclid(86_400_000));
                Some(LocalDate {
                    y: i32::try_from(y).ok()?,
                    m: u32::try_from(m).ok()?,
                    d: u32::try_from(d).ok()?,
                })
            }
            Zone::Named(tz) => {
                let at = chrono::DateTime::from_timestamp_millis(ts_ms)?.with_timezone(&tz);
                Some(LocalDate {
                    y: at.year(),
                    m: at.month(),
                    d: at.day(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(ts_ms: i64, zone: &str) -> Option<(i32, u32, u32)> {
        TzdbZones.local_date(ts_ms, zone).map(|l| (l.y, l.m, l.d))
    }

    /// The dates ICU 78.3 gives for the epoch (`Intl.DateTimeFormat("en-CA", { timeZone }).format(0)`); the period vectors
    /// only hold an offset east of UTC.
    #[test]
    fn an_offset_zone_is_east_or_west_by_its_sign() {
        assert_eq!(date(0, "+0100"), Some((1970, 1, 1)));
        assert_eq!(date(0, "-23:59"), Some((1969, 12, 31)));
        assert_eq!(date(0, "\u{2212}01:00"), Some((1969, 12, 31)));
        assert_eq!(date(0, "-00:00"), Some((1970, 1, 1)));
        // 22:30 on 31 December 1969, UTC: midnight an hour and a half to the east.
        assert_eq!(date(-5_400_000, "+0130"), Some((1970, 1, 1)));
        assert_eq!(date(-5_400_001, "+01:30"), Some((1969, 12, 31)));
        assert_eq!(date(59_999, "+23:59"), Some((1970, 1, 1)));
        assert_eq!(date(60_000, "+23:59"), Some((1970, 1, 2)));
        // 23:00 on 31 December 1969, UTC, is midnight of that day 23 hours to the west.
        assert_eq!(date(-3_600_000, "-23"), Some((1969, 12, 31)));
        assert_eq!(date(-3_600_001, "-23"), Some((1969, 12, 30)));
    }

    #[test]
    fn a_name_in_another_case_is_the_same_zone() {
        // 22:30 UTC on 6 October 2026 is past midnight in Berlin.
        let ts = 1_791_325_800_000;
        assert_eq!(date(ts, "Europe/Berlin"), Some((2026, 10, 7)));
        assert_eq!(date(ts, "europe/BERLIN"), Some((2026, 10, 7)));
        assert_eq!(date(ts, "utc"), Some((2026, 10, 6)));
        assert_eq!(date(ts, "Europe/Berlin "), None);
    }

    #[test]
    fn an_instant_outside_the_date_range_has_no_local_date() {
        assert_eq!(date(MAX_TS, "+00"), Some((275_760, 9, 13)));
        assert_eq!(date(MAX_TS + 1, "+00"), None);
        assert_eq!(date(-MAX_TS - 1, "UTC"), None);
    }
}
