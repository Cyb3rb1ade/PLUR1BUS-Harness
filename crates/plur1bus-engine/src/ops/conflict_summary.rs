//! Counts over the caller-authorized complete records, never an authority source.
use serde::{Deserialize, Serialize};
use serde_json::Value;
/// Current caller-visible counts derived from the authoritative complete log snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSummary {
    /// Number of authorized durable conflict entries.
    pub count: usize,
    /// Earliest valid timestamp, including Unix epoch zero.
    pub oldest_timestamp: Option<i64>,
    /// Latest valid timestamp, independent of input order.
    pub newest_timestamp: Option<i64>,
    /// Actual UTF-8 bytes of authorized records, including their line delimiters.
    pub size_bytes: usize,
    /// Entries explicitly marked pending.
    pub pending_count: usize,
    /// Host clock for this projection, not the timestamp of a model call.
    pub last_updated_at: String,
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.),
        _ => true,
    }
}
pub(super) fn summarize<'a>(
    rows: impl Iterator<Item = &'a (Value, usize)>,
    now: String,
) -> ConflictSummary {
    let mut out = ConflictSummary {
        count: 0,
        oldest_timestamp: None,
        newest_timestamp: None,
        size_bytes: 0,
        pending_count: 0,
        last_updated_at: now,
    };
    for (row, bytes) in rows {
        out.count += 1;
        out.size_bytes += bytes;
        let timestamp = match &row["timestamp"] {
            Value::String(v) => chrono::DateTime::parse_from_rfc3339(v)
                .ok()
                .map(|v| v.timestamp_millis()),
            Value::Number(v) => v.as_i64(),
            _ => None,
        };
        if let Some(t) = timestamp {
            out.oldest_timestamp = Some(out.oldest_timestamp.map_or(t, |old| old.min(t)));
            out.newest_timestamp = Some(out.newest_timestamp.map_or(t, |old| old.max(t)));
        }
        out.pending_count += usize::from(truthy(&row["pending"]) || row["status"] == "pending");
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::panic,
        reason = "actual Node fixture assertions"
    )]
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn actual_node_log_and_summary_cases_keep_observations_and_name_every_native_difference() {
        let raw = include_bytes!("../../tests/fixtures/capture/golden/conflict-ledger.json");
        let golden: Value = serde_json::from_slice(raw).unwrap();
        let exceptions: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/capture/conflict-ledger-exceptions.json"
        ))
        .unwrap();
        assert_eq!(
            exceptions["nodeGoldenSha256"],
            format!("{:x}", Sha256::digest(raw))
        );
        for case in golden["cases"].as_array().unwrap() {
            let exception = exceptions["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["name"] == case["name"]);
            if exception.is_some_and(|e| e["refuse"] == true) {
                assert!(crate::ops::conflict_file::records(
                    case["log"].as_str().unwrap().as_bytes()
                )
                .is_err());
                continue;
            }
            let mut bytes = case["prefix"].as_str().unwrap_or("").as_bytes().to_vec();
            for (i, entry) in case["entries"].as_array().unwrap().iter().enumerate() {
                bytes.extend(serde_json::to_vec(entry).unwrap());
                bytes.push(b'\n');
                let rows = crate::ops::conflict_file::records(&bytes).unwrap();
                let actual =
                    serde_json::to_value(summarize(rows.iter(), "2025-01-01T00:00:00.000Z".into()))
                        .unwrap();
                let expected = exception.map_or(&case["after"][i], |e| &e["after"][i]);
                assert_eq!(&actual, expected, "{} step {i}", case["name"]);
            }
            let rows = crate::ops::conflict_file::records(case["log"].as_str().unwrap().as_bytes())
                .unwrap();
            let actual =
                serde_json::to_value(summarize(rows.iter(), "2025-01-01T00:00:00.000Z".into()))
                    .unwrap();
            assert_eq!(
                &actual,
                exception.map_or(&case["rebuilt"], |e| &e["rebuilt"]),
                "{} rebuilt",
                case["name"]
            );
        }
    }
}
