//! Deterministic Node category taxonomy and precedence, including its legacy German boundaries.
//!
//! This module owns category selection only; importance floors belong to fact_quality.

use super::fact_quality::{
    contains_named_entity, pattern_count, pattern_test, split_whitespace, tokenize, trim,
};
use crate::{
    contract::EngineError,
    text::js::{self, JsString},
};
use serde::Serialize;

/// Node's category taxonomy in its original order.
pub const MEMORY_CATEGORIES: &[&str] = &[
    "preference",
    "fact",
    "decision",
    "entity",
    "reference",
    "debug",
    "config",
    "conversation",
    "knowledge",
    "curated",
    "other",
];
/// Capture origins allowed by the Node taxonomy.
pub const MEMORY_ORIGINS: &[&str] = &["dm", "group", "cron", "internal"];
/// Persistent memory scope names, distinct from Neo visibility names.
pub const MEMORY_SCOPES: &[&str] = &["agent-private", "workspace", "user"];

/// The selected category and the first matching rule's fixed explanation.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Category {
    /// Node taxonomy spelling.
    pub category: &'static str,
    /// Fixed rule explanation.
    pub reason: &'static str,
}

/// Select the first specific rule before the generic conversational fallback.
///
/// # Errors
/// Returns a content-free error if a fixed Node pattern cannot initialize or execute.
pub fn categorize_memory_with_reason(text: &JsString) -> Result<Category, EngineError> {
    let text = trim(text);
    if text.is_empty() {
        return Ok(category("other", "empty text"));
    }
    if pattern_test(
        r"^\s*(ok|okay|yes|yeah|yep|no|nope|go on|continue|proceed|weiter|mach|danke|bitte|ja|nein|hm|hmm|uh|uhh)\s*[^\p{L}\p{N}]*\s*$",
        "iu",
        &text,
    )? {
        return Ok(category("conversation", "filler/acknowledgement"));
    }
    if let Some(reason) = first_match(PREFERENCE_PATTERNS, &text)? {
        return Ok(category("preference", reason));
    }
    if let Some(reason) = first_match(DECISION_PATTERNS, &text)? {
        return Ok(category("decision", reason));
    }
    if first_match(TEMPORAL_STATUS_PATTERNS, &text)?.is_some() {
        return Ok(category("conversation", "transient status/temporal marker"));
    }
    for (patterns, name) in [
        (DEBUG_PATTERNS, "debug"),
        (CONFIG_PATTERNS, "config"),
        (REFERENCE_PATTERNS, "reference"),
        (ENTITY_PATTERNS, "entity"),
    ] {
        if let Some(reason) = first_match(patterns, &text)? {
            return Ok(category(name, reason));
        }
    }
    if pattern_test(
        r"\b(is |are |was |were |has |have |ist |sind |war |waren |\d{4})\b",
        "i",
        &text,
    )? {
        if let Some(reason) = first_match(FACT_SUBSTANCE_PATTERNS, &text)? {
            return Ok(category("fact", reason));
        }
        if contains_named_entity(&text)?
            && tokenize(&text)?
                .iter()
                .filter(|t| js::utf16_len(t) > 1)
                .count()
                >= 3
        {
            return Ok(category("fact", "named entity with copula and substance"));
        }
    }
    let technical = pattern_count(
        r"\b(node\.?js?|react|vue|angular|svelte|postgres|postgresql|mysql|mongodb|sqlite|redis|auth|oauth|jwt|deploy)\b",
        "i",
        &text,
    )?;
    let words = split_whitespace(&text).len();
    // For <=5 words, `technical / words > 0.5` is exactly `2 * technical > words`.
    if technical >= 2 && words <= 5 && technical.saturating_mul(2) > words {
        return Ok(category(
            "conversation",
            "generic keyword list without subject",
        ));
    }
    Ok(category("conversation", "generic conversational content"))
}

