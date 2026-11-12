//! Capped decision traces with codepoint-safe previews and diagnostic IDs (RE-D17).

use super::{
    namespace_trace::{NamespaceTrace, TraceLimits},
    trace_redaction::Redactor,
};
use crate::text::{
    js::{self, JsString},
    json::TolerantJsonValue as Json,
};
use serde_json::{json, Value};

/// Request-local policy. Known secrets must be supplied by the owning host, never read from rows.
pub struct TracePolicy {
    /// Maximum preview prefix in UTF-16 units; the Node ellipsis adds one unit when shortened.
    pub max_text_chars: usize,
    /// Independent stream suffix caps.
    pub limits: TraceLimits,
    redactor: Redactor,
}

impl TracePolicy {
    /// Resolve only trace limits; arbitrary config objects are never copied to diagnostic output.
    #[must_use]
    pub fn new(config: &Value, known_secrets: &[String]) -> Self {
        Self {
            max_text_chars: limit(config, "maxTextPreviewChars", 160),
            limits: TraceLimits {
                candidates: limit(config, "maxCandidates", 50),
                decisions: limit(config, "maxDecisions", 200),
                guards: limit(config, "maxGuards", 200),
                store_decisions: limit(config, "maxStoreDecisions", 100),
            },
            redactor: Redactor::new(known_secrets),
        }
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        self.redactor.redact(text)
    }

    /// Redact before cutting, so neither complete nor truncated registered values leak.
    #[must_use]
    pub fn preview(&self, text: &str) -> JsString {
        text_preview(&self.redact(text), self.max_text_chars)
    }

    /// Re-normalize every child stream before exposure, without copying opaque source fields.
    #[must_use]
    pub fn finish(&self, query: &str, streams: &NamespaceTrace, now_ms: i64) -> Json {
        let timestamp = chrono::DateTime::from_timestamp_millis(now_ms)
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();
        let canonical_ids = streams
            .candidates
            .iter()
            .filter_map(|entry| {
                if entry["source"] != "canonical" {
                    return None;
                }
                let id = entry["id"].as_str()?;
                let heading = entry["preview"].as_str()?;
                let mut units = "canonical:".encode_utf16().collect::<Vec<_>>();
                units.extend(text_preview(&self.redact(heading), 40).into_utf16_units());
                Some((id.to_owned(), JsString::from_utf16_units(units)))
            })
            .collect::<std::collections::HashMap<_, _>>();
        let candidates = self.stream(
            &streams.candidates,
            self.limits.candidates,
            Kind::Candidate,
            &timestamp,
            &canonical_ids,
        );
        let decisions = self.stream(
            &streams.decisions,
            self.limits.decisions,
            Kind::Decision,
            &timestamp,
            &canonical_ids,
        );
        let guards = self.stream(
            &streams.guards,
            self.limits.guards,
            Kind::Guard,
            &timestamp,
            &canonical_ids,
        );
        let stores = self.stream(
            &streams.store_decisions,
            self.limits.store_decisions,
            Kind::Store,
            &timestamp,
            &canonical_ids,
        );
        let summary = summary(&decisions, &guards, &stores, candidates.len());
        object(vec![
            ("traceId", string(&format!("rdt-{}", uuid::Uuid::new_v4()))),
            ("createdAt", string(&timestamp)),
            (
                "query",
                object(vec![("text", Json::String(self.preview(query)))]),
            ),
            (
                "config",
                from_value(
                    &json!({"maxCandidates":self.limits.candidates,"maxTextPreviewChars":self.max_text_chars,
                "maxDecisions":self.limits.decisions,"maxGuards":self.limits.guards,"maxStoreDecisions":self.limits.store_decisions}),
                ),
            ),
            ("candidates", Json::Array(candidates)),
            ("decisions", Json::Array(decisions)),
            ("guards", Json::Array(guards)),
            ("storeDecisions", Json::Array(stores)),
            ("summary", from_value(&summary)),
        ])
    }

    fn trace_id(
        &self,
        id: &str,
        canonical_ids: &std::collections::HashMap<String, JsString>,
    ) -> Json {
        if let Some(id) = canonical_ids.get(id) {
            return Json::String(id.clone());
        }
        if let Some(heading) = id.strip_prefix("canonical:") {
            let mut units = "canonical:".encode_utf16().collect::<Vec<_>>();
            units.extend(text_preview(&self.redact(heading), 40).into_utf16_units());
            return Json::String(JsString::from_utf16_units(units));
        }
        string(&self.redact(id))
    }

