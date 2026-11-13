//! N3 approval metadata and payload revalidation. Persistence and source
//! revalidation belong to the authority-bound proposal writer.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::json::{write_json, TolerantJsonValue as Json},
};
use sha2::{Digest, Sha256};

const MAX_PAYLOAD_BYTES: usize = 512 * 1024;

fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    super::metadata::get(value, name)
}

fn as_string(value: Option<&Json>) -> Option<String> {
    match value {
        Some(Json::String(value)) => Some(value.to_utf8_lossy()),
        _ => None,
    }
}

fn text(value: &str) -> Json {
    Json::String(value.into())
}

fn object(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(name, value)| ((*name).into(), value.clone()))
            .collect(),
    )
}

fn set(item: &mut Json, key: &str, value: Json) -> Result<(), StoreError> {
    let Json::Object(fields) = item else {
        return Err(StoreError::InvalidInput);
    };
    let key = key.into();
    if let Some((_, prior)) = fields.iter_mut().find(|(name, _)| name == &key) {
        *prior = value;
    } else {
        fields.push((key, value));
    }
    Ok(())
}

fn canonical(value: &Json, depth: usize, cancel: &Cancel) -> Result<Json, EngineError> {
    cancel.check()?;
    if depth > 64 {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(match value {
        Json::Object(fields) => {
            let mut fields = fields.iter().collect::<Vec<_>>();
            fields.sort_by(|a, b| a.0.as_utf16_units().cmp(b.0.as_utf16_units()));
            if fields.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                return Err(StoreError::InvalidInput.into());
            }
            Json::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| Ok((key.clone(), canonical(value, depth + 1, cancel)?)))
                    .collect::<Result<Vec<_>, EngineError>>()?,
            )
        }
        Json::Array(items) => Json::Array(
            items
                .iter()
                .map(|value| canonical(value, depth + 1, cancel))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Json::Number(raw) => {
            let number = raw.parse::<f64>().map_err(|_| StoreError::InvalidInput)?;
            crate::capture::dynamics::json_number(number)
        }
        other => other.clone(),
    })
}

/// Exact Node content address over sorted UTF-16 keys and JSON number formatting.
pub fn payload_hash(value: &Json, cancel: &Cancel) -> Result<String, EngineError> {
    let canonical = canonical(value, 0, cancel)?;
    let bytes = write_json(&canonical);
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(format!("sha256:{:x}", Sha256::digest(bytes.as_bytes())))
}

/// Identifies the actor already authorized by the job or human review path.
pub enum Reviewer<'a> {
    /// Automatic approval is eligible only for low-risk adversarial passes.
    AutoLowRisk,
    /// Existing, authenticated human reviewer.
    Human(&'a str),
}

