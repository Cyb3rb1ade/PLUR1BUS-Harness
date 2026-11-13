//! Locale selection for persona jobs, matching the S6 guard release.
//! Recall keeps its Phase 1 locale heuristic and recorded reference vectors.
use std::sync::OnceLock;

use crate::{
    recall::locale::{LocaleMessage, GERMAN_WORDS},
    text::js::{js_to_lower_case, js_trim},
};

const ENGLISH_WORDS: &[&str] = &[
    "the", "and", "is", "are", "were", "you", "your", "i", "my", "we", "with", "that", "this",
    "for", "of", "it", "have", "has", "not", "to", "be", "on", "at", "from", "what", "how", "when",
    "thanks", "please", "yes", "but", "can", "do", "just", "if", "or", "me", "he", "she", "they",
    "there",
];

/// Normalize a valid language tag to the dictionary's lowercase primary language.
#[must_use]
pub fn normalize_language(value: &str) -> Option<String> {
    let mut parts = js_trim(value).split(['-', '_']);
    let primary = parts.next()?;
    ((2..=3).contains(&primary.len())
        && primary.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        }))
    .then(|| primary.to_ascii_lowercase())
}

/// Inspect at most the last three user texts. English wins ties.
#[must_use]
pub fn detect_language(messages: &[LocaleMessage<'_>]) -> &'static str {
    static NON_LETTERS: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let Some(pattern) = NON_LETTERS.get_or_init(|| regex::Regex::new(r"[^\p{L}]+").ok()) else {
        return "en";
    };
    let (mut german, mut english) = (0, 0);
    for text in messages
        .iter()
        .rev()
        .filter(|message| message.role == Some("user"))
        .filter_map(|message| message.content)
        .take(3)
    {
        let text = js_to_lower_case(text);
        for word in pattern.split(&text) {
            german += usize::from(
                !matches!(word, "am" | "an" | "so" | "hi") && GERMAN_WORDS.contains(&word),
            );
            english += usize::from(ENGLISH_WORDS.contains(&word));
        }
    }
    if german >= 2 && german > english {
        "de"
    } else {
        "en"
    }
}
