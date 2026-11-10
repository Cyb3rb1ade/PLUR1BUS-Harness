//! Port of the pin's `resolveLocale`/`detectLanguage` (`lib/i18n.js`, RE-D152).
//! Deterministic and without I/O: config, context language, then two or more
//! German function words among the last three user texts.

use crate::text::js::{is_js_whitespace, js_to_lower_case};

/// `GERMAN_WORDS` as the pin's `Set` holds them: source order, duplicates removed.
pub const GERMAN_WORDS: [&str; 64] = [
    "der", "die", "das", "und", "ist", "zu", "den", "mit", "ich", "auf", "für", "sich", "dem",
    "nicht", "ein", "eine", "als", "auch", "es", "an", "werden", "aus", "er", "hat", "dass", "sie",
    "nach", "wird", "bei", "einer", "um", "am", "sind", "noch", "wie", "einen", "so", "zur",
    "aber", "über", "dich", "dein", "deine", "dir", "mir", "mich", "mein", "meine", "wir", "uns",
    "unser", "euch", "euer", "ihr", "ihnen", "ja", "nein", "bitte", "danke", "gern", "hallo", "hi",
    "hej", "moin",
];

/// One message as the pin reads it: `role`, and `content` only when it is a string.
#[derive(Clone, Copy, Debug)]
pub struct LocaleMessage<'a> {
    /// `m.role`, when present.
    pub role: Option<&'a str>,
    /// `m.content` when `typeof m.content === "string"`.
    pub content: Option<&'a str>,
}

/// `detectLanguage(messages)`: `"de"` with two or more German words, otherwise `"en"`.
#[must_use]
pub fn detect_language(messages: &[LocaleMessage<'_>]) -> &'static str {
    let texts = messages
        .iter()
        .filter(|message| message.role == Some("user"))
        .filter_map(|message| message.content)
        .collect::<Vec<_>>();
    if texts.is_empty() {
        return "en";
    }
    let sample = js_to_lower_case(&texts[texts.len().saturating_sub(3)..].join(" "));
    let hits = sample
        .split(is_js_whitespace)
        .filter(|word| GERMAN_WORDS.contains(word))
        .count();
    if hits >= 2 {
        "de"
    } else {
        "en"
    }
}

/// `resolveLocale({config, ctx, messages, fallback})`.
#[must_use]
pub fn resolve_locale(
    config: Option<&str>,
    context_lang: Option<&str>,
    messages: &[LocaleMessage<'_>],
    fallback: &str,
) -> String {
    if let Some(config) = config.filter(|value| !value.is_empty()) {
        return config.to_owned();
    }
    if let Some(lang) = context_lang.filter(|value| !value.is_empty()) {
        return lang.to_owned();
    }
    if !messages.is_empty() {
        return detect_language(messages).to_owned();
    }
    fallback.to_owned()
}
