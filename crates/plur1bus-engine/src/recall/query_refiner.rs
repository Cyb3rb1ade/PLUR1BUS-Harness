//! Port of the pin's deterministic `lib/query-refiner.js` (RE-D151): stopword removal,
//! a fixed synonym expansion and optional context keywords from the top result.
//! JS semantics: NFKD, `/[^\p{L}\p{M}\p{N}\s]/gu` → space, NFC, split on JS whitespace,
//! `toLowerCase` for table lookups and UTF-16 lengths. No model, no I/O.

use std::sync::OnceLock;

use crate::text::js::{
    is_js_whitespace, js_regex, js_to_lower_case, js_trim, nfc, nfkd, utf16_len, JsRegex,
};

/// The fields `refineQuery` reads from `results[0]`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RefinementTop<'a> {
    /// `top.score`; `None` is JavaScript `undefined`.
    pub score: Option<f64>,
    /// `top.entry`, when present: `(summary, text)`.
    pub entry: Option<(&'a str, &'a str)>,
}

fn separators() -> Option<&'static JsRegex> {
    static REGEX: OnceLock<Option<JsRegex>> = OnceLock::new();
    REGEX
        .get_or_init(|| js_regex(r"[^\p{L}\p{M}\p{N}\s]", "u").ok())
        .as_ref()
}

/// `String(x).normalize("NFKD").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").normalize("NFC")
/// .split(/\s+/).filter(Boolean)`.
fn words(input: &str) -> Vec<String> {
    let decomposed = nfkd(input);
    let mut replaced = String::with_capacity(decomposed.len());
    let mut last = 0;
    if let Some(Ok(matches)) = separators().map(|regex| regex.find_all(&decomposed)) {
        for found in matches {
            replaced.push_str(&decomposed[last..found.byte_start]);
            replaced.push(' ');
            last = found.byte_end;
        }
    }
    replaced.push_str(&decomposed[last..]);
    nfc(&replaced)
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn stopword(word: &str) -> bool {
    STOPWORDS.contains(&js_to_lower_case(word).as_str())
}

/// `removeStopwords`: the remaining words joined by one space.
#[must_use]
pub fn remove_stopwords(query: &str) -> String {
    words(query)
        .into_iter()
        .filter(|word| !stopword(word))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `expandQuery`: append at most three distinct synonyms to the original text.
#[must_use]
pub fn expand_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut expansions: Vec<&str> = Vec::new();
    for word in words(query) {
        let lower = js_to_lower_case(&word);
        if let Some((_, synonym)) = SYNONYMS.iter().find(|(key, _)| *key == lower) {
            if !expansions.contains(synonym) {
                expansions.push(synonym);
            }
        }
        if expansions.len() >= 3 {
            break;
        }
    }
    if expansions.is_empty() {
        return query.to_owned();
    }
    format!("{query} {}", expansions.join(" "))
}

/// `shouldRefineQuery` over the already score-filtered result scores.
#[must_use]
pub fn should_refine(scores: &[f64], min_score: f64) -> bool {
    scores.is_empty() || scores.iter().all(|score| *score < min_score)
}

/// `extractContextKeywords`: up to three distinct (case-insensitive) non-stopwords of
/// at least four UTF-16 units from `summary + " " + text`.
fn context_keywords(summary: &str, text: &str) -> String {
    let combined = format!("{summary} {text}");
    let mut seen = Vec::new();
    let mut picked = Vec::new();
    for word in words(js_trim(&combined)) {
        if utf16_len(&word) < 4 || stopword(&word) {
            continue;
        }
        let lower = js_to_lower_case(&word);
        if !seen.contains(&lower) {
            seen.push(lower);
            picked.push(word);
        }
        if picked.len() >= 3 {
            break;
        }
    }
    picked.join(" ")
}

/// `refineQuery(query, results)`, with `results[0]` supplied as `top`.
#[must_use]
pub fn refine_query(query: &str, top: Option<RefinementTop<'_>>) -> String {
    let original = js_trim(query);
    if original.is_empty() {
        return String::new();
    }
    let mut refined = remove_stopwords(original);
    if refined.is_empty() {
        original.clone_into(&mut refined);
    }
    refined = expand_query(&refined);
    if let Some(RefinementTop {
        score: Some(score),
        entry,
    }) = top
    {
        if score >= 0.05 {
            if let Some((summary, text)) = entry {
                let context = context_keywords(summary, text);
                if !context.is_empty() {
                    refined = format!("{refined} {context}");
                }
            }
        }
    }
    js_trim(&refined).to_owned()
}

/// `SYNONYM_MAP`, in source order (key lowercase, expansion as written).
pub const SYNONYMS: [(&str, &str); 22] = [
    ("docker", "Container"),
    ("container", "Docker"),
    ("kubernetes", "K8s"),
    ("k8s", "Kubernetes"),
    ("setup", "Installation"),
    ("installation", "Setup"),
    ("config", "Konfiguration"),
    ("configuration", "Konfiguration"),
    ("konfiguration", "Config"),
    ("server", "Host"),
    ("host", "Server"),
    ("database", "DB"),
    ("db", "Database"),
    ("api", "Schnittstelle"),
    ("schnittstelle", "API"),
    ("error", "Fehler"),
    ("fehler", "Error"),
    ("bug", "Fehler"),
    ("deploy", "Deployment"),
    ("deployment", "Deploy"),
    ("test", "Testing"),
    ("testing", "Test"),
];

/// `STOPWORDS` as the pin's `Set` holds them: source order, duplicates removed.
pub const STOPWORDS: [&str; 250] = [
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "einem", "einen",
    "und", "oder", "aber", "sondern", "doch", "jedoch", "denn", "weil", "obwohl", "wenn", "als",
    "ist", "sind", "war", "waren", "wird", "werden", "wurde", "wurden", "hat", "haben", "hatte",
    "hatten", "kann", "können", "konnte", "konnten", "soll", "sollen", "sollte", "sollten", "muss",
    "müssen", "musste", "mussten", "darf", "dürfen", "darfen", "will", "wollen", "wollte",
    "wollten", "möchte", "möchten", "ich", "du", "er", "sie", "es", "wir", "ihr", "Sie", "mir",
    "dir", "ihm", "uns", "euch", "ihnen", "mich", "dich", "ihn", "mein", "dein", "sein", "unser",
    "euer", "meine", "deine", "seine", "ihre", "unsere", "euere", "von", "zu", "zum", "zur", "bei",
    "mit", "ohne", "durch", "für", "gegen", "um", "über", "unter", "vor", "nach", "in", "an",
    "auf", "aus", "hinter", "neben", "zwischen", "diese", "dieser", "dieses", "diesen", "diesem",
    "jene", "jener", "jenes", "jenen", "jenem", "welche", "welcher", "welches", "welchen",
    "welchem", "was", "wer", "wo", "wann", "wie", "warum", "wohin", "woher", "auch", "nur", "noch",
    "schon", "immer", "nie", "oft", "sehr", "ganz", "mehr", "weniger", "am", "im", "vom", "ins",
    "aufs", "the", "a", "and", "or", "but", "if", "then", "else", "when", "where", "why", "how",
    "is", "are", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "would",
    "shall", "should", "may", "might", "can", "could", "must", "ought", "i", "you", "he", "she",
    "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "its", "our",
    "their", "mine", "yours", "hers", "ours", "theirs", "this", "that", "these", "those", "of",
    "to", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before",
    "after", "above", "below", "between", "under", "again", "further", "once", "here", "there",
    "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just", "now",
];
