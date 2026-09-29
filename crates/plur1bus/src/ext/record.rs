//! The inspection record and the rules both halves of an install apply (X1-C11): the worker's `ext.inspect` and the
//! supervisor's commit (Task 7) check the name, the unsigned policy and the inspection's life with this one code.
//! Supervisor-safe (X1-R2): no package parsing here (`scripts/lint-hygiene.mjs`).
use super::host::inspect_ttl;
use super::paths::ExtPaths;
use super::state::{self, ExtState};
use super::ExtError;
use crate::paths::Layout;
use plur1bus_ext::manifest::Kind;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// An inspection as `run/inspect/<inspectionId>.json` holds it. The RPC layer answers `ExtInspection` from it
/// (`sourcePath`, `normalised` and `nameTakenBy` are not part of that closed shape and are dropped there).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionRecord {
    pub inspection_id: String,
    /// RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
    pub expires_at: String,
    pub sha256: String,
    pub source_path: Option<String>,
    /// The input was a skill folder, `.zip` or `.skill` normalised into an unsigned package.
    pub normalised: bool,
    /// The exact `p1x.json`, as JSON.
    pub manifest: Value,
    /// `{ tier, keyId?, label? }` (`ExtTrust`).
    pub trust: Value,
    /// `[{ id, status, detail }]`.
    pub checks: Value,
    pub capabilities: Value,
    /// `[{ path, size, firstLine? }]`: the derived script set.
    pub scripts: Value,
    pub requires: Value,
    /// `{ version, capabilityDiff: { changed: [key] } }` when the same id is installed.
    pub replaces: Option<Value>,
    /// Reserved for the installed kind a name clash names. A clash is refused at inspect (`E_CONFLICT name-taken`,
    /// X1-R29), so a stored record never carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_taken_by: Option<String>,
}

pub(crate) fn expired() -> ExtError {
    ExtError::new(
        "E_NOT_FOUND",
        "inspection-expired",
        "this inspection has expired or does not exist; inspect the package again",
    )
}

/// An inspection id is a file stem under `run/inspect/`: 1–64 characters of `A-Z a-z 0-9 -` (a uuid).
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub(crate) fn spool_path(layout: &Layout, id: &str) -> PathBuf {
    ExtPaths::of(layout).inspect.join(format!("{id}.p1x"))
}

pub(crate) fn record_path(layout: &Layout, id: &str) -> PathBuf {
    ExtPaths::of(layout).inspect.join(format!("{id}.json"))
}

pub(crate) fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Skill => "skill",
        Kind::Module => "module",
        Kind::Channel => "channel",
        Kind::McpServer => "mcp-server",
        Kind::Bundle => "bundle",
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The inverse of [`super::iso8601`] for its own output (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub(crate) fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    if b[16] != b':' || b[19] != b'.' || b[23] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss, ms) = (n(11..13)?, n(14..16)?, n(17..19)?, n(20..23)?);
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000) + ms;
    u64::try_from(total).ok()
}

/// The installed kind of `modules/<name>`: its `module.json` `kind`, else `module`.
pub(crate) fn module_dir_kind(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("module.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["kind"].as_str().map(str::to_string))
        .unwrap_or_else(|| "module".into())
}

pub(crate) fn name_taken(name: &str, kind: &str, id: Option<&str>) -> ExtError {
    let by = match id {
        Some(id) => format!("the installed {kind} {id}"),
        None => format!("an installed {kind}"),
    };
    ExtError::new(
        "E_CONFLICT",
        "name-taken",
        format!("the name {name} is taken by {by}; uninstall it first"),
    )
    .with_data(json!({ "name": name, "installedKind": kind, "installedId": id }))
}

/// X1-R29: the same name under another id or kind is taken, whether the installed item came from a package (its
/// state record) or not (a bundled, local or imported skill folder, a module directory).
pub(crate) fn check_name(
    layout: &Layout,
    st: &ExtState,
    name: &str,
    id: &str,
    kind: &str,
) -> Result<(), ExtError> {
    if let Some(rec) = st.items.get(name) {
        if rec.id != id || rec.kind != kind {
            return Err(name_taken(name, &rec.kind, Some(&rec.id)));
        }
        return Ok(());
    }
    if std::fs::symlink_metadata(layout.skills().join(name)).is_ok() {
        return Err(name_taken(name, "skill", None));
    }
    let module = layout.modules_dir().join(name);
    if std::fs::symlink_metadata(&module).is_ok() {
        return Err(name_taken(name, &module_dir_kind(&module), None));
    }
    Ok(())
}

/// `extensions.allowUnsigned: false` (X1-R21) admits only packages signed by a trusted key.
pub(crate) fn check_unsigned_policy(
    allow_unsigned: bool,
    tier: &str,
    id: &str,
    version: &str,
) -> Result<(), ExtError> {
    if !allow_unsigned && tier != "first-party" {
        return Err(ExtError::new(
            "E_DENIED",
            "policy-unsigned-disallowed",
            format!(
                "{id} {version} is not signed by a trusted key, and extensions.allowUnsigned is false"
            ),
        ));
    }
    Ok(())
}

/// The record of a live inspection. Missing, unreadable, malformed or past `expiresAt` (or its spooled package gone) →
/// `E_NOT_FOUND inspection-expired`; an expired pair is removed.
pub fn load(layout: &Layout, id: &str) -> Result<InspectionRecord, ExtError> {
    if !valid_id(id) {
        return Err(expired());
    }
    let json = record_path(layout, id);
    let rec: InspectionRecord = std::fs::read_to_string(&json)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(expired)?;
    let live = rec.inspection_id == id
        && parse_iso_ms(&rec.expires_at).is_some_and(|t| now_ms() < t)
        && spool_path(layout, id).is_file();
    if !live {
        let _ = state::remove_retrying(&json);
        let _ = state::remove_retrying(&spool_path(layout, id));
        return Err(expired());
    }
    Ok(rec)
}

fn older_than(p: &Path, ttl: Duration) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > ttl)
}

/// Removes expired inspections from `run/inspect/`: a record past its `expiresAt` (or unreadable) with its package,
/// and a package or temp file with no record that is older than the TTL (an inspection killed half-way). Best effort.
pub fn prune(layout: &Layout) {
    let dir = ExtPaths::of(layout).inspect;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let ttl = inspect_ttl();
    let now = now_ms();
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".json") {
            let live = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<InspectionRecord>(&t).ok())
                .and_then(|r| parse_iso_ms(&r.expires_at))
                .is_some_and(|t| now < t);
            if !live {
                let _ = state::remove_retrying(&path);
                let _ = state::remove_retrying(&dir.join(format!("{stem}.p1x")));
            }
        } else if let Some(stem) = name.strip_suffix(".p1x") {
            if !dir.join(format!("{stem}.json")).exists() && older_than(&path, ttl) {
                let _ = state::remove_retrying(&path);
            }
        } else if name.contains(".tmp-") && older_than(&path, ttl) {
            let _ = state::remove_retrying(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ext::iso8601;

    #[test]
    fn iso_round_trips() {
        for ms in [0u64, 1_709_210_096_789, 1_767_225_599_999, 5_007] {
            assert_eq!(parse_iso_ms(&iso8601(ms)), Some(ms));
        }
        assert_eq!(parse_iso_ms("2026-01-01T00:00:00Z"), None);
        assert_eq!(parse_iso_ms("garbage"), None);
    }

    #[test]
    fn ids_are_file_stems() {
        assert!(valid_id("0b9e4c1e-7a6b-4d1c-9a3e-2f1d7c8b9a01"));
        for bad in ["", "../x", "a/b", "a.b", "a b", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }
}
