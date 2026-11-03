//! Reuse T0 word allocation; retain UTF-16 when a derived canonical head is unpaired.

use super::memory_context::PromptItem;
use super::render_value::{bounded, concat, text, trim, whitespace};
use crate::text::js::JsString;
use crate::text::legacy::text_utils::{
    compress_memory_slots_for_prompt, PromptMemoryEntry, PromptMemorySlot,
};
use serde_json::Value;

pub(super) fn full_text(items: &mut [PromptItem], recall: &Value) {
    let top = bounded(&recall["fullTextTopRecords"], 3, 0, 15);
    let maximum = bounded(&recall["fullTextMaxChars"], 2000, 400, 8000);
    let mut ids = std::collections::HashSet::<String>::new();
    for item in items.iter() {
        if ids.len() >= top {
            break;
        }
        if item.fields["fullText"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
            && item.fields["memoryClass"] != "dream"
            && item.fields["category"] != "canonical"
        {
            ids.insert(text(&item.fields["id"]));
        }
    }
    for item in items {
        if ids.contains(&text(&item.fields["id"])) {
            item.display = JsString::from(text(&item.fields["fullText"]));
            item.fields["displayMaxChars"] = serde_json::json!(maximum);
            item.fields["keepFullText"] = Value::Bool(true);
        }
    }
}

fn slot(item: &PromptItem, display: String) -> PromptMemorySlot {
    PromptMemorySlot {
        entry: PromptMemoryEntry {
            id: text(&item.fields["id"]),
            text: display.clone(),
            summary: display,
            category: text(&item.fields["category"]),
            memory_class: text(&item.fields["memoryClass"]),
        },
    }
}

pub(super) fn compress(items: Vec<PromptItem>, config: &Value) -> Vec<PromptItem> {
    if config["enabled"] == false {
        return items;
    }
    let budget = bounded(&config["tokenBudget"], 240, 1, 1000);
    let compressible = items
        .iter()
        .filter(|m| m.fields["keepFullText"] != true)
        .collect::<Vec<_>>();
    let valid = compressible
        .iter()
        .map(|m| String::from_utf16(m.display.as_utf16_units()))
        .collect::<Result<Vec<_>, _>>();
    let slots = match valid {
        Ok(texts) => compress_memory_slots_for_prompt(
            &compressible
                .iter()
                .zip(texts)
                .map(|(item, display)| slot(item, display))
                .collect::<Vec<_>>(),
            budget,
        )
        .into_iter()
        .map(JsString::from)
        .collect::<Vec<_>>(),
        Err(_) => lossless_slots(&compressible, budget),
    };
    let mut slots = slots.into_iter();
    items
        .into_iter()
        .filter_map(|mut item| {
            if item.fields["keepFullText"] == true {
                return Some(item);
            }
            let display = slots.next()?;
            if display.is_empty() {
                return None;
            }
            item.display = display;
            item.trace = None; // Node spreads every compressed item; symbols do not survive.
            Some(item)
        })
        .collect()
}

fn lossless_slots(items: &[&PromptItem], budget: usize) -> Vec<JsString> {
    if items.is_empty() {
        return Vec::new();
    }
    let base = budget as f64 / items.len() as f64;
    let groups = items
        .iter()
        .map(|m| {
            if m.fields["memoryClass"] == "core" || m.fields["category"] == "canonical" {
                2
            } else if matches!(m.fields["category"].as_str(), Some("project" | "decision")) {
                1
            } else {
                0
            }
        })
        .collect::<Vec<_>>();
    let mut counts = groups
        .iter()
        .map(|group| (base * [0.6, 1.0, 1.5][*group]).floor() as usize)
        .collect::<Vec<_>>();
    let mut excess = counts.iter().sum::<usize>().saturating_sub(budget);
    for group in 0..3 {
        while excess > 0
            && groups
                .iter()
                .enumerate()
                .any(|(i, g)| *g == group && counts[i] > 0)
        {
            for (i, value) in groups.iter().enumerate() {
                if excess > 0 && *value == group && counts[i] > 0 {
                    counts[i] -= 1;
                    excess -= 1;
                }
            }
        }
    }
    items
        .iter()
        .zip(counts)
        .map(|(m, count)| {
            if count == 0 {
                JsString::default()
            } else {
                summary(&m.display, count)
            }
        })
        .collect()
}

fn words(value: &JsString) -> Vec<(usize, usize)> {
    let units = value.as_utf16_units();
    let mut out = Vec::new();
    let mut start = None;
    for (i, &unit) in units.iter().enumerate() {
        if whitespace(unit) {
            if let Some(at) = start.take() {
                out.push((at, i));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(start) = start {
        out.push((start, units.len()));
    }
    out
}

fn summary(value: &JsString, maximum: usize) -> JsString {
    let value = trim(value);
    let tokens = words(&value);
    if tokens.len() <= maximum {
        return value;
    }
    let cut = tokens
        .get(maximum.saturating_sub(1))
        .map_or(value.utf16_len(), |(_, end)| *end);
    let prefix = value.utf16_slice(0, cut);
    let lower = (maximum as f64 * 0.9).ceil() as usize;
    for (at, &unit) in prefix.as_utf16_units().iter().enumerate().rev() {
        if matches!(unit, 46 | 33 | 63) {
            let candidate = prefix.utf16_slice(0, at + 1);
            let length = words(&candidate).len();
            if length >= lower && length <= maximum {
                return candidate;
            }
        }
    }
    concat("", &trim(&prefix), "…")
}
