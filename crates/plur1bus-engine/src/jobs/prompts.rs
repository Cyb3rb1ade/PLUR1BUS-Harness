//! Versioned job prompts in the Phase 1 order (RE-D24).
//!
//! A template can put instructions after a variable. Only the bytes before the first
//! variable form the cacheable prefix. Rendering preserves both the prefix and suffix.
use sha2::{Digest, Sha256};

use crate::text::js::JsString;

mod dream;
pub use dream::{dream_narrative, DreamMode, DreamMood};

const INSIGHTS: &str = include_str!("prompts/templates/conversation-insights.v1.txt");
const REM_PATTERN: &str = include_str!("prompts/templates/rem-pattern-analysis.v1.txt");
const SKILL_EXTRACTION: &str = include_str!("prompts/templates/skill-extraction.v3.txt");
const SKILL_BENEFIT: &str = include_str!("prompts/templates/skill-benefit.v1.txt");

/// The exact UTF-16 prompt and its only cache boundary.
#[derive(Debug, PartialEq, Eq)]
pub struct Rendered {
    /// The original Node-order text, including lone surrogates from input cuts.
    pub text: JsString,
    /// UTF-16 offset before the first volatile field.
    pub breakpoint: usize,
    /// SHA-256 of the stable UTF-8 prefix.
    pub stable_hash: String,
}

fn render(template: &'static str, values: &[&JsString]) -> Rendered {
    let mut rest = template;
    let mut units = Vec::new();
    let mut stable_prefix = template;
    for (index, value) in values.iter().enumerate() {
        let Some((literal, field)) = rest.split_once("{{") else {
            unreachable!("template is missing a slot");
        };
        let Some((_, tail)) = field.split_once("}}") else {
            unreachable!("template slot is unclosed");
        };
        if index == 0 {
            stable_prefix = literal;
        }
        units.extend(literal.encode_utf16());
        units.extend_from_slice(value.as_utf16_units());
        rest = tail;
    }
    debug_assert!(!rest.contains("{{"), "template has an unbound slot");
    units.extend(rest.encode_utf16());
    Rendered {
        text: JsString::from_utf16_units(units),
        breakpoint: stable_prefix.encode_utf16().count(),
        stable_hash: format!("{:x}", Sha256::digest(stable_prefix.as_bytes())),
    }
}

fn lines<'a>(entries: impl IntoIterator<Item = (String, &'a JsString)>, limit: usize) -> JsString {
    let mut units = Vec::new();
    for (prefix, text) in entries {
        if !units.is_empty() {
            units.push(u16::from(b'\n'));
        }
        units.extend(prefix.encode_utf16());
        let text = text.as_utf16_units();
        units.extend_from_slice(&text[..text.len().min(limit)]);
    }
    JsString::from_utf16_units(units)
}

/// Light Dream's per-turn transcript excerpt (300 UTF-16 units per turn).
#[must_use]
pub fn conversation_insights(turns: &[(&str, JsString)]) -> Rendered {
    let evidence = lines(
        turns
            .iter()
            .map(|(role, text)| (format!("[{role}] "), text)),
        300,
    );
    render(INSIGHTS, &[&evidence])
}

/// REM's evidence sample (300 UTF-16 units per memory).
#[must_use]
pub fn rem_pattern(memories: &[JsString]) -> Rendered {
    let evidence = lines(memories.iter().map(|text| ("- ".to_owned(), text)), 300);
    render(REM_PATTERN, &[&evidence])
}

/// Skill Miner prompt v3. The caller supplies the already selected evidence group.
#[must_use]
pub fn skill_extraction(memories: &[JsString]) -> Rendered {
    let evidence = lines(
        memories
            .iter()
            .enumerate()
            .map(|(i, text)| (format!("{}. ", i + 1), text)),
        usize::MAX,
    );
    render(SKILL_EXTRACTION, &[&evidence])
}

/// The bounded public proposal fields used to request a one-sentence benefit.
pub struct Benefit<'a> {
    /// The proposal title, falling back to its skill name.
    pub title: &'a JsString,
    /// Proposal category, or `workflow` when absent.
    pub category: &'a JsString,
    /// Proposal description.
    pub description: &'a JsString,
    /// Proposal instructions.
    pub instructions: &'a JsString,
    /// Proposal examples, with the first three eligible.
    pub examples: &'a [JsString],
    /// Number of source memory identifiers.
    pub evidence_count: usize,
}

/// Render the skill benefit prompt using the pinned field limits.
#[must_use]
pub fn skill_benefit(proposal: &Benefit<'_>) -> Rendered {
    let default_category = JsString::from("workflow");
    let category = if proposal.category.is_empty() {
        &default_category
    } else {
        proposal.category
    };
    let mut examples = Vec::new();
    if !proposal.examples.is_empty() {
        examples.extend("Examples: ".encode_utf16());
        for (index, example) in proposal.examples.iter().take(3).enumerate() {
            if index != 0 {
                examples.extend(" | ".encode_utf16());
            }
            examples.extend_from_slice(example.utf16_slice(0, 200).as_utf16_units());
        }
        examples.push(u16::from(b'\n'));
    }
    render(
        SKILL_BENEFIT,
        &[
            &proposal.title.utf16_slice(0, 200),
            &category.utf16_slice(0, 60),
            &proposal.description.utf16_slice(0, 800),
            &proposal.instructions.utf16_slice(0, 1500),
            &JsString::from_utf16_units(examples),
            &JsString::from(proposal.evidence_count.to_string()),
        ],
    )
}
