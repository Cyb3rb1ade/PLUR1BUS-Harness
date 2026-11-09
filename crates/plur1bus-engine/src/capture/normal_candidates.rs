//! Normal-store selection over already authorized, active, nearest-first query rows.
//! The actual adapter applies current authority before the fixed 10/5 semantic budgets.
use super::{
    dedupe::distance_to_score,
    durable_merge::stable_time,
    dynamics,
    emotion_json::{get, object, string},
    fact_quality::number_json,
    interference::bounded,
    merge_safety,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
/// Explicit finite thresholds; duplicate equality is inclusive and merge's upper bound exclusive.
#[derive(Clone, Copy)]
pub struct Thresholds {
    /// Normal-store duplicate cutoff (not automatic capture's one-neighbor cutoff).
    pub duplicate: f64,
    /// Lowest candidate merge score.
    pub merge: f64,
}
/// Exact Node policy outputs; these values do not carry access or mutation authority.
pub struct Selection {
    /// Matching entries among the first ten authorized active neighbors.
    pub duplicates: Json,
    /// First lexical duplicate with exactly equivalent normalized validity, else null.
    pub safe_duplicate: Json,
    /// Highest merge-band entry from the first five, preserving input order on ties.
    pub merge: Json,
}
fn default(value: &Json, fallback: Json) -> Json {
    if dynamics::truthy(Some(value)) {
        value.clone()
    } else {
        fallback
    }
}
fn score(row: &Json) -> Result<f64, EngineError> {
    let distance = match get(row, "_distance") {
        Json::Null => None,
        Json::Number(v) => Some(v.parse::<f64>().map_err(|_| StoreError::InvalidInput)?),
        _ => return Err(StoreError::InvalidInput.into()),
    };
    if distance.is_some_and(|v| !v.is_finite() || v < 0.) {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(distance_to_score(distance))
}
fn scored(entry: Json, score: f64) -> Json {
    object([
        ("entry", entry),
        ("score", Json::Number(number_json(score))),
    ])
}
fn merge_entry(row: &Json) -> Json {
    let mut fields = vec![
        ("id".into(), get(row, "id").clone()),
        ("text".into(), get(row, "text").clone()),
        (
            "importance".into(),
            if get(row, "importance") == &Json::Null {
                Json::Number("0.5".into())
            } else {
                get(row, "importance").clone()
            },
        ),
    ];
    for name in [
        "agentId",
        "storedBy",
        "workspaceId",
        "workspaceKey",
        "scope",
        "ownerUserId",
        "epistemicStatus",
        "epistemicStatusActor",
        "epistemicStatusReason",
    ] {
        fields.push((
            name.into(),
            default(
                get(row, name),
                string(if name == "scope" { "agent-private" } else { "" }),
            ),
        ));
    }
    fields.push((
        "epistemicStatusUpdatedAt".into(),
        if get(row, "epistemicStatusUpdatedAt") == &Json::Null {
            Json::Number("0".into())
        } else {
            get(row, "epistemicStatusUpdatedAt").clone()
        },
    ));
    fields.push((
        "previousEpistemicStatus".into(),
        default(get(row, "previousEpistemicStatus"), string("")),
    ));
    for name in ["validFrom", "validUntil"] {
        fields.push((
            name.into(),
            if get(row, name) == &Json::Null {
                Json::Number("0".into())
            } else {
                get(row, name).clone()
            },
        ));
    }
    Json::Object(fields)
}
/// Reproduce actual pinned MemoryDB policy, given already active and authorized nearest rows.
/// A query-port response is bounded and canonical; invalid distances are never used as evidence.
pub fn select(
    rows: &[Json],
    incoming: &JsString,
    validity: &Json,
    thresholds: Thresholds,
    cancel: &Cancel,
) -> Result<Selection, EngineError> {
    if rows.len() > 1024
        || incoming.utf16_len() > 1_048_576
        || !thresholds.duplicate.is_finite()
        || !thresholds.merge.is_finite()
        || thresholds.duplicate < 0.
        || thresholds.merge < 0.
        || thresholds.merge > thresholds.duplicate
    {
        return Err(StoreError::InvalidInput.into());
    }
    let mut budget = (0, 0);
    bounded(validity, cancel, &mut budget)?;
    let mut duplicates = Vec::new();
    let mut safe = Json::Null;
    let mut best: Option<(f64, Json)> = None;
    for (i, row) in rows.iter().enumerate() {
        bounded(row, cancel, &mut budget)?;
        if !matches!(row, Json::Object(_))
            || !matches!(get(row, "status"), Json::Null) && get(row, "status") != &string("active")
            || get(row, "epistemicStatus") == &string("invalidated")
        {
            return Err(StoreError::InvalidInput.into());
        }
        let Json::String(text) = get(row, "text") else {
            return Err(StoreError::InvalidInput.into());
        };
        let score = score(row)?;
        if i < 10 && (score >= thresholds.duplicate || text == incoming) {
            let entry = scored(row.clone(), score);
            if safe == Json::Null
                && merge_safety::safe_duplicate(text, incoming)?
                && stable_time(get(row, "validFrom")) == stable_time(get(validity, "validFrom"))
                && stable_time(get(row, "validUntil")) == stable_time(get(validity, "validUntil"))
            {
                safe = entry.clone();
            }
            duplicates.push(entry);
        }
        if i < 5
            && score >= thresholds.merge
            && score < thresholds.duplicate
            && best.as_ref().is_none_or(|(old, _)| score > *old)
        {
            best = Some((score, scored(merge_entry(row), score)));
        }
    }
    cancel.check()?;
    Ok(Selection {
        duplicates: Json::Array(duplicates),
        safe_duplicate: safe,
        merge: best.map_or(Json::Null, |(_, v)| v),
    })
}
