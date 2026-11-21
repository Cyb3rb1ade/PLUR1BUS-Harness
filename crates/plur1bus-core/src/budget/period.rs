//! `budget/period.ts`: the local calendar day, week or month an instant falls in, for an IANA time zone. No offset arithmetic:
//! the start of a local date is found by searching the zone's own date function, so DST changes (23 and 25 hour days, a
//! half-hour shift) and skipped midnights come out right.
//!
//! The zone's date function is the one thing this module does not own. TypeScript asks ICU through `Intl.DateTimeFormat`;
//! here it is the [`Zones`] port; the production adapter over the IANA database is [`super::zones::TzdbZones`].
use super::BudgetError;

/// `Period`: what a limit of the budget service is counted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Period {
    /// The local calendar day.
    Day,
    /// The local calendar month.
    Month,
}

impl Period {
    /// The name the store and the RPC use.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Month => "month",
        }
    }

    /// `day` or `month`; anything else is not a period of the service.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "day" => Some(Self::Day),
            "month" => Some(Self::Month),
            _ => None,
        }
    }
}

/// `CallPeriod`: the periods of the call port, which adds the week (starting Monday, local time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallPeriod {
    /// The local calendar day.
    Day,
    /// The local week, Monday to Sunday.
    Week,
    /// The local calendar month.
    Month,
}

impl CallPeriod {
    /// The name the store uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    /// `day`, `week` or `month`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "day" => Some(Self::Day),
            "week" => Some(Self::Week),
            "month" => Some(Self::Month),
            _ => None,
        }
    }
}

impl From<Period> for CallPeriod {
    fn from(p: Period) -> Self {
        match p {
            Period::Day => Self::Day,
            Period::Month => Self::Month,
        }
    }
}

/// `PeriodBounds`: the period an instant is in, its key and its half-open range `[start, end)` in milliseconds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeriodBounds {
    /// Which period.
    pub period: CallPeriod,
    /// `2026-10-06`, `2026-10` or the Monday of the week.
    pub key: String,
    /// First instant of the period.
    pub start: i64,
    /// First instant of the next period.
    pub end: i64,
}

/// A date in the proleptic Gregorian calendar, as a zone shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalDate {
    /// Year.
    pub y: i32,
    /// Month, 1 to 12.
    pub m: u32,
    /// Day of the month, 1 to 31.
    pub d: u32,
}

/// The port to the time-zone database: what `Intl.DateTimeFormat(..., { timeZone })` answers in TypeScript.
pub trait Zones: Send + Sync {
    /// Whether `zone` names a zone of the database (TypeScript: the formatter can be built).
    fn is_valid(&self, zone: &str) -> bool;
    /// The calendar date `ts_ms` has in `zone`, or `None` for an unknown zone or an instant outside the `Date` range.
    fn local_date(&self, ts_ms: i64, zone: &str) -> Option<LocalDate>;
}

/// `validateTimeZone`: 1 to 64 UTF-16 units and a zone the database knows.
pub fn validate_time_zone(zones: &dyn Zones, zone: &str) -> Result<String, BudgetError> {
    let units = zone.encode_utf16().count();
    if units == 0 || units > 64 {
        return Err(BudgetError::Range("invalid time zone".into()));
    }
    if !zones.is_valid(zone) {
        return Err(BudgetError::Range(format!("invalid time zone: {zone}")));
    }
    Ok(zone.to_owned())
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm; `m` 1 to 12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date of a day count (inverse of [`days_from_civil`]).
pub(super) fn civil_from_days(z: i64) -> (i64, i64, i64) {
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

/// `Date.UTC(y, m - 1, d)` normalised: a month or day past its range rolls over into the next period.
fn normalise(y: i64, m: i64, d: i64) -> (i64, i64, i64) {
    let months = y * 12 + (m - 1);
    let (y, m0) = (months.div_euclid(12), months.rem_euclid(12));
    civil_from_days(days_from_civil(y, m0 + 1, 1) + d - 1)
}

fn date_key(y: i64, m: i64, d: i64) -> i64 {
    y * 10_000 + m * 100 + d
}

fn local_key(zones: &dyn Zones, ts: i64, zone: &str) -> Result<i64, BudgetError> {
    let l = zones
        .local_date(ts, zone)
        .ok_or_else(|| BudgetError::Range(format!("invalid time zone: {zone}")))?;
    Ok(date_key(i64::from(l.y), i64::from(l.m), i64::from(l.d)))
}

const HOUR_MS: i64 = 3_600_000;

/// The first instant whose local date in `zone` is on or after y-m-d (month is 1-based; overflow rolls over). The window is
/// 36 hours either side of the date's UTC midnight, since offsets lie within -12 to +14 hours.
fn start_of_local_date(
    zones: &dyn Zones,
    y: i64,
    m: i64,
    d: i64,
    zone: &str,
) -> Result<i64, BudgetError> {
    let (ny, nm, nd) = normalise(y, m, d);
    let target = date_key(ny, nm, nd);
    let base = days_from_civil(ny, nm, nd) * 86_400_000;
    let (mut lo, mut hi) = (base - 36 * HOUR_MS, base + 36 * HOUR_MS);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if local_key(zones, mid, zone)? >= target {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    Ok(hi)
}

/// `periodBounds`.
pub fn period_bounds(
    zones: &dyn Zones,
    ts: i64,
    zone: &str,
    period: CallPeriod,
) -> Result<PeriodBounds, BudgetError> {
    if !(-super::MAX_TS..=super::MAX_TS).contains(&ts) {
        return Err(BudgetError::Range("Invalid time value".into()));
    }
    let l = zones
        .local_date(ts, zone)
        .ok_or_else(|| BudgetError::Range(format!("invalid time zone: {zone}")))?;
    let (y, m, d) = (i64::from(l.y), i64::from(l.m), i64::from(l.d));
    let key = |y: i64, m: i64, d: i64| format!("{y:04}-{m:02}-{d:02}");
    Ok(match period {
        CallPeriod::Week => {
            let days = days_from_civil(y, m, d);
            // 1970-01-01 was a Thursday; 0 is Sunday here, as `getUTCDay`.
            let weekday = (days + 4).rem_euclid(7);
            let (my, mm, md) = civil_from_days(days - (weekday + 6) % 7);
            PeriodBounds {
                period,
                key: key(my, mm, md),
                start: start_of_local_date(zones, my, mm, md, zone)?,
                end: start_of_local_date(zones, my, mm, md + 7, zone)?,
            }
        }
        CallPeriod::Day => PeriodBounds {
            period,
            key: key(y, m, d),
            start: start_of_local_date(zones, y, m, d, zone)?,
            end: start_of_local_date(zones, y, m, d + 1, zone)?,
        },
        CallPeriod::Month => PeriodBounds {
            period,
            key: format!("{y:04}-{m:02}"),
            start: start_of_local_date(zones, y, m, 1, zone)?,
            end: start_of_local_date(zones, y, m + 1, 1, zone)?,
        },
    })
}

/// `new Date(ms).toISOString()`: `2026-10-07T00:00:00.000Z`, with the signed six-digit year outside 0000 to 9999.
pub fn iso_utc(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else {
        format!("{}{:06}", if y < 0 { '-' } else { '+' }, y.abs())
    };
    format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}
