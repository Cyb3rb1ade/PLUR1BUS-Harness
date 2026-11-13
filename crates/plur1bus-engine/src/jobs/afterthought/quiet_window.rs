//! CP-3 time and request limits.
use chrono::Timelike;

pub(super) const MIN_DELAY: i64 = 15 * 60_000;
pub(super) const MAX_DELAY: i64 = 120 * 60_000;
pub(super) const MAX_REQUEST: usize = 60_000;
pub(super) const MAX_SUMMARY: usize = 12_000;
pub(super) const RECENT_CHARS: usize = 16_000;
pub(super) const CHUNK_CHARS: usize = 32_000;

pub(super) fn eligible(completed_at: i64, now: i64) -> bool {
    (MIN_DELAY..=MAX_DELAY).contains(&now.saturating_sub(completed_at))
}

pub(super) fn quiet(now: i64, zone: chrono_tz::Tz) -> bool {
    chrono::DateTime::from_timestamp_millis(now)
        .is_none_or(|time| !(8..22).contains(&time.with_timezone(&zone).hour()))
}