    fn stream(
        &self,
        source: &[Value],
        cap: usize,
        kind: Kind,
        timestamp: &str,
        canonical_ids: &std::collections::HashMap<String, JsString>,
    ) -> Vec<Json> {
        source
            .iter()
            .filter_map(|entry| self.entry(entry, kind, timestamp, canonical_ids))
            .rev()
            .take(cap)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    fn entry(
        &self,
        entry: &Value,
        kind: Kind,
        timestamp: &str,
        canonical_ids: &std::collections::HashMap<String, JsString>,
    ) -> Option<Json> {
        entry.as_object()?;
        if matches!(kind, Kind::Decision)
            && !matches!(
                entry["action"].as_str(),
                Some("inclusion" | "rejection" | "downrank" | "superseded" | "deduped" | "merged")
            )
        {
            return None;
        }
        let mut fields = Vec::new();
        let (texts, numbers, preview_field, timestamp_field): (&[&str], &[&str], &str, &str) =
            match kind {
                Kind::Candidate => (
                    &["id", "source", "category", "status"],
                    &[
                        "score",
                        "vectorScore",
                        "importanceBoost",
                        "emotionalBoost",
                        "strengthBoost",
                        "graphBoost",
                        "graphDepth",
                    ],
                    "preview",
                    "addedAt",
                ),
                Kind::Decision => (
                    &["memoryId", "action", "stage"],
                    &["finalScore"],
                    "reason",
                    "recordedAt",
                ),
                Kind::Guard => (&["name"], &[], "reason", "recordedAt"),
                Kind::Store => (&["memoryId", "action"], &[], "reason", "recordedAt"),
            };
        for field in texts {
            let default = if *field == "status" { "active" } else { "" };
            fields.push(((*field).to_owned(), {
                let text = entry[field].as_str().unwrap_or(default);
                if matches!(*field, "id" | "memoryId") {
                    self.trace_id(text, canonical_ids)
                } else {
                    string(&self.redact(text))
                }
            }));
        }
        if matches!(kind, Kind::Guard) {
            fields.push(("passed".into(), Json::Bool(entry["passed"] == true)));
            if let Some(id) = entry["memoryId"].as_str() {
                fields.push(("memoryId".into(), self.trace_id(id, canonical_ids)));
            }
        }
        fields.push((
            preview_field.into(),
            Json::String(self.preview(entry[preview_field].as_str().unwrap_or(""))),
        ));
        for field in numbers {
            if let Some(number) = entry[field].as_f64().filter(|number| number.is_finite()) {
                let number = if *field == "graphDepth" {
                    number.floor().max(0.0)
                } else {
                    number
                };
                fields.push(((*field).to_owned(), from_value(&json!(number))));
            }
        }
        for key in ["scoreBreakdown", "temporal"] {
            if let Some(values) = entry[key].as_object() {
                let clean = values
                    .iter()
                    .filter_map(|(key, value)| {
                        let value = match value {
                            Value::String(text) => Json::String(self.preview(text)),
                            Value::Bool(_) | Value::Number(_) => from_value(value),
                            _ => return None,
                        };
                        Some((JsString::from(self.redact(key).as_str()), value))
                    })
                    .collect();
                fields.push((key.into(), Json::Object(clean)));
            }
        }
        if let Some(namespace) = entry["namespace"]
            .as_str()
            .filter(|name| valid_namespace(name))
        {
            fields.push(("namespace".into(), string(namespace)));
        }
        fields.push((timestamp_field.into(), string(timestamp)));
        Some(Json::Object(
            fields
                .into_iter()
                .map(|(key, value)| (JsString::from(key.as_str()), value))
                .collect(),
        ))
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Candidate,
    Decision,
    Guard,
    Store,
}

fn limit(config: &Value, key: &str, default: usize) -> usize {
    config[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .map_or(default, |n| n.floor().max(1.0) as usize)
}
fn valid_namespace(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Node whitespace and word boundaries with codepoint-safe visible cuts (RE-D17/F3).
#[must_use]
pub fn text_preview(value: &str, limit: usize) -> JsString {
    super::output_unicode::well_formed(node_text_preview(value, limit))
}

// Retain the exact Node cut internally, then remove only unpaired units at the
// presentation boundary. Hash/persistence helpers do not call this trace helper.
fn node_text_preview(value: &str, limit: usize) -> JsString {
    let clean = value
        .chars()
        .map(|c| {
            if (c <= '\u{1f}' && c != '\t' && c != '\n') || ('\u{7f}'..='\u{9f}').contains(&c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let clean = clean
        .split(js::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut units = clean.encode_utf16().collect::<Vec<_>>();
    if units.len() <= limit {
        return JsString::from(clean.as_str());
    }
    let mut cut = limit;
    while cut > 0 && units.get(cut) != Some(&32) && units.get(cut - 1) != Some(&32) {
        cut -= 1;
    }
    if cut == 0 {
        cut = limit;
    }
    units.truncate(cut);
    while units.last() == Some(&32) {
        units.pop();
    }
    units.push(0x2026);
    JsString::from_utf16_units(units)
}

pub(crate) fn from_value(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(value) => Json::Bool(*value),
        Value::Number(value) => Json::Number(value.to_string()),
        Value::String(value) => string(value),
        Value::Array(values) => Json::Array(values.iter().map(from_value).collect()),
        Value::Object(values) => Json::Object(
            values
                .iter()
                .map(|(key, value)| (JsString::from(key.as_str()), from_value(value)))
                .collect(),
        ),
    }
}

/// T5 consumes counters and ASCII-sanitized attributes, never query/candidate previews.
/// Cut surrogate units in an attribute map to the same underscore run as T5's sanitizer;
/// the independent external trace retains the original UTF-16 units.
pub(crate) fn prompt_view(value: &Json) -> Value {
    match value {
        Json::Object(fields) => Value::Object(
            fields
                .iter()
                .filter_map(|(key, value)| {
                    let key = String::from_utf16(key.as_utf16_units()).ok()?;
                    if matches!(key.as_str(), "preview" | "text") {
                        return None;
                    }
                    let value = match value {
                        Json::String(text) => match String::from_utf16(text.as_utf16_units()) {
                            Ok(text) => Value::String(text),
                            Err(_)
                                if matches!(
                                    key.as_str(),
                                    "reason" | "stage" | "source" | "evidence"
                                ) =>
                            {
                                Value::String(attribute_units(text))
                            }
                            Err(_) => return None,
                        },
                        other => prompt_view(other),
                    };
                    Some((key, value))
                })
                .collect(),
        ),
        Json::Array(values) => Value::Array(values.iter().map(prompt_view).collect()),
        Json::Bool(value) => Value::Bool(*value),
        Json::Number(number) => serde_json::from_str(number).unwrap_or(Value::Null),
        Json::String(value) => {
            String::from_utf16(value.as_utf16_units()).map_or(Value::Null, Value::String)
        }
        Json::Null => Value::Null,
    }
}

fn attribute_units(text: &JsString) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for &unit in text.as_utf16_units() {
        if let Ok(byte) = u8::try_from(unit) {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-') {
                out.push(char::from(byte));
                in_run = false;
                continue;
            }
        }
        if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out.truncate(out.len().min(160));
    out
}
fn string(value: &str) -> Json {
    Json::String(JsString::from(value))
}
fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(key, value)| (JsString::from(key), value))
            .collect(),
    )
}
fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .find_map(|(name, value)| (name == &JsString::from(key)).then_some(value)),
        _ => None,
    }
}
fn summary(decisions: &[Json], guards: &[Json], stores: &[Json], candidates: usize) -> Value {
    let mut summary = json!({"totalCandidates":candidates,"included":0,"rejected":0,"downranked":0,"superseded":0,"deduped":0,"merged":0,"guardPass":0,"guardFail":0,"storeAccepted":0,"storeRejected":0});
    let mut increment = |key: &str| {
        summary[key] = json!(summary[key].as_u64().unwrap_or(0) + 1);
    };
    for decision in decisions {
        for (action, key) in [
            ("inclusion", "included"),
            ("rejection", "rejected"),
            ("downrank", "downranked"),
            ("superseded", "superseded"),
            ("deduped", "deduped"),
            ("merged", "merged"),
        ] {
            if field(decision, "action") == Some(&string(action)) {
                increment(key);
            }
        }
    }
    for guard in guards {
        increment(if field(guard, "passed") == Some(&Json::Bool(true)) {
            "guardPass"
        } else {
            "guardFail"
        });
    }
    for store in stores {
        increment(
            if field(store, "action") == Some(&string("accepted"))
                || field(store, "action") == Some(&string("stored"))
            {
                "storeAccepted"
            } else {
                "storeRejected"
            },
        );
    }
    summary
}
