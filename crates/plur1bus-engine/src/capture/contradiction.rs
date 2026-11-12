//! Frozen meaning-overlay and memory-text pair checks through an existing host LLM port.
//! Callers must authorize all sources before supplying them. Detection grants no read or
//! mutation authority, and does not persist, resolve, confirm or discard either source.
use super::dynamics;
use crate::{
    contract::{Cancel, EngineError, LlmParams, LlmPort, Message, MessageRole, StoreError},
    text::{
        js::{js_to_lower_case, js_trim, JsString},
        json::TolerantJsonValue as Json,
    },
};
use chrono::{SecondsFormat, Utc};

const SYSTEM: &str = "You decide whether two interpretations of the same memory contradict each other. Reply with exactly one word: \"yes\" if they are mutually incompatible, otherwise \"no\".";
const MAX_INPUTS: usize = 512;
const MAX_PAIRS: f64 = 1000.;
const MAX_DESCRIPTION: usize = 65_536;

/// Bounded request-local detector. Model routing and the captured clock belong to the host.
pub struct Detector<'a> {
    port: Option<&'a dyn LlmPort>,
    maximum: f64,
    now_ms: i64,
}
impl<'a> Detector<'a> {
    /// Node defaults to twenty pairs. Native scans additionally cap at one thousand.
    pub fn new(port: Option<&'a dyn LlmPort>, maximum: Option<f64>, now_ms: i64) -> Self {
        Self {
            port,
            maximum: limit(maximum, 20., true),
            now_ms,
        }
    }

    /// A single eligible pair; equal IDs are deliberately not excluded for overlays.
    pub fn detect(&self, a: &Json, b: &Json, cancel: &Cancel) -> Result<bool, EngineError> {
        cancel.check()?;
        if !meaning(a) || !meaning(b) || field(a, "targetMemoryId") != field(b, "targetMemoryId") {
            return Ok(false);
        }
        self.ask(&description(a)?, &description(b)?, cancel)
    }

    /// Ordered same-target overlay pairs; only eligible pairs consume the floored budget.
    pub fn find(
        &self,
        overlays: &Json,
        maximum: Option<f64>,
        cancel: &Cancel,
    ) -> Result<Vec<Json>, EngineError> {
        cancel.check()?;
        let rows = inputs(overlays)?;
        if self.port.is_none() || rows.len() < 2 {
            return Ok(vec![]);
        }
        let rows: Vec<_> = rows.iter().filter(|row| meaning(row)).collect();
        let maximum = limit(maximum, self.maximum, true);
        let mut checked = 0.;
        let mut out = Vec::new();
        for (index, a) in rows.iter().enumerate() {
            for b in rows.iter().skip(index + 1) {
                cancel.check()?;
                if checked >= maximum {
                    return Ok(out);
                }
                if field(a, "targetMemoryId") != field(b, "targetMemoryId") {
                    continue;
                }
                checked += 1.;
                if self.detect(a, b, cancel)? {
                    out.push(self.overlay_record(a, b)?);
                }
            }
        }
        Ok(out)
    }

    /// New overlay against existing input order, including itself when supplied in the list.
    pub fn find_for_new(
        &self,
        new: &Json,
        existing: &Json,
        maximum: Option<f64>,
        cancel: &Cancel,
    ) -> Result<Vec<Json>, EngineError> {
        cancel.check()?;
        if !meaning(new) {
            return Ok(vec![]);
        }
        let rows = inputs(existing)?;
        let maximum = limit(maximum, self.maximum, true);
        let mut checked = 0.;
        let mut out = Vec::new();
        for other in rows {
            cancel.check()?;
            if checked >= maximum {
                break;
            }
            if !meaning(other) || field(new, "targetMemoryId") != field(other, "targetMemoryId") {
                continue;
            }
            checked += 1.;
            if self.detect(new, other, cancel)? {
                out.push(self.overlay_record(new, other)?);
            }
        }
        Ok(out)
    }

    /// Factual memory pairs. Node counts valid string-ID pairs before rejecting identical
    /// IDs/empty descriptions and does not floor this method's per-call fractional limit.
    pub fn find_memory_text(
        &self,
        memories: &Json,
        maximum: Option<f64>,
        cancel: &Cancel,
    ) -> Result<Vec<Json>, EngineError> {
        cancel.check()?;
        let rows = inputs(memories)?;
        if self.port.is_none() || rows.len() < 2 {
            return Ok(vec![]);
        }
        let maximum = limit(maximum, 20., false);
        let mut checked = 0.;
        let mut out = Vec::new();
        for (index, a) in rows.iter().enumerate() {
            for b in rows.iter().skip(index + 1) {
                cancel.check()?;
                if checked >= maximum {
                    return Ok(out);
                }
                if !string_id(a) || !string_id(b) {
                    continue;
                }
                checked += 1.;
                if field(a, "id") == field(b, "id") {
                    continue;
                }
                let description_a = memory_description(a)?;
                let description_b = memory_description(b)?;
                let trimmed_a = js_trim(&description_a);
                let trimmed_b = js_trim(&description_b);
                if trimmed_a.is_empty() || trimmed_b.is_empty() {
                    continue;
                }
                if self.ask(trimmed_a, trimmed_b, cancel)? {
                    let mut row =
                        vec![("id", Json::String(uuid::Uuid::new_v4().to_string().into()))];
                    copy(&mut row, "memoryA", a, "id");
                    copy(&mut row, "memoryB", b, "id");
                    row.push(("descriptionA", Json::String(description_a.into())));
                    row.push(("descriptionB", Json::String(description_b.into())));
                    row.push(("detectedAt", self.timestamp()?));
                    row.push((
                        "recordType",
                        Json::String("memory-text-contradiction".into()),
                    ));
                    out.push(object(row));
                }
            }
        }
        Ok(out)
    }

