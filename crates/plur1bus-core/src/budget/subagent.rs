//! `budget/subagent.ts`: the cap on what a subagent hands back. A result within the limit passes whole; a longer one is
//! stored in full through a port and replaced by a preview that ends in a marker naming where the full result is, so nothing
//! is ever clipped silently.
//!
//! The text of a structured result is `JSON.stringify(value, null, 2)` in TypeScript and `serde_json`'s pretty printer
//! here: the same layout, but an object's members come in key order, not insertion order, and a number with a fraction
//! prints the Rust way (`1.0`, no exponent). The vectors keep to values where both agree.
use super::{BudgetError, MAX_SAFE};
use serde_json::Value;

/// `SubagentResultPort`: access control, persistence and retrieval of complete peer output belong to the implementation.
pub trait SubagentResultPort {
    /// Stores the full value and returns the pointer the marker names.
    fn store(&self, value: &Value) -> String;
}

/// `estimateResultTokens`: a conservative UTF-8 byte upper bound for byte-level tokenizers; inject the target model's
/// tokenizer for exact counts.
pub fn estimate_result_tokens(text: &str) -> i64 {
    text.len() as i64
}

/// `SubagentCapOptions`.
pub struct SubagentCapOptions<'a> {
    /// Token limit; 2000 when `None`.
    pub limit: Option<i64>,
    /// Where the full result goes.
    pub port: &'a dyn SubagentResultPort,
    /// The tokenizer; the byte estimate when `None`.
    pub count_tokens: Option<&'a dyn Fn(&str) -> i64>,
}

/// `CappedSubagentResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum CappedSubagentResult {
    /// Within the limit.
    Complete(Value),
    /// A preview with the marker.
    Capped {
        /// The preview and the marker.
        text: String,
        /// Where the full result is.
        pointer: String,
        /// The tokens of the full text.
        original_tokens: i64,
    },
}

fn valid_pointer(p: &str) -> bool {
    let b = p.as_bytes();
    !b.is_empty()
        && b.len() <= 256
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/@+=-".contains(c))
}

/// `capSubagentResult`.
pub fn cap_subagent_result(
    value: &Value,
    o: &SubagentCapOptions<'_>,
) -> Result<CappedSubagentResult, BudgetError> {
    let limit = o.limit.unwrap_or(2000);
    if !(1..=MAX_SAFE).contains(&limit) {
        return Err(BudgetError::Range("invalid subagent token limit".into()));
    }
    let count = |s: &str| -> Result<i64, BudgetError> {
        let n = o
            .count_tokens
            .map_or_else(|| estimate_result_tokens(s), |f| f(s));
        if (0..=MAX_SAFE).contains(&n) {
            Ok(n)
        } else {
            Err(BudgetError::Range("invalid token count".into()))
        }
    };
    let text = match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other)
            .map_err(|_| BudgetError::Range("result must be JSON serializable".into()))?,
    };
    let original_tokens = count(&text)?;
    if original_tokens <= limit {
        return Ok(CappedSubagentResult::Complete(value.clone()));
    }
    // The minimum marker space is checked before anything is written through the port.
    if count("[truncated; full result: ]")? > limit {
        return Err(BudgetError::Range(
            "limit cannot fit a truncation marker".into(),
        ));
    }
    let pointer = o.port.store(value);
    if !valid_pointer(&pointer) {
        return Err(BudgetError::Range("invalid full-result pointer".into()));
    }
    let marker = format!("\n[truncated; full result: {pointer}]");
    if count(&marker)? > limit {
        return Err(BudgetError::Range(
            "limit cannot fit pointer and marker".into(),
        ));
    }
    // Prefer paragraph, line or word boundaries; the fallback keeps whole Unicode code points.
    let mut prefix = String::new();
    for ch in text.chars() {
        let mut probe = String::with_capacity(prefix.len() + ch.len_utf8() + marker.len());
        probe.push_str(&prefix);
        probe.push(ch);
        probe.push_str(&marker);
        if count(&probe)? > limit {
            break;
        }
        prefix.push(ch);
    }
    let boundary = [prefix.rfind("\n\n"), prefix.rfind('\n'), prefix.rfind(' ')]
        .into_iter()
        .flatten()
        .max();
    if let Some(b) = boundary.filter(|b| *b > 0) {
        prefix.truncate(b);
    }
    while !prefix.is_empty() && count(&format!("{prefix}{marker}"))? > limit {
        prefix.pop();
    }
    Ok(CappedSubagentResult::Capped {
        text: format!("{prefix}{marker}"),
        pointer,
        original_tokens,
    })
}
