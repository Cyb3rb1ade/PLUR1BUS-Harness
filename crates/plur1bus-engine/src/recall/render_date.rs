//! ECMAScript TimeClip and Gregorian ISO formatting for the prompt provenance.

use super::render::RenderError;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use serde_json::Value;

pub(super) const DAY_MS: f64 = 86_400_000.0;
const MAX_DATE_MS: f64 = 8_640_000_000_000_000.0;

pub(super) fn parse_timestamp(value: &Value) -> Option<f64> {
    let ms = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if !s.is_empty() => parse_date_string(s)?,
        _ => return None,
    };
    (ms.is_finite() && ms != 0.0 && ms.abs() <= MAX_DATE_MS).then_some(ms)
}

fn parse_date_string(value: &str) -> Option<f64> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis() as f64);
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    if value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit()) {
        return Some(
            Utc.with_ymd_and_hms(value.parse().ok()?, 1, 1, 0, 0, 0)
                .single()?
                .timestamp_millis() as f64,
        );
    }
    None
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

pub(super) fn iso_timestamp(ms: f64) -> Result<String, RenderError> {
    if !ms.is_finite() || ms.abs() > MAX_DATE_MS {
        return Err(RenderError::InvalidTimestamp);
    }
    let clipped = ms.trunc() as i64;
    let (year, month, day) = civil_from_days(clipped.div_euclid(DAY_MS as i64));
    let remainder = clipped.rem_euclid(DAY_MS as i64);
    let hour = remainder / 3_600_000;
    let minute = (remainder / 60_000) % 60;
    let second = (remainder / 1000) % 60;
    let millis = remainder % 1000;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{abs:06}",
            if year < 0 { "-" } else { "+" },
            abs = year.abs()
        )
    };
    Ok(format!(
        concat!(
            "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{mi",
            "llis:03}Z",
        ),
        year = year,
        month = month,
        day = day,
        hour = hour,
        minute = minute,
        second = second,
        millis = millis
    ))
}
