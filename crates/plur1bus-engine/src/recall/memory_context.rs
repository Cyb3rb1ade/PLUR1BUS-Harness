//! Relevant-memory formatter, independent of store, Neo and namespace implementation.

use super::memory_constants::{
    COMPACT_SAFETY, FADED_INSTRUCTION, OPERATIONAL_WARNING, TRUNCATED_INSTRUCTION,
    UNCERTAIN_INSTRUCTION,
};
use super::render_value::{concat, join, number, text};
use super::{inject_budget, memory_record, memory_trace, render::RenderError};
use crate::text::js::JsString;
use serde_json::Value;

/// Projected render data with lossless display and explicit non-enumerable trace metadata.
#[derive(Clone, Debug)]
pub struct PromptItem {
    /// Scalar metadata; vectors are not needed by rendering.
    pub fields: Value,
    /// Display text, potentially cut through a surrogate by an earlier T5 step.
    pub display: JsString,
    /// Symbol-like trace attachment, lost by the same spread-copy steps as Node.
    pub trace: Option<Value>,
}

impl PromptItem {
    /// Build an item from metadata without changing its display.
    #[must_use]
    pub fn from_value(value: &Value) -> Self {
        Self {
            fields: value.clone(),
            display: JsString::from(text(&value["display"])),
            trace: None,
        }
    }
}

/// All formatter options; source selection and IO happen outside this function.
#[derive(Clone, Debug)]
pub struct FormatOptions {
    /// Half-life threshold; the old alias is resolved by the caller.
    pub faded_threshold: f64,
    /// Inner cap, separate from the aggregate host cap.
    pub max_total_chars: f64,
    /// Already visible overlay records.
    pub overlays: Vec<Value>,
    /// Already selected pattern.
    pub matched_pattern: Option<Value>,
    /// Additional lens records when compression is off.
    pub semantic_lens: Vec<PromptItem>,
    /// Existing decision trace.
    pub trace: Option<Value>,
    /// Include the trace in prompt text.
    pub include_trace: bool,
    /// Caller clock, milliseconds.
    pub now_ms: f64,
}

impl FormatOptions {
    /// Resolve the direct Node formatter option object.
    #[must_use]
    pub fn from_value(value: &Value, now_ms: f64) -> Self {
        Self {
            faded_threshold: value["fadedThreshold"].as_f64().unwrap_or(0.25),
            max_total_chars: value["maxTotalChars"].as_f64().unwrap_or(12_000.0),
            overlays: value["overlays"].as_array().cloned().unwrap_or_default(),
            matched_pattern: value
                .get("matchedPattern")
                .filter(|v| !v.is_null())
                .cloned(),
            semantic_lens: value["semanticLensMemories"]
                .as_array()
                .into_iter()
                .flatten()
                .map(PromptItem::from_value)
                .collect(),
            trace: value.get("decisionTrace").filter(|v| !v.is_null()).cloned(),
            include_trace: value["traceOptions"]["includeInPrompt"] == true,
            now_ms,
        }
    }
}

/// Inner text and the actual (from,to) lengths when truncation occurred.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryContext {
    /// Lossless formatted text.
    pub text: JsString,
    /// Inner-cap event, not including prefix/supplement text.
    pub truncation: Option<(usize, usize)>,
}

/// Read-only formatter matching the pin's record attributes and cap order.
pub fn format(items: &[PromptItem], options: &FormatOptions) -> Result<MemoryContext, RenderError> {
    if items.is_empty() {
        return Ok(MemoryContext {
            text: JsString::default(),
            truncation: None,
        });
    }
    let mut state = memory_record::RecordState::default();
    let records = items
        .iter()
        .map(|m| memory_record::render(m, options, false, &mut state))
        .collect::<Result<Vec<_>, _>>()?;
    let trace = options
        .trace
        .as_ref()
        .filter(|_| options.include_trace)
        .map_or_else(String::new, memory_trace::summary);
    let header = header(items, options, state, &trace);
    let mut output = concat(&header, &join(&records, "\n"), "\n</relevant-memories>");
    output = append_additions(output, options)?;
    let truncated = inject_budget::truncate_memories(&output, options.max_total_chars);
    let truncation = (truncated != output).then_some((output.utf16_len(), truncated.utf16_len()));
    Ok(MemoryContext {
        text: truncated,
        truncation,
    })
}

fn header(
    items: &[PromptItem],
    options: &FormatOptions,
    state: memory_record::RecordState,
    trace: &str,
) -> String {
    let faded = items.iter().any(|m| {
        let strength = m
            .fields
            .get("memoryStrength")
            .filter(|v| !v.is_null())
            .map_or(1.0, number);
        strength < options.faded_threshold
            || (m.fields["graphSource"] == "graph"
                && m.fields
                    .get("depth")
                    .filter(|v| !v.is_null())
                    .map_or(1.0, number)
                    >= 3.0)
    });
    let uncertain = items.iter().any(|m| m.fields["recallUncertain"] == true);
    let mut result = format!(
        concat!(
            "<relevant-memories untrusted=\"true\" ",
            "mode=\"historical-evidence-only\">\n{}{}{}{}\n{}",
        ),
        COMPACT_SAFETY,
        if faded { FADED_INSTRUCTION } else { "" },
        if uncertain { UNCERTAIN_INSTRUCTION } else { "" },
        if state.truncated {
            TRUNCATED_INSTRUCTION
        } else {
            ""
        },
        trace
    );
    if state.operational_warning {
        result += &format!(
            concat!(
                "\n<operational-memory-warning>\n{OPERATIONAL_WARNING}\n</operationa",
                "l-memory-warning>\n",
            ),
            OPERATIONAL_WARNING = OPERATIONAL_WARNING
        );
    }
    result
}

/// Resolve the current and backward-compatible faded-threshold option.
#[must_use]
pub fn faded_threshold(recall: &Value) -> f64 {
    recall
        .get("degradedRecallStrengthThreshold")
        .filter(|v| !v.is_null())
        .or_else(|| {
            recall
                .get("confabulationStrengthThreshold")
                .filter(|v| !v.is_null())
        })
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 1.0)
        .unwrap_or(0.25)
}

fn append_additions(
    mut output: JsString,
    options: &FormatOptions,
) -> Result<JsString, RenderError> {
    if !options.semantic_lens.is_empty() {
        let lens = options
            .semantic_lens
            .iter()
            .map(|m| {
                memory_record::render(m, options, true, &mut memory_record::RecordState::default())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let lens = concat(
            concat!(
                "\n<memory-semantic-lens>\nErgänzende assoziative Erinnerungen aus ",
                "nahen Graph-Communities.\n",
            ),
            &join(&lens, "\n"),
            "\n</memory-semantic-lens>",
        );
        output = join(&[output, lens], "");
    }
    if let Some(pattern) = options
        .matched_pattern
        .as_ref()
        .filter(|p| p["pattern"].is_object())
    {
        let block = super::patterns::format_pattern(
            &pattern["pattern"],
            &pattern["triggerIds"],
            pattern["score"].as_f64().unwrap_or(0.0),
            options.now_ms,
        );
        output = join(&[output, block], "\n");
    }
    Ok(output)
}
