//! The assembler's canonical/selected-row projection; never fetch or copy vectors.

use super::memory_context::PromptItem;
use super::render::{CanonicalHit, RenderHit};
use super::render_value::{concat, text, truthy};
use crate::text::js::{is_js_whitespace, js_regex, js_trim, JsString};
use crate::text::legacy::text_utils::generate_summary;
use serde_json::{json, Value};

fn collapse_space(value: &str) -> String {
    let mut result = String::new();
    let mut was_space = false;
    for ch in value.chars() {
        if is_js_whitespace(ch) {
            if !was_space {
                result.push(' ');
            }
            was_space = true;
        } else {
            result.push(ch);
            was_space = false;
        }
    }
    result
}

pub(super) fn canonical(hit: &CanonicalHit, traced: bool) -> PromptItem {
    let head = JsString::from(collapse_space(&hit.heading)).utf16_slice(0, 80);
    let start = js_regex(r"^#+\s+.+\n", "")
        .ok()
        .and_then(|re| re.find_all(&hit.text).ok())
        .and_then(|matches| matches.first().map(|m| m.byte_end))
        .unwrap_or(0);
    let snippet = generate_summary(js_trim(&hit.text[start..]), 60);
    let display = concat("", &head, &format!(" — {snippet}"));
    let fields = json!({"id":format!("canonical:{}", head.to_utf8_lossy()),"category":"canonical",
        "source":"knowledge","createdAt":hit.mtime_ms.unwrap_or(0.0),"authoritative":true});
    PromptItem {
        fields,
        display,
        trace: traced.then(|| {
            json!({"sourceStage":"canonical",
        "score":hit.score,"reason":"canonical KNOWLEDGE.md hit"})
        }),
    }
}

pub(super) fn selected(hit: &RenderHit, summary_words: usize, traced: bool) -> PromptItem {
    let display = if truthy(&hit.entry["summary"]) {
        text(&hit.entry["summary"])
    } else {
        generate_summary(&text(&hit.entry["text"]), summary_words)
    };
    let fields = selected_fields(hit);
    let graph = matches!(hit.source.as_str(), "graph" | "both");
    PromptItem {
        fields,
        display: JsString::from(display),
        trace: traced.then(|| {
            json!({
                "sourceStage":if graph {"graph"} else {"vector"},
                "score":hit.score,"graphSource":hit.source,
                "reason":if graph {"associative graph"} else {"vector recall"}
            })
        }),
    }
}

pub(super) fn lens(hit: &RenderHit, summary_words: usize) -> PromptItem {
    let mut item = selected(hit, summary_words, false);
    item.fields["source"] = json!("semantic-lens");
    if let Some(fields) = item.fields.as_object_mut() {
        fields.remove("fullText");
    }
    item
}

fn selected_fields(hit: &RenderHit) -> Value {
    let entry = &hit.entry;
    let default = |key: &str, fallback: Value| {
        entry
            .get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(fallback)
    };
    let or_text = |key: &str, fallback: &str| {
        if truthy(&entry[key]) {
            text(&entry[key])
        } else {
            fallback.to_owned()
        }
    };
    json!({
        "id":entry["id"], "category":entry["category"], "source":or_text("origin","dm"),
        "fullText":entry["text"].as_str().unwrap_or(""),
        "memoryStrength":default("memoryStrength",json!(1.0)),
        "graphSource":hit.source,"depth":hit.depth,"relevanceScore":hit.score,
        "versionNumber":default("versionNumber",json!(1)),
        "previousVersion":or_text("previousVersion",""),
        "supersededBy":or_text("supersededBy",""),"updateSource":or_text("updateSource",""),
        "updateEvidence":or_text("updateEvidence",""),
        "reconsolidationConfidence":default("reconsolidationConfidence",json!(0.0)),
        "status":or_text("status","active"),
        "versionCreatedAt":default("versionCreatedAt",default("createdAt",json!(0))),
        "createdAt":default("createdAt",json!(0)),"updatedAt":entry["updatedAt"],
        "lastRetrievedAt":entry["lastRetrievedAt"],"memoryClass":or_text("memoryClass","standard"),
        "validFrom":default("validFrom",json!(0)),"validUntil":default("validUntil",json!(0)),
        "epistemicStatus":entry["epistemicStatus"]
    })
}