/// Produce the same approval envelope for either actor. Callers must persist
/// this state and revalidate the current payload before applying an effect.
pub fn approve(
    item: &Json,
    reviewer: Reviewer<'_>,
    now_ms: i64,
    cancel: &Cancel,
) -> Result<Option<Json>, EngineError> {
    cancel.check()?;
    let status = as_string(field(item, "status"));
    if matches!(status.as_deref(), Some("applied" | "blocked")) {
        return Ok(None);
    }
    let (by, source) = match reviewer {
        Reviewer::AutoLowRisk => {
            let adversarial =
                field(item, "adversarialReview").and_then(|value| field(value, "status"));
            if status.as_deref() != Some("pending")
                || field(item, "risk") != Some(&text("low"))
                || adversarial != Some(&text("pass"))
                || field(item, "type") == Some(&text("vault_hygiene"))
            {
                return Ok(None);
            }
            ("auto", "auto_low_risk")
        }
        Reviewer::Human(id) => (id, "human_review"),
    };
    let id = field(item, "id")
        .filter(|id| matches!(id, Json::String(value) if !value.is_empty()))
        .ok_or(StoreError::InvalidInput)?;
    if by.is_empty() || by.len() > 256 {
        return Err(StoreError::InvalidInput.into());
    }
    let now = chrono::DateTime::from_timestamp_millis(now_ms)
        .ok_or(StoreError::InvalidInput)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let empty = object(&[]);
    let preview = field(item, "applyPreview");
    let payload = preview
        .and_then(|value| field(value, "payload"))
        .unwrap_or(&empty);
    let hash = match as_string(preview.and_then(|value| field(value, "payloadHash"))) {
        Some(hash) if !hash.is_empty() => hash,
        _ => payload_hash(payload, cancel)?,
    };
    let source_hash = field(item, "preconditions")
        .and_then(|value| field(value, "sourceHash"))
        .and_then(|value| as_string(Some(value)))
        .unwrap_or_default();
    let metadata_hash = payload_hash(
        &object(&[
            ("itemId", id.clone()),
            ("payloadHash", text(&hash)),
            ("sourceHash", text(&source_hash)),
            ("approvedBy", text(by)),
            ("approvedAt", text(&now)),
            ("approvalSource", text(source)),
        ]),
        cancel,
    )?;
    let mut approved = item.clone();
    let snooze = field(item, "snoozedUntil")
        .filter(|value| super::metadata::truthy(Some(value)))
        .cloned()
        .unwrap_or_else(|| text(""));
    for (name, value) in [
        ("status", text("approved")),
        ("approvedPayloadHash", text(&hash)),
        (
            "approvalMetadata",
            object(&[
                ("approvedBy", text(by)),
                ("approvedAt", text(&now)),
                ("approvalSource", text(source)),
                ("approvedPayloadHash", text(&hash)),
                ("approvalHash", text(&metadata_hash)),
            ]),
        ),
        ("snoozedUntil", snooze),
        ("updatedAt", text(&now)),
    ] {
        set(&mut approved, name, value)?;
    }
    if matches!(reviewer, Reviewer::AutoLowRisk) {
        set(&mut approved, "approvedAt", text(&now))?;
        set(&mut approved, "approvedBy", text(by))?;
    }
    Ok(Some(approved))
}

/// Fixed diagnostic codes. An apply writer still checks the source, scope and lease.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Approval metadata is forbidden inside the immutable payload.
    MetadataInPayload,
    /// An imported note cannot mark itself trusted.
    SourceTrust,
    /// Automatic approval does not authorize user-wide visibility.
    GlobalScope,
    /// The preview did not carry a hash.
    MissingPreviewHash,
    /// The actual payload differs from the proposed payload.
    PayloadDrift,
    /// The approval did not carry a hash.
    MissingApprovalHash,
    /// Approval and preview hashes do not match.
    ApprovalDrift,
    /// The item is not in an approved state.
    Status,
}

/// Recompute the semantic payload hash from the current row before a writer
/// consults its own source-backed evidence and executes a scoped effect.
pub fn validate_payload(item: &Json, cancel: &Cancel) -> Result<Result<(), Refusal>, EngineError> {
    cancel.check()?;
    if field(item, "status") != Some(&text("approved")) {
        return Ok(Err(Refusal::Status));
    }
    let empty = object(&[]);
    let preview = field(item, "applyPreview");
    let payload = preview
        .and_then(|value| field(value, "payload"))
        .unwrap_or(&empty);
    if !matches!(payload, Json::Object(_)) {
        return Err(StoreError::InvalidInput.into());
    }
    if [
        "trustLevel",
        "approvedTrustLevel",
        "appliedTrustLevel",
        "approvedBy",
        "approvedAt",
        "approvalSource",
        "approvalHash",
    ]
    .iter()
    .any(|name| field(payload, name).is_some())
    {
        return Ok(Err(Refusal::MetadataInPayload));
    }
    if field(payload, "sourceTrustLevel")
        .is_some_and(|v| super::metadata::truthy(Some(v)) && v != &text("untrusted_obsidian"))
    {
        return Ok(Err(Refusal::SourceTrust));
    }
    let metadata = field(item, "approvalMetadata");
    let explicit_global = field(item, "explicitGlobalApproval") == Some(&Json::Bool(true))
        || metadata.and_then(|v| field(v, "explicitGlobalApproval")) == Some(&Json::Bool(true));
    if (field(payload, "scope") == Some(&text("user"))
        || field(item, "targetScope") == Some(&text("global_user")))
        && !explicit_global
    {
        return Ok(Err(Refusal::GlobalScope));
    }
    let Some(proposed) =
        as_string(preview.and_then(|value| field(value, "payloadHash"))).filter(|v| !v.is_empty())
    else {
        return Ok(Err(Refusal::MissingPreviewHash));
    };
    if payload_hash(payload, cancel)? != proposed {
        return Ok(Err(Refusal::PayloadDrift));
    }
    let approved = as_string(field(item, "approvedPayloadHash"))
        .filter(|v| !v.is_empty())
        .or_else(|| as_string(metadata.and_then(|value| field(value, "approvedPayloadHash"))));
    match approved.as_deref().filter(|v| !v.is_empty()) {
        None => Ok(Err(Refusal::MissingApprovalHash)),
        Some(approved) if approved != proposed => Ok(Err(Refusal::ApprovalDrift)),
        Some(_) => Ok(Ok(())),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "literal recorded test vectors")]
