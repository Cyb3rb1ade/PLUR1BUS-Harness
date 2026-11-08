//! Node-compatible import identities and persisted content/binding/metadata digests.
use crate::text::{
    js::{js_trim, JsString},
    json::{write_json, TolerantJsonValue as Json},
};
use serde::{Deserialize, Serialize};

/// Stable UUID v5 in the URL namespace. Input is the already-validated import tuple;
/// this function deliberately does not trim or case-fold either component.
pub fn import_card_id(agent: &str, key: &str) -> String {
    use sha1::{Digest, Sha1};
    let namespace = [
        0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
    ];
    let mut hash = Sha1::new();
    hash.update(namespace);
    hash.update(agent.as_bytes());
    hash.update([0]);
    hash.update(key.as_bytes());
    let digest = hash.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// Hashes only; neither the ledger nor its diagnostics need plaintext field values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportDigest {
    /// Text and summary projection.
    pub content: String,
    /// Scope, proven owner, workspace and agent projection.
    pub binding: String,
    /// User-editable metadata projection, excluding retrieval and dynamics.
    pub meta: String,
}
impl ImportDigest {
    /// Node's lowercase 16-hex validation for old ledger baselines.
    pub fn is_valid(&self) -> bool {
        [&self.content, &self.binding, &self.meta].iter().all(|s| {
            s.len() == 16
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    }
}

/// Digest a stored row, including legacy UTF-16 text, with ECMAScript coercion and
/// number serialization. Float32 noise is rounded to six decimals before hashing.
pub fn import_row_digest(row: &Json) -> ImportDigest {
    ImportDigest {
        content: group(row, &["text", "summary"]),
        binding: group(
            row,
            &[
                "scope",
                "ownerUserId",
                "workspaceId",
                "workspaceKey",
                "agentId",
            ],
        ),
        meta: group(
            row,
            &[
                "category",
                "importance",
                "neverForget",
                "memoryClass",
                "validFrom",
                "validUntil",
                "epistemicStatus",
                "updatedAt",
            ],
        ),
    }
}

pub(super) fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .rev()
            .find(|(k, _)| *k == JsString::from(key))
            .map(|(_, v)| v),
        _ => None,
    }
}

fn group(row: &Json, fields: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let projection = Json::Array(
        fields
            .iter()
            .map(|key| {
                let value = field(row, key).unwrap_or(&Json::Null);
                let canonical = match *key {
                    "neverForget" => Json::Bool(
                        matches!(value, Json::Bool(true))
                            || matches!(value, Json::Number(n) if n.parse::<f64>() == Ok(1.))
                            || matches!(value, Json::String(s) if *s == JsString::from("true")),
                    ),
                    "importance" | "validFrom" | "validUntil" | "updatedAt" => {
                        let mut number = number(value);
                        if !number.is_finite() {
                            number = 0.;
                        }
                        if number.fract() != 0. {
                            let scaled = number * 1e6;
                            let floor = scaled.floor();
                            number = (if scaled - floor < 0.5 {
                                floor
                            } else {
                                floor + 1.
                            }) / 1e6;
                        }
                        Json::Number(number_string(number))
                    }
                    _ => Json::String(if matches!(value, Json::Null) {
                        JsString::default()
                    } else {
                        string(value)
                    }),
                };
                Json::Array(vec![Json::String((*key).into()), canonical])
            })
            .collect(),
    );
    format!("{:x}", Sha256::digest(write_json(&projection).as_bytes()))[..16].to_owned()
}

fn number_string(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

pub(super) fn string(value: &Json) -> JsString {
    match value {
        Json::Null => "null".into(),
        Json::Bool(true) => "true".into(),
        Json::Bool(false) => "false".into(),
        Json::Number(n) => number_string(n.parse().unwrap_or(f64::NAN)).into(),
        Json::String(s) => s.clone(),
        Json::Object(_) => "[object Object]".into(),
        Json::Array(items) => {
            let mut units = Vec::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    units.push(u16::from(b','));
                }
                if !matches!(item, Json::Null) {
                    units.extend(string(item).into_utf16_units());
                }
            }
            JsString::from_utf16_units(units)
        }
    }
}

pub(super) fn number(value: &Json) -> f64 {
    match value {
        Json::Null | Json::Bool(false) => 0.,
        Json::Bool(true) => 1.,
        Json::Number(n) => n.parse().unwrap_or(f64::NAN),
        Json::Object(_) => f64::NAN,
        Json::Array(_) | Json::String(_) => {
            let text = string(value).to_utf8_lossy();
            let text = js_trim(&text);
            if text.is_empty() {
                return 0.;
            }
            for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
                if text
                    .get(..2)
                    .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
                {
                    let digits = &text[2..];
                    if digits.is_empty() {
                        return f64::NAN;
                    }
                    return digits
                        .chars()
                        .try_fold(0., |n, c| {
                            c.to_digit(radix)
                                .map(|digit| n * f64::from(radix) + f64::from(digit))
                        })
                        .unwrap_or(f64::NAN);
                }
            }
            text.parse().unwrap_or(f64::NAN)
        }
    }
}
