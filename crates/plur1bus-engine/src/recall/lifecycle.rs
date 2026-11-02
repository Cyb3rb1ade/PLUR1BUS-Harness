//! Live-row checks from `isRecallEntryLive` and `isEntryValidAt`.

use crate::contract::MemoryRow;

use super::score::normalize_epistemic_status;

/// Whether a row may surface at `now_ms`.
///
/// `valid_at == None` skips the bi-temporal window. Status `null` is live; an empty
/// string is not. `invalidated` is a hard exclusion. Explicit `untrusted` stays live.
#[must_use]
pub fn is_recall_entry_live(row: &MemoryRow, now_ms: i64, valid_at: Option<i64>) -> bool {
    if !row.status.is_empty() && row.status != "active" {
        return false;
    }
    if normalize_epistemic_status(&row.epistemic_status) == "invalidated" {
        return false;
    }
    if !expiry_is_live(number(&row.expires_at), now_ms) {
        return false;
    }
    is_entry_valid_at(number(&row.valid_from), number(&row.valid_until), valid_at)
}

fn expiry_is_live(expires_at: f64, now_ms: i64) -> bool {
    expires_at == 0.0 || (expires_at.is_finite() && expires_at > now_ms as f64)
}

/// Left-inclusive, right-exclusive window. `0` on either bound means unbounded.
#[must_use]
pub fn is_entry_valid_at(valid_from: f64, valid_until: f64, valid_at: Option<i64>) -> bool {
    let Some(point) = valid_at else {
        return true;
    };
    let point = point as f64;
    if valid_from > 0.0 && point < valid_from {
        return false;
    }
    if valid_until > 0.0 && point >= valid_until {
        return false;
    }
    true
}

pub(super) fn number(value: &serde_json::Number) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

pub(super) fn epoch(value: &serde_json::Number) -> i64 {
    value.as_i64().unwrap_or_else(|| number(value) as i64)
}
