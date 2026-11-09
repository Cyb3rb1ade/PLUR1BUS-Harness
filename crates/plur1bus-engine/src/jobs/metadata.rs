//! Pure A1 job history/recovery decisions. Plans neither authorize bodies nor mutate a ledger.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use chrono::{DateTime, Datelike, Utc};
use std::collections::HashSet;

/// Node's optional history selectors; invalid numeric limits are ignored, as in the frozen registry.
#[derive(Clone, Debug, Default)]
pub struct HistorySelection<'a> {
    /// Exact job name; absent/empty means every name.
    pub job: Option<&'a str>,
    /// Inclusive startedAt threshold, applied before reversing append order.
    pub since: Option<f64>,
    /// Nonnegative integer count; zero deliberately returns no rows.
    pub limit: Option<f64>,
}
/// One orphan marker to retire after its existing or newly persisted run row is acknowledged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryAction {
    /// Safe filename-derived run identifier.
    pub run_id: String,
    /// Versioned crash row, or none when the ledger already contains this run identifier.
    /// A legacy/corrupt marker can produce diagnostic job="unknown"; it is not a JobName or grant.
    pub row: Option<Json>,
}

/// Select raw metadata objects without narrowing unknown legacy fields or opaque UTF-16 data.
/// The caller must already have selected and authorized the physical agent ledger.
pub fn history(
    rows: &[Json],
    selection: &HistorySelection<'_>,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    bounded(rows, 50_000, cancel)?;
    let job = selection.job.filter(|job| !job.is_empty());
    let since = selection.since.filter(|n| n.is_finite());
    let limit = selection
        .limit
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
        .map_or(rows.len(), |n| n.min(rows.len() as f64) as usize);
    let mut result = Vec::new();
    for row in rows.iter().rev() {
        cancel.check()?;
        if result.len() == limit {
            break;
        }
        if job.is_some_and(|job| string(get(row, "job")).as_deref() != Some(job)) {
            continue;
        }
        // Shared, already Node-tested ECMAScript coercion also covers legacy timestamp strings/arrays.
        if since.is_some_and(|since| {
            crate::capture::dynamics::number(get(row, "startedAt"))
                .partial_cmp(&since)
                .is_none_or(|order| order.is_lt())
        }) {
            continue;
        }
        result.push(row.clone());
    }
    Ok(result)
}

/// Plan exactly one startup pass from a stable ledger/marker snapshot and an explicit host clock.
/// A registry must own its lifecycle lease and commit/recheck each row before removing its marker.
/// This planner alone must never be used to classify another live process's markers as crashes.
pub fn recovery_plan(
    rows: &[Json],
    markers: &[Json],
    agent: &str,
    now: f64,
    cancel: &Cancel,
) -> Result<Vec<RecoveryAction>, EngineError> {
    safe_name(agent, 64)?;
    bounded(rows, 50_000, cancel)?;
    bounded(markers, 1024, cancel)?;
    if !now.is_finite() {
        return Err(StoreError::InvalidInput.into());
    }
    sweep(now)?;
    let finished: HashSet<_> = rows
        .iter()
        .filter_map(|row| string(get(row, "runId")))
        .collect();
    let mut planned = HashSet::new();
    let mut result = Vec::new();
    for marker in markers {
        cancel.check()?;
        let run_id = string(get(marker, "runId")).ok_or(StoreError::Corrupt)?;
        safe_name(&run_id, 128)?;
        // A physical directory has unique filenames. A repeated input means the snapshot is invalid.
        if !planned.insert(run_id.clone()) {
            return Err(StoreError::Corrupt.into());
        }
        let row = if finished.contains(&run_id) {
            None
        } else {
            Some(crash(marker, agent, now)?)
        };
        result.push(RecoveryAction { run_id, row });
    }
    Ok(result)
}
fn crash(marker: &Json, agent: &str, now: f64) -> Result<Json, EngineError> {
    let started = match get(marker, "startedAt") {
        Some(Json::Number(n)) => n
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(now),
        _ => now,
    };
    let phase = nullish(marker, "phase", Json::Null);
    let llm = matches!(string(Some(&phase)).as_deref(), Some("rem" | "deep"));
    let trigger = if truthy(get(marker, "corrupt")) {
        text("unknown")
    } else {
        nullish(marker, "trigger", text("cron"))
    };
    let fields = vec![
        ("v", number(1.0)),
        (
            "runId",
            get(marker, "runId").cloned().ok_or(StoreError::Corrupt)?,
        ),
        ("job", nullish(marker, "job", text("unknown"))),
        ("phase", phase),
        ("agentId", text(agent)),
        ("trigger", trigger),
        ("startedAt", number(started)),
        ("finishedAt", number(now)),
        ("durationMs", number((now - started).max(0.0))),
        ("outcome", text("failed")),
        ("reason", text("crash")),
        ("attempt", number(1.0)),
        ("cost", object(vec![("ms", number(0.0))])),
        ("counts", object(vec![])),
        ("sweep", text(&sweep(started)?)),
        ("llmSession", Json::Bool(llm)),
    ];
    Ok(object(fields))
}
pub(super) fn sweep(ms: f64) -> Result<String, EngineError> {
    // Job history outside chrono's representable range remains evidence, not a fabricated date.
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000.0 {
        return Err(StoreError::Corrupt.into());
    }
    let date =
        DateTime::<Utc>::from_timestamp_millis(ms.trunc() as i64).ok_or(StoreError::Corrupt)?;
    let year = date.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Ok(format!("{year}-{:02}-{:02}", date.month(), date.day())
        .chars()
        .take(10)
        .collect())
}
fn bounded(rows: &[Json], max: usize, cancel: &Cancel) -> Result<(), EngineError> {
    cancel.check()?;
    if rows.len() > max {
        return Err(StoreError::Corrupt.into());
    }
    let mut bytes = 0;
    for row in rows {
        cancel.check()?;
        if !matches!(row, Json::Object(_)) {
            return Err(StoreError::Corrupt.into());
        }
        let size = write_json(row).len();
        bytes += size;
        if size > 1024 * 1024 || bytes > 64 * 1024 * 1024 {
            return Err(StoreError::Corrupt.into());
        }
    }
    Ok(())
}
fn get<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(key, _)| key.to_utf8_lossy() == name)
        .map(|(_, v)| v)
}
fn string(value: Option<&Json>) -> Option<String> {
    let Json::String(value) = value? else {
        return None;
    };
    String::from_utf16(value.as_utf16_units()).ok()
}
fn nullish(value: &Json, key: &str, fallback: Json) -> Json {
    get(value, key)
        .filter(|v| !matches!(v, Json::Null))
        .cloned()
        .unwrap_or(fallback)
}
fn text(value: &str) -> Json {
    Json::String(JsString::from_utf8_str(value))
}
fn number(value: f64) -> Json {
    Json::Number(ryu_js::Buffer::new().format(value).to_owned())
}
fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| (JsString::from_utf8_str(k), v))
            .collect(),
    )
}
fn safe_name(value: &str, max: usize) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn truthy(value: Option<&Json>) -> bool {
    match value {
        None | Some(Json::Null) => false,
        Some(Json::Bool(value)) => *value,
        Some(Json::Number(value)) => value.parse::<f64>().is_ok_and(|n| n != 0.0 && !n.is_nan()),
        Some(Json::String(value)) => !value.as_utf16_units().is_empty(),
        Some(Json::Array(_) | Json::Object(_)) => true,
    }
}
