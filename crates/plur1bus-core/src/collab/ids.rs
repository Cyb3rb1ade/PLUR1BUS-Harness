//! `collab/ids.ts`: trace and span ids in the W3C shapes, the `traceparent` text, and the keys of the repeat and pair counters.
//!
//! TypeScript draws trace and span ids from `randomBytes` inside the module; here they come from [`CollabIds`], a port, so a
//! test can script them (R-K-2). The prefixed ids of rows (`prj_`, `tsk_`, `wt_`, `art_`, `card_`, `col_`) come from the same
//! port, as `StoreOptions.newId` does in TypeScript.
use crate::js::{is_js_space, to_lower_case};
use sha2::{Digest, Sha256};

/// Where ids come from.
pub trait CollabIds: Send + Sync {
    /// `newId(prefix)`: `<prefix>_<uuid>` in production.
    fn new_id(&self, prefix: &str) -> String;
    /// `newTraceId()`: 32 lower-case hex digits, not all zero.
    fn trace_id(&self) -> String;
    /// `newSpanId()`: 16 lower-case hex digits, not all zero.
    fn span_id(&self) -> String;
}

/// The production source: version 4 UUIDs and OS randomness.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemIds;

fn random_hex(bytes: usize) -> String {
    loop {
        let mut buf = vec![0u8; bytes];
        if getrandom::fill(&mut buf).is_err() {
            // No randomness: fail closed with an id nobody can guess is not possible, so fall back to a UUID pair.
            let id = uuid::Uuid::new_v4().simple().to_string();
            return id.chars().take(bytes * 2).collect();
        }
        let text: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        if text.chars().any(|c| c != '0') {
            return text;
        }
    }
}

impl CollabIds for SystemIds {
    fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4())
    }
    fn trace_id(&self) -> String {
        random_hex(16)
    }
    fn span_id(&self) -> String {
        random_hex(8)
    }
}

/// `traceparent(traceId, spanId, sampled)`.
pub fn traceparent(trace_id: &str, span_id: &str, sampled: bool) -> String {
    format!(
        "00-{trace_id}-{span_id}-{}",
        if sampled { "01" } else { "00" }
    )
}

/// `repeatKey(from, to, question)`: SHA-256 over the pair and the question with white space folded, `trim`, `toLowerCase` and
/// `/\s+/g` as JavaScript reads them (`\s` includes U+FEFF and the line terminators, and `trim` strips the same set).
pub fn repeat_key(from_agent: &str, to_agent: &str, question: &str) -> String {
    let trimmed = question.trim_matches(is_js_space);
    let lower = to_lower_case(trimmed);
    let mut norm = String::with_capacity(lower.len());
    let mut in_space = false;
    for c in lower.chars() {
        if is_js_space(c) {
            if !in_space {
                norm.push(' ');
            }
            in_space = true;
        } else {
            norm.push(c);
            in_space = false;
        }
    }
    let mut h = Sha256::new();
    h.update(format!("{from_agent}\0{to_agent}\0{norm}").as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A service-level repeat key belongs to the project whose admission rules are applied.
pub(super) fn project_repeat_key(project: &str, from: &str, to: &str, question: &str) -> String {
    format!("{project}:{}", repeat_key(from, to, question))
}

/// `pairKey(from, to)`.
pub fn pair_key(from_agent: &str, to_agent: &str) -> String {
    format!("{from_agent}\0{to_agent}")
}
