//! Frozen normal-store merge identities and provenance. These pure helpers grant no write authority.
use super::{
    dynamics,
    emotion_json::{get, object, string},
    interference::bounded,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn checked(value: &Json, cancel: &Cancel) -> Result<(), EngineError> {
    bounded(value, cancel, &mut (0, 0))?;
    if !matches!(value, Json::Object(_)) {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(())
}
pub(super) fn stable_time(value: &Json) -> u64 {
    let n = dynamics::number(Some(value));
    if n.is_finite() && n > 0. && n.fract() == 0. && n <= 9_007_199_254_740_991. {
        n as u64
    } else {
        0
    }
}
/// Exact ordered JSON-array key from the normal-store fields, retaining lossless UTF-16.
/// Missing fields become null; validity is a positive safe integer or the unknown marker zero.
pub fn write_key(input: &Json, cancel: &Cancel) -> Result<JsString, EngineError> {
    checked(input, cancel)?;
    let mut fields: Vec<Json> = [
        "workspaceKey",
        "text",
        "category",
        "origin",
        "importance",
        "ttl",
        "sourceUrl",
        "evidenceQuote",
        "scope",
        "ownerUserId",
    ]
    .iter()
    .map(|name| get(input, name).clone())
    .collect();
    fields.extend(
        ["validFrom", "validUntil"]
            .map(|name| Json::Number(stable_time(get(input, name)).to_string())),
    );
    cancel.check()?;
    let key = JsString::from(write_json(&Json::Array(fields)).as_str());
    if key.utf16_len() > 1_048_576 {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(key)
}
/// Actual Node candidate ID plus stable validity marker. This does not authorize deleting its source.
pub fn lineage(candidate: &Json, cancel: &Cancel) -> Result<Json, EngineError> {
    checked(candidate, cancel)?;
    Ok(Json::Array(vec![
        get(candidate, "id").clone(),
        string(&format!(
            "valid-time:{}:{}",
            stable_time(get(candidate, "validFrom")),
            stable_time(get(candidate, "validUntil"))
        )),
    ]))
}
/// The incoming normal-store text has no established trust status. Merging cannot inherit the
/// candidate's trusted status; disputed/invalidated remain so, and the old status stays as evidence.
pub fn epistemic_metadata(
    candidate: &Json,
    now: i64,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    checked(candidate, cancel)?;
    if now.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(StoreError::InvalidInput.into());
    }
    let status = match get(candidate, "epistemicStatus") {
        Json::String(value) => {
            crate::recall::score::normalize_epistemic_status(&value.to_utf8_lossy())
        }
        _ => "untrusted",
    };
    let id = match candidate {
        Json::Object(fields) if !fields.iter().any(|(key, _)| key == &JsString::from("id")) => {
            JsString::from("undefined")
        }
        _ => super::conflict_resolution::text(get(candidate, "id")),
    };
    let mut reason = JsString::from("memory_store merge with ").into_utf16_units();
    reason.extend_from_slice(id.as_utf16_units());
    Ok(object([
        (
            "epistemicStatus",
            string(if matches!(status, "invalidated" | "disputed") {
                status
            } else {
                "untrusted"
            }),
        ),
        ("previousEpistemicStatus", string(status)),
        ("epistemicStatusActor", string("system:merge")),
        (
            "epistemicStatusReason",
            Json::String(JsString::from_utf16_units(reason)),
        ),
        ("epistemicStatusUpdatedAt", Json::Number(now.to_string())),
    ]))
}
/// Stable Node operation key and its derived replacement UUID, not an RFC namespace UUID recipe.
#[derive(Debug, PartialEq, Eq)]
pub struct MergeIdentity {
    /// Complete SHA-256 of the pinned ordered JSON preimage.
    pub idempotency_key: String,
    /// Pinned replacement layout: version nibble 5 and variant nibble a over the digest prefix.
    pub replacement_id: String,
}
/// Compute the exact pinned identity after the caller has selected its effective write key.
/// The normal-store caller falls back to the selected source text when its write key is empty.
pub fn identity(
    agent: &str,
    candidate: &str,
    key: &JsString,
    cancel: &Cancel,
) -> Result<MergeIdentity, EngineError> {
    cancel.check()?;
    crate::context::safe_agent_id(agent).map_err(|_| StoreError::InvalidInput)?;
    if candidate.len() != 36 {
        return Err(StoreError::InvalidInput.into());
    }
    uuid::Uuid::parse_str(candidate).map_err(|_| StoreError::InvalidInput)?;
    if key.as_utf16_units().len() > 1_048_576 {
        return Err(StoreError::InvalidInput.into());
    }
    let preimage = write_json(&Json::Array(vec![
        string("memory_store_merge"),
        string(agent),
        string(candidate),
        Json::String(key.clone()),
    ]));
    let digest = format!("{:x}", Sha256::digest(preimage.as_bytes()));
    cancel.check()?;
    Ok(MergeIdentity {
        idempotency_key: format!("sha256:{digest}"),
        replacement_id: format!(
            "{}-{}-5{}-a{}-{}",
            &digest[..8],
            &digest[8..12],
            &digest[13..16],
            &digest[17..20],
            &digest[20..32]
        ),
    })
}
