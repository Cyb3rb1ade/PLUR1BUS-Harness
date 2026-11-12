//! Restore-safe epistemic cutoff beside the database tree, at pinned Node byte parity.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::store::{atomic_write::atomic_write, paths::assert_trusted_path};
use crate::text::json::{parse_json, TolerantJsonValue as Json};

const JS_MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// Node's cutoff read/ensure result in its insertion order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoffStatus {
    /// A valid positive cutoff was loaded or created.
    pub ok: bool,
    /// First explicit-write timestamp, or zero when unavailable.
    pub since: i64,
    /// Whether the upgrade marker exists.
    pub enabled: bool,
    /// A missing marker after restore never reopens the legacy trust window.
    pub legacy_open: bool,
    /// Fixed Node result code; never file contents or operating-system error text.
    pub reason: &'static str,
}

/// Canonical cutoff JSON path outside the restorable LanceDB directory.
#[must_use]
pub fn cutoff_path(base_db: &Path) -> PathBuf {
    marker_dir(base_db).join("explicit-write-since.json")
}

/// Canonical persistent upgrade marker path.
#[must_use]
pub fn enabled_path(base_db: &Path) -> PathBuf {
    marker_dir(base_db).join("EXPLICIT_WRITES_ENABLED")
}

fn marker_dir(base_db: &Path) -> PathBuf {
    base_db
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .join("_epistemic")
}

fn number_ms(value: f64) -> Option<i64> {
    (value.is_finite() && value.abs() <= JS_MAX_SAFE && value.fract() == 0.0)
        .then_some(value as i64)
}

/// Node Number.isSafeInteger timestamp coercion; strings and non-numbers stay invalid.
#[must_use]
pub fn finite_ms(value: &Value) -> Option<i64> {
    value.as_f64().and_then(number_ms)
}

fn field_ms(value: &Json, key: &str) -> Option<i64> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(name, _)| name.to_utf8_lossy() == key)
        .and_then(|(_, value)| {
            if let Json::Number(number) = value {
                number.parse::<f64>().ok().and_then(number_ms)
            } else {
                None
            }
        })
}

fn unavailable(enabled: bool, reason: &'static str) -> CutoffStatus {
    CutoffStatus {
        ok: false,
        since: 0,
        enabled,
        legacy_open: false,
        reason,
    }
}

/// Read without creating files. Missing and corrupt cutoffs are distinct fail-closed states.
#[must_use]
pub fn read_cutoff(base_db: &Path) -> CutoffStatus {
    let cutoff = cutoff_path(base_db);
    let enabled = enabled_path(base_db).exists();
    if !cutoff.exists() {
        return unavailable(
            enabled,
            if enabled {
                "cutoff_missing_after_upgrade"
            } else {
                "cutoff_absent"
            },
        );
    }
    let parsed = assert_trusted_path(&cutoff)
        .ok()
        .and_then(|()| fs::read_to_string(&cutoff).ok())
        .and_then(|text| parse_json(&text).ok())
        .and_then(|value| field_ms(&value, "since"));
    match parsed.filter(|since| *since > 0) {
        Some(since) => CutoffStatus {
            ok: true,
            since,
            enabled,
            legacy_open: true,
            reason: "ok",
        },
        None => unavailable(enabled, "cutoff_read_error"),
    }
}

/// Create only when both markers are absent; a restore or corrupt file never resets the cutoff.
/// File write failures produce the pinned status instead of a panic or a content-bearing error.
#[must_use]
pub fn ensure_cutoff(base_db: &Path, now: i64) -> CutoffStatus {
    let existing = read_cutoff(base_db);
    if existing.ok || existing.enabled || existing.reason == "cutoff_read_error" {
        return existing;
    }
    let since = number_ms(now as f64)
        .filter(|value| *value != 0)
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |duration| duration.as_millis() as i64)
        });
    let cutoff = cutoff_path(base_db);
    if cutoff.exists() {
        let raced = read_cutoff(base_db);
        if raced.ok {
            return raced;
        }
    }
    let write = || -> Result<(), crate::contract::StoreError> {
        assert_trusted_path(&cutoff)?;
        atomic_write(
            &cutoff,
            format!("{{\"since\":{since},\"createdAt\":{since}}}\n").as_bytes(),
        )?;
        let enabled = enabled_path(base_db);
        assert_trusted_path(&enabled)?;
        atomic_write(&enabled, b"1\n")?;
        Ok(())
    };
    if write().is_err() {
        return unavailable(false, "cutoff_write_error");
    }
    CutoffStatus {
        ok: true,
        since,
        enabled: true,
        legacy_open: true,
        reason: "created",
    }
}
