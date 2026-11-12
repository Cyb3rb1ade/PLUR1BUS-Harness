//! C4 status rules with explicit time. Pure calculation is not mutation authorization.
use super::merged_order::{field, string};
use crate::{
    capture::dynamics::number,
    contract::StoreError,
    text::{js::JsString, json::TolerantJsonValue as Json},
};

/// Closed native command surface; unknown commands do not silently become `candidate`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    /// Newly proposed card.
    Candidate,
    /// Active working memory.
    Active,
    /// Explicitly retained card.
    Promoted,
    /// Explicitly de-emphasized card.
    Demoted,
    /// Unresolved competing evidence.
    Conflict,
    /// Excluded from embedding work.
    Pruned,
    /// Deleted card marker.
    Tombstoned,
}
impl Status {
    /// Parse only exact Node status names, without coercing arbitrary input.
    pub fn parse(value: &JsString) -> Option<Self> {
        [
            Self::Candidate,
            Self::Active,
            Self::Promoted,
            Self::Demoted,
            Self::Conflict,
            Self::Pruned,
            Self::Tombstoned,
        ]
        .into_iter()
        .find(|status| value == &JsString::from(status.as_str()))
    }
    /// Exact persisted Node spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::Active => "active",
            Self::Promoted => "promoted",
            Self::Demoted => "demoted",
            Self::Conflict => "conflict",
            Self::Pruned => "pruned",
            Self::Tombstoned => "tombstoned",
        }
    }
}
/// Compute a revision of an object without altering any visibility/owner/source binding.
/// The writer must read and authorize the latest actual row under its workspace lock;
/// accepting a caller-supplied row here does not grant permission to persist it.
/// `now` is a nonempty host-supplied timestamp, never an ambient-clock fallback.
pub fn transition(record: &Json, status: Status, now: &JsString) -> Result<Json, StoreError> {
    let Json::Object(fields) = record else {
        return Err(StoreError::InvalidInput);
    };
    if now.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    let mut out = fields.clone();
    set(
        &mut out,
        "status",
        Json::String(JsString::from(status.as_str())),
    );
    set(&mut out, "updatedAt", Json::String(now.clone()));
    match status {
        Status::Promoted => {
            for name in ["confidence", "salience"] {
                let value = default_half(field(record, name));
                // JS '+' first converts arrays/objects to their default primitive string.
                let boosted = match &value {
                    Json::String(_) | Json::Array(_) | Json::Object(_) => {
                        let mut units = string(&value).as_utf16_units().to_vec();
                        units.extend_from_slice(JsString::from("0.2").as_utf16_units());
                        number(Some(&Json::String(JsString::from_utf16_units(units))))
                    }
                    _ => number(Some(&value)) + 0.2,
                };
                set(&mut out, name, clamped(boosted));
            }
            set_text(&mut out, "embeddingStatus", "stale");
        }
        Status::Demoted => {
            set(
                &mut out,
                "salience",
                clamped(number(Some(&default_half(field(record, "salience")))) - 0.25),
            );
            set_text(&mut out, "embeddingStatus", "stale");
        }
        Status::Pruned => set_text(&mut out, "embeddingStatus", "excluded"),
        Status::Tombstoned => set_text(&mut out, "embeddingStatus", "tombstoned"),
        Status::Active => set_text(
            &mut out,
            "embeddingStatus",
            if field(record, "embeddingStatus") == Some(&Json::String(JsString::from("fresh"))) {
                "fresh"
            } else {
                "pending"
            },
        ),
        Status::Candidate | Status::Conflict => (),
    }
    Ok(Json::Object(out))
}
fn default_half(value: Option<&Json>) -> Json {
    value
        .filter(|value| !matches!(value, Json::Null))
        .cloned()
        .unwrap_or_else(|| Json::Number("0.5".into()))
}
fn clamped(value: f64) -> Json {
    let value = if !value.is_finite() || value <= 0. {
        0.
    } else {
        value.min(1.)
    };
    Json::Number(ryu_js::Buffer::new().format(value).to_owned())
}
fn set_text(fields: &mut Vec<(JsString, Json)>, name: &str, value: &str) {
    set(fields, name, Json::String(JsString::from(value)));
}
fn set(fields: &mut Vec<(JsString, Json)>, name: &str, value: Json) {
    let key = JsString::from(name);
    if let Some(index) = fields.iter().position(|(k, _)| k == &key) {
        fields[index].1 = value;
        let mut pos = 0;
        fields.retain(|(k, _)| {
            let keep = pos == index || k != &key;
            pos += 1;
            keep
        });
    } else {
        fields.push((key, value));
    }
}
