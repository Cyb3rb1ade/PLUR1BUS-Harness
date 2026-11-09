//! Conflict proposal wire shapes and selectors from pinned Node. This grants no apply authority.
//! Model execution and automatic resolver scheduling remain outside this component.
use super::{
    dynamics,
    emotion_json::{get, num, string},
    interference::bounded,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
const RESOLUTIONS: [&str; 4] = ["keep_a", "keep_b", "merge", "uncertain"];
fn text(value: &Json) -> JsString {
    match value {
        Json::String(v) => v.clone(),
        Json::Array(values) => {
            let mut units = Vec::new();
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    units.push(u16::from(b','));
                }
                if !matches!(v, Json::Null) {
                    units.extend_from_slice(text(v).as_utf16_units());
                }
            }
            JsString::from_utf16_units(units)
        }
        other => JsString::from(dynamics::js_string(other).as_str()),
    }
}
fn fallback<'a>(values: &[&'a Json]) -> &'a Json {
    values
        .iter()
        .copied()
        .find(|v| dynamics::truthy(Some(v)))
        .unwrap_or(&Json::Null)
}
fn checked(value: &Json, cancel: &Cancel) -> Result<(), EngineError> {
    bounded(value, cancel, &mut (0, 0))
}
/// Create the observed proposal fields only. Confidence is data, never a permission to mutate.
/// Native confidence outside [0,1] refuses instead of yielding a high-confidence recommendation.
pub fn proposal(
    original: &Json,
    decision: &Json,
    now: i64,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    checked(original, cancel)?;
    checked(decision, cancel)?;
    if !matches!(original, Json::Object(_)) || !matches!(decision, Json::Object(_)) {
        return Err(StoreError::InvalidInput.into());
    }
    let resolution = get(decision, "resolution");
    let valid =
        matches!(resolution,Json::String(v) if RESOLUTIONS.iter().any(|r|v==&JsString::from(*r)));
    let kind = if valid {
        resolution.clone()
    } else {
        string("uncertain")
    };
    let confidence = if valid {
        match get(decision, "confidence") {
            Json::Number(n) => n.parse::<f64>().map_err(|_| StoreError::InvalidInput)?,
            _ => 0.,
        }
    } else {
        0.
    };
    if !confidence.is_finite() || !(0. ..=1.).contains(&confidence) {
        return Err(StoreError::InvalidInput.into());
    }
    let mut fields = vec![
        (JsString::from("original"), original.clone()),
        (JsString::from("resolution"), kind.clone()),
        (JsString::from("confidence"), num(confidence)),
    ];
    let reason = get(decision, "reason");
    if !valid {
        fields.push(("reason".into(), string("invalid_response")));
    } else if let Json::Object(input) = decision {
        if input.iter().any(|(k, _)| k == &JsString::from("reason")) {
            fields.push(("reason".into(), reason.clone()));
        }
    }
    fields.push((
        "recommendation".into(),
        string(if confidence >= 0.9 && kind != string("uncertain") {
            "apply_via_safe_reconsolidation"
        } else {
            "review_only"
        }),
    ));
    if valid && dynamics::truthy(Some(get(decision, "mergedText"))) {
        fields.push(("mergedText".into(), get(decision, "mergedText").clone()));
    }
    let timestamp = chrono::DateTime::from_timestamp_millis(now)
        .ok_or(StoreError::InvalidInput)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fields.push(("resolvedAt".into(), string(&timestamp)));
    fields.push(("dryRun".into(), Json::Bool(false)));
    cancel.check()?;
    Ok(Json::Object(fields))
}
/// Node's existing-ID preference, preserving its raw JSON type. Apply must separately validate an ID.
pub fn apply_id(entry: &Json) -> Result<Json, EngineError> {
    checked(entry, &Cancel::never())?;
    let original = get(entry, "original");
    let selected = fallback(&[
        get(original, "existingMemoryId"),
        get(original, "newMemoryId"),
    ]);
    Ok(if matches!(selected, Json::Null) {
        string("")
    } else {
        selected.clone()
    })
}
/// Node's chosen text, with lossless UTF-16 strings and its JS coercion for legacy arrays/objects.
/// This is selection only; current source access, content bounds and approval are separate.
pub fn apply_text(entry: &Json) -> Result<JsString, EngineError> {
    checked(entry, &Cancel::never())?;
    let original = get(entry, "original");
    let resolution = get(entry, "resolution");
    let selected = if *resolution == string("keep_a") {
        fallback(&[get(original, "existingText")])
    } else if *resolution == string("keep_b") {
        fallback(&[get(original, "newText")])
    } else {
        fallback(&[get(entry, "mergedText"), get(original, "mergedText")])
    };
    Ok(if matches!(selected, Json::Null) {
        JsString::from("")
    } else {
        text(selected)
    })
}
/// Pinned request-shape check. A true flag alone is NOT a host-issued confirmation or ACL grant.
/// The actual adapter must validate the current original caller and its bound approval separately.
pub fn confirmation_gate(conflict: &Json, options: &Json) -> Result<(), &'static str> {
    if *get(options, "confirm") != Json::Bool(true) {
        return Err("confirm_required");
    }
    for selected in [
        fallback(&[
            get(conflict, "existingMemoryId"),
            get(conflict, "newMemoryId"),
        ]),
        fallback(&[get(conflict, "mergedText"), get(conflict, "resolutionText")]),
        fallback(&[get(options, "vector"), get(conflict, "vector")]),
    ] {
        if !dynamics::truthy(Some(selected)) {
            return Err("incomplete_patch");
        }
    }
    Ok(())
}
