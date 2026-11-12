//! Lossless Node-compatible Neo evidence formatting. The existing ContextBlock constructor
//! applies RE-D17/F3's well-formed Unicode boundary before presentation.
use super::{
    acl,
    merged::{sanitize_path_part, Record},
    merged_order::{field, record_id, string, truthy},
    routing::Lane,
};
use crate::{
    context::RequestContext,
    contract::StoreError,
    recall::{
        memory_constants::COMPACT_SAFETY, memory_sanitize::evidence,
        score::normalize_epistemic_status,
    },
    text::{js::JsString, json::TolerantJsonValue as Json, number::fixed},
};
use std::collections::HashSet;
/// The pin's two independent UTF-16 caps; outer wrapper and preamble are outside the item budget.
#[derive(Clone, Debug)]
pub struct Options {
    /// Text cap before escaping; zero retains Node's default 500.
    pub max_item_chars: usize,
    /// Sum of rendered record line lengths; zero retains Node's default 5,000.
    pub max_total_chars: usize,
    /// Optional host-owned injection key; this formatter never persists it.
    pub idempotency_key: Option<JsString>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_item_chars: 500,
            max_total_chars: 5000,
            idempotency_key: None,
        }
    }
}
fn identifier(value: Option<&Json>, fallback: &str) -> String {
    let text = value
        .filter(|v| truthy(v))
        .map(string)
        .map(|v| v.to_utf8_lossy())
        .unwrap_or_else(|| fallback.into());
    sanitize_path_part(&text)
}
fn append(out: &mut Vec<u16>, text: &str) {
    out.extend(text.encode_utf16());
}
fn wrap(lines: &[JsString], options: &Options) -> JsString {
    let mut out = Vec::new();
    append(
        &mut out,
        "<plur1bus-recall untrusted=\"true\" mode=\"historical-evidence-only\"",
    );
    if let Some(key) = options
        .idempotency_key
        .as_ref()
        .filter(|key| !key.is_empty())
    {
        append(
            &mut out,
            &format!(
                " idempotency-key=\"{}\"",
                sanitize_path_part(&key.to_utf8_lossy())
            ),
        );
    }
    append(&mut out, ">\n");
    append(&mut out, COMPACT_SAFETY);
    append(&mut out, "\n");
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            out.push(10);
        }
        out.extend_from_slice(line.as_utf16_units());
    }
    append(&mut out, "\n</plur1bus-recall>");
    JsString::from_utf16_units(out)
}
/// Format authorized lane hits without writing hook counters, injection marks or store state.
/// Rechecks caller visibility so a caller cannot bypass ACL with a hand-built lane reference.
/// Unknown record indices and non-finite scores are explicit invalid inputs.
pub fn format(
    records: &[Record],
    lanes: &[Lane],
    ctx: &RequestContext,
    options: &Options,
) -> Result<JsString, StoreError> {
    let item_cap = if options.max_item_chars == 0 {
        500
    } else {
        options.max_item_chars
    };
    let total_cap = if options.max_total_chars == 0 {
        5000
    } else {
        options.max_total_chars
    };
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    let mut used = 0usize;
    for lane in lanes {
        for hit in &lane.hits {
            let item = &records
                .get(hit.index)
                .ok_or(StoreError::InvalidInput)?
                .metadata;
            if !acl::visible(item, Some(ctx)) {
                continue;
            }
            if !hit.score.is_finite() {
                return Err(StoreError::InvalidInput);
            }
            let id = record_id(item);
            if id.as_ref().is_some_and(|id| seen.contains(id)) {
                continue;
            }
            let raw = ["statement", "content"]
                .iter()
                .find_map(|name| field(item, name).filter(|v| truthy(v)))
                .map(string)
                .unwrap_or_default();
            let text = evidence(&raw, item_cap);
            let origin = field(item, "origin").unwrap_or(&Json::Null);
            let epistemic = match field(item, "epistemicStatus") {
                Some(Json::String(s)) => normalize_epistemic_status(&s.to_utf8_lossy()),
                _ => "untrusted",
            };
            let mut line = Vec::new();
            append(&mut line,&format!("  <memory-record lane=\"{}\" category=\"{}\" trust=\"{}\" status=\"{}\" epistemic=\"{}\" id=\"{}\" score=\"{}\"><quoted-evidence>",
            sanitize_path_part(lane.name),identifier(field(item,"category"),"category"),identifier(field(origin,"trustLevel"),"untrusted"),identifier(field(item,"status"),"active"),epistemic,identifier(field(item,"id"),"id"),fixed(hit.score,2)));
            line.extend_from_slice(text.as_utf16_units());
            append(&mut line, "</quoted-evidence></memory-record>");
            if used.checked_add(line.len()).is_none_or(|n| n > total_cap) {
                lines.push(JsString::from("  - [truncated] Additional PLUR1BUS recall items were omitted because the recall block reached its configured size limit."));
                return Ok(wrap(&lines, options));
            }
            used += line.len();
            lines.push(JsString::from_utf16_units(line));
            if let Some(id) = id {
                seen.insert(id);
            }
        }
    }
    Ok(if lines.is_empty() {
        JsString::default()
    } else {
        wrap(&lines, options)
    })
}