mod tests {
    use super::*;
    use crate::text::json::parse_json;

    fn cases() -> (i64, Vec<Json>) {
        let fixture = parse_json(include_str!(
            "../../tests/fixtures/jobs/review-approval.json"
        ))
        .unwrap();
        let Json::Number(now) = field(&fixture, "now").unwrap() else {
            panic!("fixture time")
        };
        let Json::Array(cases) = field(&fixture, "cases").unwrap() else {
            panic!("fixture cases")
        };
        (now.parse().unwrap(), cases.clone())
    }

    #[test]
    fn auto_and_human_approval_match_release_and_drift_never_reaches_apply() {
        let (now, cases) = cases();
        let cancel = Cancel::never();
        for case in cases {
            let name = as_string(field(&case, "name")).unwrap();
            let item = field(&case, "item").unwrap();
            let reviewer = if name == "human" {
                Reviewer::Human("operator")
            } else {
                Reviewer::AutoLowRisk
            };
            let mut approved = approve(item, reviewer, now, &cancel).unwrap().unwrap();
            let golden = field(&case, "approved").unwrap();
            assert_eq!(
                canonical(&approved, 0, &cancel).unwrap(),
                canonical(golden, 0, &cancel).unwrap(),
                "{name}"
            );
            if let Some(drift) = field(&case, "drift") {
                let mut preview = field(&approved, "applyPreview").unwrap().clone();
                let mut payload = field(&preview, "payload").unwrap().clone();
                set(&mut payload, "text", drift.clone()).unwrap();
                set(&mut preview, "payload", payload).unwrap();
                set(&mut approved, "applyPreview", preview).unwrap();
            }
            let verdict = validate_payload(&approved, &cancel).unwrap();
            match name.as_str() {
                "drift" => assert_eq!(verdict, Err(Refusal::PayloadDrift)),
                "scope" => assert_eq!(verdict, Err(Refusal::GlobalScope)),
                _ => assert_eq!(verdict, Ok(()), "{name}"),
            }
        }
    }

    #[test]
    fn automatic_approval_needs_an_exact_pass_and_low_risk() {
        let (now, cases) = cases();
        let mut item = field(&cases[0], "item").unwrap().clone();
        set(&mut item, "risk", text("medium")).unwrap();
        assert!(approve(&item, Reviewer::AutoLowRisk, now, &Cancel::never())
            .unwrap()
            .is_none());
        set(&mut item, "risk", text("low")).unwrap();
        set(
            &mut item,
            "adversarialReview",
            object(&[("status", text("unknown"))]),
        )
        .unwrap();
        assert!(approve(&item, Reviewer::AutoLowRisk, now, &Cancel::never())
            .unwrap()
            .is_none());
    }
}
