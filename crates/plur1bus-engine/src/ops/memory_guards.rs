//! C7 model-facing store/forget decisions, shared by native adapters before side effects.
use super::import_primitives::{field, number, string};
use crate::{
    capture::{categorize::MEMORY_CATEGORIES, dynamics::MANUAL_CORE_IMPORTANCE},
    contract::limits::MEMORY_TEXT,
    text::{js::js_trim, json::TolerantJsonValue as Json},
};

/// Explicit store rejection, with the stable Node reason and user-visible explanation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoreRejection {
    /// `invalid_text`, `invalid_category`, or `ttl_conflicts_with_core_importance`.
    pub reason: &'static str,
    /// Fixed validation explanation, never a copy of submitted memory text.
    pub error: String,
}
fn text_error(error: String) -> StoreRejection {
    StoreRejection {
        reason: "invalid_text",
        error,
    }
}
/// Reject missing/blank/oversize text and unknown categories before opening a store or embedding.
/// Omitted, null and empty categories remain valid so the caller may derive a category.
pub fn validate_store(params: &Json) -> Result<(), StoreRejection> {
    if let Some(value) = field(params, "text").filter(|v| !matches!(v, Json::Null)) {
        let length = string(value).utf16_len();
        if length > MEMORY_TEXT {
            return Err(text_error(format!("memory text exceeds maximum length of {MEMORY_TEXT} characters (received {length})")));
        }
    }
    let Some(Json::String(text)) = field(params, "text") else {
        return Err(text_error(
            "memory text is required and must not be blank".into(),
        ));
    };
    if js_trim(&text.to_utf8_lossy()).is_empty() {
        return Err(text_error(
            "memory text is required and must not be blank".into(),
        ));
    }
    let accepted = match field(params, "category") {
        None | Some(Json::Null) => true,
        Some(Json::String(s)) => {
            s.is_empty() || MEMORY_CATEGORIES.contains(&s.to_utf8_lossy().as_str())
        }
        _ => false,
    };
    if !accepted {
        return Err(StoreRejection {
            reason: "invalid_category",
            error: format!("category must be one of: {}", MEMORY_CATEGORIES.join(", ")),
        });
    }
    Ok(())
}
/// Resolve only an own key of the configured TTL map. Prototype names cannot manufacture a TTL.
pub fn resolve_ttl_ms(map: &Json, ttl: Option<&Json>) -> f64 {
    let Some(Json::String(key)) = ttl else {
        return 0.;
    };
    let value = match map {
        Json::Object(fields) => fields
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map_or(0., |(_, v)| number(v)),
        _ => 0.,
    };
    if value.is_nan() || value == 0. {
        0.
    } else {
        value
    }
}
/// Compute expiry only after importance assessment; the intentional core band forbids finite TTL.
pub fn store_expiry(now: f64, ttl_ms: f64, importance: f64) -> Result<f64, StoreRejection> {
    let expiry = if ttl_ms > 0. { now + ttl_ms } else { 0. };
    if expiry > 0. && importance >= MANUAL_CORE_IMPORTANCE {
        return Err(StoreRejection {
            reason: "ttl_conflicts_with_core_importance",
            error:
                "importance 0.95 and above is permanent core memory; omit ttl or lower importance"
                    .into(),
        });
    }
    Ok(expiry)
}
/// A query cannot authorize deletion merely because exactly one low-similarity row was found.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForgetDecision {
    /// The explicit model-destructive-operation configuration refused the operation.
    Blocked,
    /// No caller-visible result exists.
    None,
    /// Return visible candidates and require an explicit id.
    Confirm,
    /// A single sufficiently similar visible result may enter the normal archive/tombstone path.
    Forget,
}
/// Decide only over already ACL-filtered scores. This function grants no authority and mutates
/// nothing; an adapter must recheck the selected row through the caller-bound forget operation.
/// Already-forgotten candidates use the same gate, but their text must never be displayed.
pub fn forget_by_query(
    scores: &[f64],
    threshold: f64,
    destructive_allowed: bool,
) -> ForgetDecision {
    if !destructive_allowed {
        return ForgetDecision::Blocked;
    }
    if scores.is_empty() {
        return ForgetDecision::None;
    }
    let minimum = 0.75_f64.max(if threshold.is_finite() { threshold } else { 0. });
    if scores.len() == 1 && scores[0] >= minimum {
        ForgetDecision::Forget
    } else {
        ForgetDecision::Confirm
    }
}
