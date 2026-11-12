//! Pure legacy REM migration plan. The I/O owner must preserve the first rollback copy and
//! durably deduplicate imported run IDs before committing the per-agent marker.
use super::{
    ledger::json::node_value,
    metadata::{get, sweep, truthy},
};
use crate::{
    capture::interference::bounded,
    contract::{Cancel, EngineError, StoreError},
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use chrono::{DateTime, Datelike, SecondsFormat, Utc};
const MARKER: &str = "plur1busLedgerMigratedAt";
/// Actual Node result classification; unsupported native inputs return an error instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No legacy state file exists.
    Absent,
    /// This agent already has a truthy migration marker.
    Already,
    /// Invalid JSON or a non-object top-level value; retain its original bytes.
    Corrupt,
    /// Proposed imported rows and marked state, not yet persisted.
    Migrated,
}
impl Status {
    /// Frozen Node status spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Already => "already",
            Self::Corrupt => "corrupt",
            Self::Migrated => "migrated",
        }
    }
}
/// Proposed metadata only, with no job execution or data authority.
pub struct Plan {
    /// Status to acknowledge only after the corresponding durable effects succeed.
    pub status: Status,
    /// Exact ordered legacy run rows; imported run IDs are stable across retries.
    pub rows: Vec<Json>,
    /// Full state preserving unrelated fields, or none when no state write is permitted.
    pub state: Option<Json>,
    /// Keep original bytes only if the rollback copy does not yet exist; never replace it.
    pub preserve_original: bool,
}
fn empty(status: Status, preserve_original: bool) -> Plan {
    Plan {
        status,
        rows: vec![],
        state: None,
        preserve_original,
    }
}
fn invalid() -> EngineError {
    StoreError::InvalidInput.into()
}
fn number(value: f64) -> Json {
    Json::Number(ryu_js::Buffer::new().format_finite(value).into())
}
fn text(value: &str) -> Json {
    Json::String(value.into())
}
fn object(values: Vec<(&str, Json)>) -> Json {
    Json::Object(values.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn set(value: &mut Json, key: &str, new: Json) -> Result<(), EngineError> {
    let Json::Object(fields) = value else {
        return Err(invalid());
    };
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == &JsString::from(key)) {
        *old = new;
    } else {
        fields.push((key.into(), new));
    }
    Ok(())
}
fn completed_at(meta: &Json, now: f64) -> Result<f64, EngineError> {
    match get(meta, "completedAt") {
        None | Some(Json::Null) => Ok(now),
        Some(Json::String(raw)) if raw.is_empty() => Ok(now),
        Some(Json::String(raw)) => {
            let value = String::from_utf16(raw.as_utf16_units()).map_err(|_| invalid())?;
            let value = if value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit()) {
                format!("{value}-01-01")
            } else {
                value
            };
            let parsed = DateTime::parse_from_rfc3339(&value)
                .ok()
                .filter(|v| v.timestamp_subsec_nanos() < 1_000_000_000)
                .map(|v| v.timestamp_millis() as f64)
                .or_else(|| {
                    if value.len() != 10 {
                        return None;
                    }
                    let date = chrono::NaiveDate::parse_from_str(&value, "%Y-%m-%d").ok()?;
                    if date.format("%Y-%m-%d").to_string() != value {
                        return None;
                    }
                    date.and_hms_opt(0, 0, 0)
                        .map(|v| v.and_utc().timestamp_millis() as f64)
                });
            parsed.ok_or_else(invalid)
        }
        _ => Err(invalid()),
    }
}
/// Plan supported A1 object-state migrations using one captured host clock.
/// Noncanonical legacy date strings, ambiguous JSON, arrays as maps and oversized inputs refuse;
/// they are never assigned a guessed completion time or silently rewritten. Input is capped at 2MiB.
pub fn plan(
    raw: Option<&str>,
    agent: &str,
    now: f64,
    cancel: &Cancel,
) -> Result<Plan, EngineError> {
    cancel.check()?;
    if agent.is_empty()
        || agent.len() > 64
        || !agent
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || [
            "__proto__",
            "constructor",
            "toString",
            "valueOf",
            "hasOwnProperty",
            "isPrototypeOf",
            "propertyIsEnumerable",
            "toLocaleString",
            "__defineGetter__",
            "__defineSetter__",
            "__lookupGetter__",
            "__lookupSetter__",
        ]
        .contains(&agent)
        || !now.is_finite()
        || now.abs() > 8_640_000_000_000_000.
    {
        return Err(invalid());
    }
    let date = DateTime::<Utc>::from_timestamp_millis(now.trunc() as i64).ok_or_else(invalid)?;
    if !(0..=9999).contains(&date.year()) {
        return Err(invalid());
    }
    let Some(raw) = raw else {
        return Ok(empty(Status::Absent, false));
    };
    if raw.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    let Ok(mut state) = parse_json(raw) else {
        return Ok(empty(Status::Corrupt, true));
    };
    if !matches!(state, Json::Object(_)) {
        return Ok(empty(Status::Corrupt, true));
    }
    bounded(&state, cancel, &mut (0, 0))?;
    let mut marks = match get(&state, MARKER) {
        Some(v @ Json::Object(_)) => v.clone(),
        Some(Json::Array(_)) => return Err(invalid()),
        _ => object(vec![]),
    };
    if truthy(get(&marks, agent)) {
        return Ok(empty(Status::Already, false));
    }
    let completed = match get(&state, "completed") {
        Some(Json::Object(fields)) => fields.as_slice(),
        value if !truthy(value) => &[],
        _ => return Err(invalid()),
    };
    if completed.len() > 10_000 {
        return Err(invalid());
    }
    let needle = format!(":{agent}:").encode_utf16().collect::<Vec<_>>();
    let prefix = "rem:".encode_utf16().collect::<Vec<_>>();
    let mut rows = Vec::new();
    for (key, meta) in completed {
        cancel.check()?;
        let units = key.as_utf16_units();
        if !units.starts_with(&prefix) || !units.windows(needle.len()).any(|v| v == needle) {
            continue;
        }
        if units.len() > 4096 {
            return Err(invalid());
        }
        let at = completed_at(meta, now)?;
        let counts = ["patternsFound", "memoriesProcessed"]
            .into_iter()
            .filter_map(|name| {
                let value = get(meta, name)?;
                match value {
                    Json::Number(n) if n.parse::<f64>().is_ok_and(f64::is_finite) => {
                        Some((name, value.clone()))
                    }
                    _ => None,
                }
            })
            .collect();
        let run_id = JsString::from_utf16_units(
            "migrated:"
                .encode_utf16()
                .chain(units.iter().copied())
                .collect(),
        );
        rows.push(node_value(object(vec![
            ("runId", Json::String(run_id)),
            ("job", text("rem-dream")),
            ("phase", text("rem")),
            ("agentId", text(agent)),
            ("trigger", text("cron")),
            ("startedAt", number(at)),
            ("finishedAt", number(at)),
            ("durationMs", number(0.)),
            ("outcome", text("completed")),
            ("reason", text("migrated")),
            ("attempt", number(1.)),
            ("cost", object(vec![("ms", number(0.))])),
            ("counts", object(counts)),
            ("keys", Json::Array(vec![Json::String(key.clone())])),
            ("idempotencyKey", Json::String(key.clone())),
            ("migrated", Json::Bool(true)),
            ("sweep", text(&sweep(at)?)),
            ("llmSession", Json::Bool(false)),
        ])));
    }
    set(
        &mut marks,
        agent,
        text(&date.to_rfc3339_opts(SecondsFormat::Millis, true)),
    )?;
    set(&mut state, MARKER, marks)?;
    bounded(&state, cancel, &mut (0, 0))?;
    cancel.check()?;
    Ok(Plan {
        status: Status::Migrated,
        rows,
        state: Some(node_value(state)),
        preserve_original: true,
    })
}