/// Backward-compatible category-only wrapper.
///
/// # Errors
/// See [`categorize_memory_with_reason`].
pub fn categorize_memory(text: &JsString) -> Result<&'static str, EngineError> {
    Ok(categorize_memory_with_reason(text)?.category)
}

fn category(category: &'static str, reason: &'static str) -> Category {
    Category { category, reason }
}
fn first_match(
    patterns: &'static [(&str, &'static str)],
    text: &JsString,
) -> Result<Option<&'static str>, EngineError> {
    for (pattern, reason) in patterns {
        if pattern_test(pattern, "i", text)? {
            return Ok(Some(reason));
        }
    }
    Ok(None)
}

const PREFERENCE_PATTERNS: &[(&str, &str)] = &[
    (
        r#"\b(prefer|prefers|like|likes|love|loves|hate|hates|want|wants|always|never|usually|tend to|bevorzug|bevorzuge|bevorzugt|mag|möchte|möchten)\b"#,
        "preference verb or durable marker",
    ),
    (
        r#"\b(from now on|ab jetzt|von jetzt an|immer|nie)\b"#,
        "explicit durable preference marker",
    ),
];

const DECISION_PATTERNS: &[(&str, &str)] = &[
    (
        r#"\b(decided|will use|going with|chosen|picked|entschieden|wählen wir|nehmen wir|wir wählen|wir nehmen|wir entscheiden)\b"#,
        "architecture decision verb",
    ),
    (
        r#"\b(migrated|migration|umgestellt|umstellen auf|switch to|switched to)\b"#,
        "migration/change language",
    ),
    (
        r#"\b(no longer|not anymore|instead of|rather than|statt|sondern|nicht mehr)\b"#,
        "correction/update language",
    ),
    (
        r#"\b(jetzt|nun)\b.*\b(statt|sondern|nicht mehr|anstelle)"#,
        "update/correction language",
    ),
    (
        r#"\b(deploy|deployment|infrastructure|pipeline|auth|security|vulnerability|bypass)\b.*\b(fixed|patched|use|uses|läuft|runs|on node|auf node|läuft auf)\b"#,
        "concrete security/deploy fact",
    ),
    (
        r#"\b(läuft auf|runs on|deployed on|deployed to|läuft mit)\b.*\b(node|python|go|java|ruby|rust|\d+)"#,
        "runtime/version fact",
    ),
];

const DEBUG_PATTERNS: &[(&str, &str)] = &[(
    r#"\b(error|exception|stack trace|traceback|fehler|failed|reproduce)\b"#,
    "debug/error marker",
)];

const CONFIG_PATTERNS: &[(&str, &str)] = &[(
    r#"\b(config|setting|threshold|default|umgebungsvariable|env var)\b"#,
    "config/setting marker",
)];

const REFERENCE_PATTERNS: &[(&str, &str)] = &[
    (r#"https?:\/\/"#, "URL present"),
    (r#"\b(url|link|reference)\b"#, "reference language"),
];

const ENTITY_PATTERNS: &[(&str, &str)] = &[(
    r#"\bname:|\bperson:|\bcompany:|\bproduct:|\bplace:"#,
    "explicit entity tag",
)];

const FACT_SUBSTANCE_PATTERNS: &[(&str, &str)] = &[
    (
        r#"\b(project|team|company|product|place|city|festival|event|app|service|api)\b"#,
        "substantive noun",
    ),
    (
        r#"\b[A-ZÄÖÜ][a-zäöüß\-]+(?:\s+[A-ZÄÖÜ][a-zäöüß\-]+)?\s+\b(is|are|was|were|has|have|ist|sind|war|waren)\b"#,
        "named entity with copula",
    ),
];

const TEMPORAL_STATUS_PATTERNS: &[(&str, &str)] = &[
    (
        r#"\b(today|tomorrow|yesterday|right now|currently|at the moment|heute|morgen|gestern|gerade|momentan)\b"#,
        "temporal marker",
    ),
    (
        r#"\b(finished|passed|failed|done|complete|läuft|fertig|abgeschlossen)\b"#,
        "status verb",
    ),
];