    fn ask(&self, a: &str, b: &str, cancel: &Cancel) -> Result<bool, EngineError> {
        cancel.check()?;
        if a.encode_utf16().count() > MAX_DESCRIPTION || b.encode_utf16().count() > MAX_DESCRIPTION
        {
            return Err(StoreError::InvalidInput.into());
        }
        let Some(port) = self.port else {
            return Ok(false);
        };
        let response = port.complete(LlmParams {
            messages: vec![
                Message { role: MessageRole::System, content: SYSTEM.into() },
                Message { role: MessageRole::User, content: format!("Interpretation 1: \"{a}\"\nInterpretation 2: \"{b}\"\nDo these contradict each other?") },
            ],
            model: None, temperature: None, max_tokens: None,
        }, cancel);
        cancel.check()?;
        match response {
            Ok(response) => Ok(js_to_lower_case(js_trim(&response.text)).starts_with("yes")),
            Err(_) => {
                log::warn!("capture-contradiction: model-unavailable count=1");
                Ok(false)
            }
        }
    }

    fn timestamp(&self) -> Result<Json, EngineError> {
        let time = chrono::DateTime::<Utc>::from_timestamp_millis(self.now_ms)
            .ok_or(StoreError::InvalidInput)?;
        Ok(Json::String(
            time.to_rfc3339_opts(SecondsFormat::Millis, true).into(),
        ))
    }

    fn overlay_record(&self, a: &Json, b: &Json) -> Result<Json, EngineError> {
        let mut row = vec![("id", Json::String(uuid::Uuid::new_v4().to_string().into()))];
        copy(&mut row, "targetMemoryId", a, "targetMemoryId");
        copy(&mut row, "overlayA", a, "id");
        copy(&mut row, "overlayB", b, "id");
        copy(&mut row, "descriptionA", a, "shiftDescription");
        copy(&mut row, "descriptionB", b, "shiftDescription");
        row.push(("detectedAt", self.timestamp()?));
        Ok(object(row))
    }
}

fn limit(value: Option<f64>, fallback: f64, floor: bool) -> f64 {
    let value = value
        .filter(|v| v.is_finite() && *v >= 0.)
        .unwrap_or(fallback)
        .min(MAX_PAIRS);
    if floor {
        value.floor()
    } else {
        value
    }
}
fn inputs(value: &Json) -> Result<&[Json], EngineError> {
    match value {
        Json::Array(rows) if rows.len() > MAX_INPUTS => Err(StoreError::InvalidInput.into()),
        Json::Array(rows) => Ok(rows),
        _ => Ok(&[]),
    }
}
fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .find(|(key, _)| key == &JsString::from(name))
            .map(|(_, v)| v),
        _ => None,
    }
}
fn meaning(value: &Json) -> bool {
    field(value, "shiftType") == Some(&Json::String("meaning".into()))
        && dynamics::truthy(field(value, "shiftDescription"))
}
fn description(value: &Json) -> Result<String, EngineError> {
    match field(value, "shiftDescription") {
        Some(Json::String(value)) => prompt_text(value),
        Some(value) => Ok(dynamics::js_string(value)),
        None => Ok(String::new()),
    }
}
fn prompt_text(value: &JsString) -> Result<String, EngineError> {
    // The frozen LlmPort accepts UTF-8; do not silently change stored source content.
    char::decode_utf16(value.as_utf16_units().iter().copied())
        .collect::<Result<String, _>>()
        .map_err(|_| StoreError::InvalidInput.into())
}
fn string_id(value: &Json) -> bool {
    matches!(field(value, "id"), Some(Json::String(id)) if !id.is_empty())
}
fn memory_description(value: &Json) -> Result<String, EngineError> {
    let value = field(value, "summary")
        .filter(|v| dynamics::truthy(Some(v)))
        .or_else(|| field(value, "text").filter(|v| dynamics::truthy(Some(v))));
    match value {
        Some(Json::String(text)) => prompt_text(text),
        None => Ok(String::new()),
        _ => Err(StoreError::InvalidInput.into()),
    }
}
fn copy(out: &mut Vec<(&'static str, Json)>, target: &'static str, source: &Json, name: &str) {
    if let Some(value) = field(source, name) {
        out.push((target, value.clone()));
    }
}
fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
