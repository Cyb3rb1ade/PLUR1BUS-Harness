//! One memory record, with evidence and overlay kept as lossless UTF-16.

use super::memory_context::{FormatOptions, PromptItem};
use super::memory_sanitize::{attribute, escape, evidence};
use super::render::RenderError;
use super::render_date::{iso_timestamp, parse_timestamp};
use super::render_value::{concat, fixed, join, number, text, trim, truthy};
use crate::text::js::JsString;
use serde_json::{json, Value};

#[derive(Clone, Copy, Default)]
pub(super) struct RecordState {
    pub operational_warning: bool,
    pub truncated: bool,
}

fn display(item: &PromptItem) -> Result<(JsString, usize), RenderError> {
    let maximum = item.fields["displayMaxChars"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(400, |n| n.floor() as usize);
    let raw = if item.fields["memoryClass"] == "dream" {
        let date = if truthy(&item.fields["createdAt"]) {
            let date = iso_timestamp(number(&item.fields["createdAt"]))?;
            format!(" vom {}", &date[..10])
        } else {
            String::new()
        };
        concat(
            &format!("🌙 [Traum{date}] "),
            &item.display,
            " (geträumt, nicht geschehen)",
        )
    } else {
        item.display.clone()
    };
    Ok((evidence(&raw, maximum), maximum))
}

fn graph_attributes(fields: &Value, forced: bool, faded: &mut bool) -> (String, String) {
    if forced || fields["graphSource"] != "graph" {
        return (String::new(), String::new());
    }
    let raw = fields
        .get("depth")
        .filter(|v| !v.is_null())
        .map_or_else(|| "1".into(), text);
    let raw = crate::text::js::js_trim_start(&raw);
    let end = raw
        .char_indices()
        .take_while(|(at, ch)| ch.is_ascii_digit() || (*at == 0 && matches!(ch, '-' | '+')))
        .last()
        .map_or(0, |(at, ch)| at + ch.len_utf8());
    let depth = raw[..end]
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .unwrap_or(1.0)
        .max(0.0);
    if depth >= 1.0 {
        *faded = true;
    }
    let mut depth_attrs = format!(" depth=\"{depth:.0}\"");
    let score = ["associatedScore", "relevanceScore", "associationStrength"]
        .iter()
        .find_map(|key| fields.get(key).filter(|v| !v.is_null()));
    if let Some(score) = score.and_then(Value::as_f64).filter(|n| n.is_finite()) {
        depth_attrs += &format!(
            " association-strength=\"{}\"",
            fixed(score.clamp(0.0, 1.0), 2)
        );
    }
    (" graph-source=\"associative\"".into(), depth_attrs)
}

fn temporal_attributes(
    fields: &Value,
    now: f64,
    state: &mut RecordState,
) -> Result<String, RenderError> {
    let provenance = super::provenance::build(fields, now);
    state.operational_warning |= provenance.requires_live_verification;
    let mut attrs = String::new();
    if let Some(created) = provenance.created_at {
        attrs += &format!(
            " created-at=\"{}\"",
            attribute(&json!(iso_timestamp(created)?), "unknown")
        );
    }
    attrs += &format!(
        " age=\"{}\" freshness=\"{}\"",
        escape(&provenance.age_label),
        provenance.freshness
    );
    if provenance.operational {
        attrs += &format!(
            " operational=\"true\" operational-risk=\"{}\"",
            provenance.risk
        );
    }
    if provenance.authoritative {
        attrs += " authoritative=\"true\"";
    }
    if provenance.requires_live_verification {
        attrs += " requires-live-verification=\"true\"";
    }
    for (key, name) in [("validFrom", "valid-from"), ("validUntil", "valid-until")] {
        let value = number(&fields[key]);
        if value.is_finite() && value > 0.0 {
            attrs += &format!(
                " {name}=\"{}\"",
                attribute(&json!(iso_timestamp(value)?), "unknown")
            );
        }
    }
    Ok(attrs)
}

fn status_attributes(fields: &Value) -> String {
    let mut attrs = String::new();
    if matches!(
        fields["status"].as_str(),
        Some("superseded" | "superseded-in-context")
    ) {
        attrs += " status=\"superseded\"";
        if truthy(&fields["supersededBy"]) {
            attrs += &format!(
                " superseded-by=\"{}\"",
                attribute(&fields["supersededBy"], "id")
            );
        }
    }
    if truthy(&fields["updateSource"]) {
        attrs += &format!(
            " update-source=\"{}\"",
            attribute(&fields["updateSource"], "update-source")
        );
    }
    let version = number(&fields["versionNumber"]);
    let version = if version.is_finite() {
        version.floor().max(1.0)
    } else {
        1.0
    };
    if version > 1.0 {
        attrs += &format!(" version=\"{version:.0}\"");
    }
    let epistemic =
        super::score::normalize_epistemic_status(fields["epistemicStatus"].as_str().unwrap_or(""));
    attrs += &format!(" epistemic=\"{epistemic}\"");
    attrs
}

fn overlay(item: &PromptItem, options: &FormatOptions) -> JsString {
    let Some(overlay) = options.overlays.iter().find(|ov| {
        truthy(&ov["targetMemoryId"])
            && ov["targetMemoryId"] == item.fields["id"]
            && ov["status"] != "provisional"
    }) else {
        return JsString::default();
    };
    let created = if truthy(&overlay["createdAt"]) {
        parse_timestamp(&overlay["createdAt"]).unwrap_or(f64::NAN)
    } else {
        options.now_ms
    };
    let weeks = ((options.now_ms - created) / 604_800_000.0 + 0.5).floor();
    let weeks = if weeks.is_nan() {
        "NaN".into()
    } else {
        format!("{:.0}", weeks.max(0.0))
    };
    let confidence = overlay["confidence"]
        .as_f64()
        .filter(|n| (0.0..=1.0).contains(n))
        .unwrap_or_else(|| {
            overlay["confidenceDelta"]
                .as_f64()
                .filter(|n| n.is_finite())
                .map_or(0.6, |delta| (0.6 + delta).clamp(0.0, 1.0))
        });
    let prefix = overlay_prefix(overlay, confidence, &weeks);
    concat(
        &prefix,
        &evidence(&JsString::from(text(&overlay["shiftDescription"])), 200),
        "</interpretation-overlay>",
    )
}

pub(super) fn render(
    item: &PromptItem,
    options: &FormatOptions,
    forced: bool,
    state: &mut RecordState,
) -> Result<JsString, RenderError> {
    let fields = &item.fields;
    if !fields.is_object() {
        return Err(RenderError::InvalidMemory);
    }
    let (mut display, limit) = display(item)?;
    let stored = fields["fullText"]
        .as_str()
        .map(|s| trim(&JsString::from(s)))
        .unwrap_or_default();
    let truncated = !stored.is_empty()
        && stored.utf16_len() > trim(&item.display).utf16_len().min(limit).saturating_add(3);
    state.truncated |= truncated;
    let attrs = record_attributes(item, options, forced, state, truncated)?;
    if matches!(
        fields["status"].as_str(),
        Some("superseded" | "superseded-in-context")
    ) {
        display = concat("[superseded] ", &display, "");
    }
    let overlay = overlay(item, options);
    let body = concat(
        &format!("  <memory-record{attrs}><quoted-evidence>"),
        &display,
        "</quoted-evidence>",
    );
    let suffix = if overlay.is_empty() {
        "</memory-record>"
    } else {
        "\n  </memory-record>"
    };
    Ok(join(&[body, overlay, JsString::from(suffix)], ""))
}

fn record_attributes(
    item: &PromptItem,
    options: &FormatOptions,
    forced: bool,
    state: &mut RecordState,
    truncated: bool,
) -> Result<String, RenderError> {
    let fields = &item.fields;
    let strength = fields
        .get("memoryStrength")
        .filter(|v| !v.is_null())
        .map_or(1.0, number);
    let mut faded = strength < options.faded_threshold;
    let (graph, depth) = graph_attributes(fields, forced, &mut faded);
    let source = source(fields, forced);
    let mut attrs = format!(
        " category=\"{}\" source=\"{source}\"{graph} id=\"{}\"",
        attribute(&fields["category"], "category"),
        attribute(&fields["id"], "id")
    );
    attrs += &markers(fields, strength, options.faded_threshold, faded, truncated);
    attrs += &depth;
    attrs += &status_attributes(fields);
    attrs += &provenance_attributes(item, options, forced, state)?;
    if options.include_trace {
        if let Some(trace) = &options.trace {
            attrs += &super::memory_trace::attributes(item, trace);
        }
    }
    Ok(attrs)
}

fn provenance_attributes(
    item: &PromptItem,
    options: &FormatOptions,
    forced: bool,
    state: &mut RecordState,
) -> Result<String, RenderError> {
    let fields = &item.fields;
    let mut temporal_fields = fields.clone();
    temporal_fields["display"] = json!(item.display.to_utf8_lossy());
    let mut local_state = RecordState::default();
    let attrs = temporal_attributes(&temporal_fields, options.now_ms, &mut local_state)?;
    if !forced {
        state.operational_warning |= local_state.operational_warning;
    }
    Ok(attrs)
}

fn source(fields: &Value, forced: bool) -> &str {
    if forced {
        "semantic-lens"
    } else {
        fields["source"]
            .as_str()
            .filter(|source| matches!(*source, "group" | "cron" | "internal" | "dream"))
            .unwrap_or("memory")
    }
}

fn markers(fields: &Value, strength: f64, threshold: f64, faded: bool, truncated: bool) -> String {
    let mut attrs = if strength < threshold / 2.0 {
        " very-faded=\"true\""
    } else if faded {
        " faded=\"true\""
    } else {
        ""
    }
    .to_owned();
    if fields["recallUncertain"] == true {
        attrs += " uncertain=\"true\"";
    }
    if fields["memoryClass"] == "dream" {
        attrs += " memory-class=\"dream\" fictional=\"true\"";
    }
    if truncated {
        attrs += " truncated=\"true\"";
    }
    attrs
}

fn overlay_prefix(overlay: &Value, confidence: f64, weeks: &str) -> String {
    let triggers = overlay["provenance"]["triggerMemoryIds"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|id| attribute(&json!(text(id)), "id"))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        concat!(
            "\n    <interpretation-overlay shift-type=\"{}\" confidence=\"{}\" ",
            "weeks-ago=\"{weeks}\" trigger-memory-ids=\"{triggers}\">{}",
        ),
        attribute(
            overlay
                .get("shiftType")
                .filter(|v| !v.is_null())
                .unwrap_or(&json!("meaning")),
            "meaning"
        ),
        fixed(confidence, 2),
        if truthy(&overlay["contradiction"]) {
            concat!(
                " [This memory frame conflicts with another interpretation; ",
                "treat both as provisional.] ",
            )
        } else {
            ""
        },
        weeks = weeks,
        triggers = triggers
    )
}
