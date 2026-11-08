//! Closed migration envelopes with opaque UTF-16-preserving JSON payloads.
use super::state::StateError;
use crate::{
    ops::import_primitives::field,
    text::{js::JsString, json::TolerantJsonValue as Json},
};

pub(super) const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub(super) const FIELDS: &[&str] = &[
    "id",
    "state",
    "revision",
    "createdAt",
    "updatedAt",
    "planDigest",
    "confirmation",
    "source",
    "target",
    "cursor",
    "receipts",
    "error",
    "configRevision",
    "policyRevision",
];
pub(super) fn object(value: &Json) -> Result<&[(JsString, Json)], StateError> {
    match value {
        Json::Object(v) => Ok(v),
        _ => Err(StateError::Invalid("invalid migration record")),
    }
}
pub(super) fn text(value: &Json) -> Option<String> {
    match value {
        Json::String(s) => String::from_utf16(s.as_utf16_units()).ok(),
        _ => None,
    }
}
pub(super) fn string(value: &str) -> Json {
    Json::String(value.into())
}
pub(super) fn number(value: u64) -> Json {
    Json::Number(value.to_string())
}
pub(super) fn get_text(value: &Json, key: &str) -> Option<String> {
    field(value, key).and_then(text)
}
pub(super) fn integer(value: &Json) -> Option<u64> {
    let Json::Number(s) = value else {
        return None;
    };
    let n = s.parse::<f64>().ok()?;
    (n.is_finite() && (0. ..=MAX_SAFE as f64).contains(&n) && n.fract() == 0.).then_some(n as u64)
}
pub(super) fn revision(value: &Json) -> Result<u64, StateError> {
    field(value, "revision")
        .and_then(integer)
        .ok_or(StateError::InvalidState)
}
pub(super) fn increment(value: u64) -> Result<u64, StateError> {
    if value >= MAX_SAFE {
        Err(StateError::RevisionOverflow)
    } else {
        Ok(value + 1)
    }
}
pub(super) fn put(value: &mut Json, key: &str, next: Json) -> Result<(), StateError> {
    let Json::Object(entries) = value else {
        return Err(StateError::InvalidState);
    };
    let key = JsString::from(key);
    if let Some((_, v)) = entries.iter_mut().find(|(k, _)| *k == key) {
        *v = next;
    } else {
        entries.push((key, next));
    }
    Ok(())
}
pub(super) fn envelope(revision: u64, migrations: Json) -> Json {
    Json::Object(vec![
        ("schemaVersion".into(), number(1)),
        ("revision".into(), number(revision)),
        ("migrations".into(), migrations),
    ])
}
pub(super) fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn index(key: &JsString) -> Option<u32> {
    let s = String::from_utf16(key.as_utf16_units()).ok()?;
    let n = s.parse::<u32>().ok()?;
    (n < u32::MAX && n.to_string() == s).then_some(n)
}
/// Apply JSON.parse/JSON.stringify object and number semantics without losing lone surrogates.
pub(super) fn normalize(value: &Json, depth: usize) -> Result<Json, StateError> {
    if depth >= 128 && matches!(value, Json::Object(_) | Json::Array(_)) {
        return Err(StateError::Invalid("migration nesting limit"));
    }
    Ok(match value {
        Json::Number(s) => {
            let n = s
                .parse::<f64>()
                .map_err(|_| StateError::Invalid("invalid migration state number"))?;
            if !n.is_finite() {
                return Err(StateError::Invalid("invalid migration state number"));
            }
            Json::Number(ryu_js::Buffer::new().format(n).to_owned())
        }
        Json::Array(items) => Json::Array(
            items
                .iter()
                .map(|v| normalize(v, depth + 1))
                .collect::<Result<_, _>>()?,
        ),
        Json::Object(items) => {
            let mut result: Vec<(JsString, Json)> = Vec::new();
            for (key, value) in items {
                let value = normalize(value, depth + 1)?;
                if let Some((_, existing)) = result.iter_mut().find(|(k, _)| k == key) {
                    *existing = value;
                } else {
                    result.push((key.clone(), value));
                }
            }
            result.sort_by_key(|(key, _)| index(key).map_or((1, 0), |n| (0, n)));
            Json::Object(result)
        }
        other => other.clone(),
    })
}
pub(super) fn safe_payload(value: &Json) -> Result<(), StateError> {
    match value {
        Json::Object(items) => {
            for (key, value) in items {
                if [
                    "apikey",
                    "token",
                    "resolvedsecret",
                    "secretvalue",
                    "credentialvalue",
                ]
                .contains(&key.to_utf8_lossy().to_lowercase().as_str())
                {
                    return Err(StateError::Invalid(
                        "secret-bearing migration state field is forbidden",
                    ));
                }
                safe_payload(value)?;
            }
        }
        Json::Array(items) => {
            for v in items {
                safe_payload(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn patch(value: &Json) -> Result<Json, StateError> {
    let v = normalize(value, 0)?;
    for (key, _) in object(&v)? {
        let key = key.to_utf8_lossy();
        if !FIELDS.contains(&key.as_str())
            || [
                "id",
                "state",
                "revision",
                "createdAt",
                "updatedAt",
                "planDigest",
            ]
            .contains(&key.as_str())
        {
            return Err(StateError::Invalid("invalid migration patch field"));
        }
    }
    safe_payload(&v)?;
    Ok(v)
}
pub(super) fn state_valid(state: &str) -> bool {
    matches!(
        state,
        "planned"
            | "confirmed"
            | "running"
            | "validating"
            | "ready_to_switch"
            | "switching"
            | "completed"
            | "failed"
            | "rollback_planned"
            | "rolling_back"
            | "rolled_back"
    )
}
pub(super) fn transition_valid(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("planned", "confirmed")
            | ("confirmed", "running")
            | (
                "running" | "validating" | "switching" | "rolling_back",
                "failed"
            )
            | ("running", "validating")
            | ("validating", "ready_to_switch")
            | ("ready_to_switch", "switching")
            | ("switching", "completed")
            | ("completed", "rollback_planned")
            | ("rollback_planned", "rolling_back")
            | ("rolling_back", "rolled_back")
    )
}
fn date_valid(value: &str) -> bool {
    // Node-produced state timestamps are ISO; also accept its ordinary RFC/date-only legacy forms.
    if chrono::DateTime::parse_from_rfc3339(value).is_ok()
        || chrono::DateTime::parse_from_rfc2822(value).is_ok()
        || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
    {
        return true;
    }
    // TimeClip's extended year range exceeds chrono's supported range. Round-trip the ISO tuple.
    if value.len() == 27 && matches!(value.as_bytes()[0], b'+' | b'-') {
        let parsed = (|| {
            let y = value.get(..7)?.parse::<i64>().ok()?;
            let m = value.get(8..10)?.parse::<i64>().ok()?;
            let d = value.get(11..13)?.parse::<i64>().ok()?;
            let h = value.get(14..16)?.parse::<i64>().ok()?;
            let min = value.get(17..19)?.parse::<i64>().ok()?;
            let s = value.get(20..22)?.parse::<i64>().ok()?;
            let ms = value.get(23..26)?.parse::<i64>().ok()?;
            let adjusted = y - i64::from(m <= 2);
            let era = adjusted.div_euclid(400);
            let yo = adjusted - era * 400;
            let mp = m + if m > 2 { -3 } else { 9 };
            let day =
                era * 146097 + yo * 365 + yo / 4 - yo / 100 + (153 * mp + 2) / 5 + d - 1 - 719468;
            crate::recall::render_date::iso_timestamp(
                (day * 86400000 + h * 3600000 + min * 60000 + s * 1000 + ms) as f64,
            )
            .ok()
        })();
        return parsed.as_deref() == Some(value);
    }
    false
}
pub(super) fn record(value: &Json, id: &str) -> Result<(), StateError> {
    let entries = object(value)?;
    if entries
        .iter()
        .any(|(k, _)| !FIELDS.contains(&k.to_utf8_lossy().as_str()))
    {
        return Err(StateError::Invalid("invalid migration record field"));
    }
    if !id_valid(id) || get_text(value, "id").as_deref() != Some(id) {
        return Err(StateError::Invalid("invalid migration id"));
    }
    if !get_text(value, "state").is_some_and(|v| state_valid(&v)) {
        return Err(StateError::Invalid("invalid migration state"));
    }
    if revision(value).unwrap_or(0) == 0 {
        return Err(StateError::Invalid("invalid migration revision"));
    }
    for key in ["createdAt", "updatedAt"] {
        if !get_text(value, key).is_some_and(|v| date_valid(&v)) {
            return Err(StateError::Invalid("invalid migration timestamp"));
        }
    }
    let digest = get_text(value, "planDigest")
        .filter(|s| s.strip_prefix("sha256:").is_some_and(hash))
        .ok_or(StateError::Invalid("invalid migration plan digest"))?;
    safe_payload(value)?;
    if let Some(c) = field(value, "confirmation") {
        let error = || StateError::Invalid("invalid migration confirmation");
        let entries = object(c).map_err(|_| error())?;
        if entries.len() != 4
            || entries.iter().any(|(k, _)| {
                !["schemaVersion", "tokenHash", "planDigest", "expiresAt"]
                    .contains(&k.to_utf8_lossy().as_str())
            })
        {
            return Err(error());
        }
        if field(c, "schemaVersion").and_then(integer) != Some(1)
            || get_text(c, "planDigest").as_deref() != Some(&digest)
            || !get_text(c, "tokenHash").is_some_and(|v| hash(&v))
            || field(c, "expiresAt").and_then(integer).unwrap_or(0) == 0
        {
            return Err(error());
        }
    }
    Ok(())
}
pub(super) fn state(value: &Json) -> Result<Json, StateError> {
    let v = normalize(value, 0).map_err(|_| StateError::InvalidState)?;
    let entries = object(&v).map_err(|_| StateError::InvalidState)?;
    if entries.len() != 3 || field(&v, "schemaVersion").and_then(integer) != Some(1) {
        return Err(StateError::InvalidState);
    }
    let rev = revision(&v)?;
    let migrations = field(&v, "migrations").ok_or(StateError::InvalidState)?;
    for (key, r) in object(migrations).map_err(|_| StateError::InvalidState)? {
        record(r, &key.to_utf8_lossy()).map_err(|_| StateError::InvalidState)?;
    }
    Ok(envelope(rev, migrations.clone()))
}
