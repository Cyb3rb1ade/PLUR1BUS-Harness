//! Node-order lexical guards for explicit memory-store merges (not turn-capture distance dedupe).
//! All Unicode classes/word splitting use the existing Node 24.21 text compatibility layer.

use super::{
    emotion_json::{object, string},
    fact_quality::matching::{lower, pattern_test, replace_pattern, split_whitespace, trim},
};
use crate::{
    contract::EngineError,
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Vocabulary {
    #[serde(rename = "TECH_TERMS")]
    tech: Vec<String>,
    #[serde(rename = "DATABASE_TERMS")]
    databases: Vec<String>,
    #[serde(rename = "NEGATION_MARKERS")]
    negation: Vec<String>,
    #[serde(rename = "TEMPORAL_MARKERS")]
    temporal: Vec<String>,
    #[serde(rename = "STOP_WORDS")]
    stop: Vec<String>,
    #[serde(rename = "ENTITY_IGNORE")]
    entity_ignore: Vec<String>,
}
fn vocabulary() -> Result<&'static Vocabulary, EngineError> {
    static VALUE: OnceLock<Result<Vocabulary, ()>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            let data: serde_json::Value =
                serde_json::from_str(include_str!("merge-safety-data.json")).map_err(|_| ())?;
            serde_json::from_value(data["vocabulary"].clone()).map_err(|_| ())
        })
        .as_ref()
        .map_err(|()| EngineError::NotAvailable {
            reason: "merge-safety-vocabulary".into(),
        })
}
fn add<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}
fn has(values: &[String], value: &str) -> bool {
    values.iter().any(|v| v == value)
}
fn strings(values: &[String]) -> Json {
    Json::Array(values.iter().map(|v| string(v)).collect())
}

/// Lowercase, replace punctuation, collapse ECMAScript whitespace; no NFC/NFKD repair.
pub fn normalize(text: &JsString) -> Result<JsString, EngineError> {
    let text = replace_pattern(r"[^\p{L}\p{N}\s]", "gu", &lower(text), " ")?;
    Ok(trim(&replace_pattern(r"\s+", "g", &text, " ")?))
}
fn tokens(text: &JsString) -> Result<Vec<String>, EngineError> {
    Ok(split_whitespace(&normalize(text)?)
        .into_iter()
        .filter(|v| !v.is_empty())
        .map(|v| v.to_utf8_lossy())
        .collect())
}

/// Insertion-ordered sets as returned by Node's salient-term extractor.
#[derive(Default)]
pub struct SalientTerms {
    /// ASCII number tokens; punctuation normalization splits decimal components.
    pub numbers: Vec<String>,
    /// Previous token paired with every recognized number.
    pub versions: Vec<String>,
    /// Titlecase words and adjacent titlecase compounds.
    pub entities: Vec<String>,
    /// Recognized technical terms, retaining pre-canonical spelling.
    pub technologies: Vec<String>,
    /// Recognized database terms.
    pub databases: Vec<String>,
    /// One-rule trailing-s stemmed content tokens.
    pub content_terms: Vec<String>,
    /// At least one exact negation token/bigram.
    pub has_negation: bool,
    /// At least one exact temporal token/bigram.
    pub has_temporal_marker: bool,
}
impl SalientTerms {
    /// Exact order of the Node object, with Sets projected as arrays by the recorder.
    #[must_use]
    pub fn to_json(&self) -> Json {
        object([
            ("numbers", strings(&self.numbers)),
            ("versions", strings(&self.versions)),
            ("entities", strings(&self.entities)),
            ("technologies", strings(&self.technologies)),
            ("databases", strings(&self.databases)),
            ("contentTerms", strings(&self.content_terms)),
            ("hasNegation", Json::Bool(self.has_negation)),
            ("hasTemporalMarker", Json::Bool(self.has_temporal_marker)),
        ])
    }
}
fn entity_word(word: &JsString, lexicon: &Vocabulary) -> Result<Option<String>, EngineError> {
    let clean = replace_pattern(r"[^\p{L}\p{N}\-]", "gu", word, "")?;
    if clean.utf16_len() <= 1 || !pattern_test(r"^[A-ZÄÖÜ][a-zäöüß\-]*(?:\.[a-z]+)?$", "u", &clean)?
    {
        return Ok(None);
    }
    let text = lower(&clean).to_utf8_lossy();
    Ok((!has(&lexicon.entity_ignore, &text)
        && !has(&lexicon.tech, &text)
        && !has(&lexicon.databases, &text))
    .then_some(text))
}
/// Extract ordered terms from a validated native string; malformed UTF-16 remains governed by Node regex semantics.
pub fn extract_terms(text: &JsString) -> Result<SalientTerms, EngineError> {
    let lexicon = vocabulary()?;
    let mut out = SalientTerms::default();
    let words = split_whitespace(text);
    for (index, word) in words.iter().enumerate() {
        if let Some(entity) = entity_word(word, lexicon)? {
            add(&mut out.entities, entity.clone());
            if let Some(next) = words.get(index + 1) {
                if let Some(next) = entity_word(next, lexicon)? {
                    add(&mut out.entities, format!("{entity} {next}"));
                }
            }
        }
    }
    let tokens = tokens(text)?;
    for (index, token) in tokens.iter().enumerate() {
        if pattern_test(r"^[0-9]+(\.[0-9]+)?$", "", &JsString::from(token.as_str()))? {
            add(&mut out.numbers, token.clone());
            if index > 0 {
                add(&mut out.versions, format!("{} {token}", tokens[index - 1]));
            }
            continue;
        }
        classify(token, lexicon, &mut out);
        if !has(&lexicon.stop, token)
            && !has(&lexicon.entity_ignore, token)
            && token.encode_utf16().count() > 1
        {
            let term = if token.encode_utf16().count() > 3
                && token.ends_with('s')
                && !token.ends_with("ss")
            {
                &token[..token.len() - 1]
            } else {
                token
            };
            add(&mut out.content_terms, term.to_owned());
        }
    }
    for pair in tokens.windows(2) {
        classify(&format!("{} {}", pair[0], pair[1]), lexicon, &mut out);
    }
    Ok(out)
}
fn classify(token: &str, lexicon: &Vocabulary, out: &mut SalientTerms) {
    if has(&lexicon.tech, token) {
        add(&mut out.technologies, token.to_owned());
    }
    if has(&lexicon.databases, token) {
        add(&mut out.databases, token.to_owned());
    }
    out.has_negation |= has(&lexicon.negation, token);
    out.has_temporal_marker |= has(&lexicon.temporal, token);
}

// TECH_SYNONYMS is a normal JS object: its inherited constructor is observable.
// Keep that distinct from strings; JSON.stringify serializes it as null in an array.
#[derive(Clone, PartialEq)]
enum Canonical {
    Text(String),
    Constructor,
}
impl Canonical {
    fn of(text: &str) -> Self {
        match text {
            "node.js" | "nodejs" => Self::Text("node".into()),
            "postgresql" => Self::Text("postgres".into()),
            "constructor" => Self::Constructor,
            _ => Self::Text(text.into()),
        }
    }
    fn json(&self) -> Json {
        match self {
            Self::Text(value) => string(value),
            Self::Constructor => Json::Null,
        }
    }
    fn joined(&self) -> &str {
        match self {
            Self::Text(value) => value,
            Self::Constructor => "function Object() { [native code] }",
        }
    }
}
fn canonical(values: impl IntoIterator<Item = String>) -> Vec<Canonical> {
    let mut out = Vec::new();
    for value in values {
        add(&mut out, Canonical::of(&value));
    }
    out
}
fn jaccard(a: &[String], b: &[String]) -> f64 {
    let mut union = Vec::new();
    for v in a.iter().chain(b) {
        add(&mut union, v);
    }
    let mut common = Vec::new();
    for v in a {
        if b.contains(v) {
            add(&mut common, v);
        }
    }
    if union.is_empty() {
        0.0
    } else {
        common.len() as f64 / union.len() as f64
    }
}
/// Ordered structured differences, including Node's prototype lookup quirk as evidence.
pub fn structured_differences(a: &JsString, b: &JsString) -> Result<Json, EngineError> {
    let a = extract_terms(a)?;
    let b = extract_terms(b)?;
    let mut out = Vec::new();
    for (kind, left, right) in [
        (
            "number",
            canonical(a.numbers.clone()),
            canonical(b.numbers.clone()),
        ),
        (
            "technology",
            canonical(a.technologies.iter().chain(&a.databases).cloned()),
            canonical(b.technologies.iter().chain(&b.databases).cloned()),
        ),
    ] {
        for (side, values, other) in [("a", &left, &right), ("b", &right, &left)] {
            for value in values {
                if !other.contains(value) {
                    out.push(object([
                        ("type", string(kind)),
                        ("value", value.json()),
                        ("side", string(side)),
                    ]));
                }
            }
        }
    }
    let ea = canonical(a.entities.clone());
    let eb = canonical(b.entities.clone());
    for (side, values, other) in [("a", &ea, &eb), ("b", &eb, &ea)] {
        let missing = values
            .iter()
            .filter(|v| !other.contains(v))
            .map(Canonical::json)
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            out.push(object([
                ("type", string("entity")),
                ("values", Json::Array(missing)),
                ("side", string(side)),
            ]));
        }
    }
    for (kind, different) in [
        ("negation", a.has_negation != b.has_negation),
        ("temporal", a.has_temporal_marker != b.has_temporal_marker),
    ] {
        if different {
            out.push(object([("type", string(kind))]));
        }
    }
    if ea.iter().any(|v| eb.contains(v)) {
        let ca = a
            .content_terms
            .iter()
            .filter(|t| !ea.contains(&Canonical::Text((*t).clone())))
            .cloned()
            .collect::<Vec<_>>();
        let cb = b
            .content_terms
            .iter()
            .filter(|t| !eb.contains(&Canonical::Text((*t).clone())))
            .cloned()
            .collect::<Vec<_>>();
        if !(ca.is_empty() && cb.is_empty()) && jaccard(&ca, &cb) < 0.5 {
            out.push(object([("type", string("shared_entity_divergent_facts"))]));
        }
    }
    Ok(Json::Array(out))
}
/// Preserve exact significant-token order: role-reversed facts are never duplicates.
pub fn meaningful_difference(a: &JsString, b: &JsString) -> Result<bool, EngineError> {
    if a == b || normalize(a)? == normalize(b)? {
        return Ok(false);
    }
    let lexicon = vocabulary()?;
    let ta = tokens(a)?;
    let tb = tokens(b)?;
    let sa = ta
        .iter()
        .filter(|t| !has(&lexicon.stop, t))
        .collect::<Vec<_>>();
    let sb = tb
        .iter()
        .filter(|t| !has(&lexicon.stop, t))
        .collect::<Vec<_>>();
    if sa.len() >= 2 && sa.len() == sb.len() && sa != sb {
        let mut sorted_a = sa;
        let mut sorted_b = sb;
        sorted_a.sort();
        sorted_b.sort();
        if sorted_a == sorted_b {
            return Ok(true);
        }
    }
    let Json::Array(differences) = structured_differences(a, b)? else {
        return Ok(false);
    };
    if differences.is_empty() {
        return Ok(false);
    }
    if differences
        .iter()
        .any(|v| super::emotion_json::get(v, "type") != &string("shared_entity_divergent_facts"))
    {
        return Ok(true);
    }
    Ok(jaccard(&ta, &tb) < 0.8)
}
/// Conservative explicit-store duplicate check; high embedding similarity alone is insufficient.
pub fn safe_duplicate(a: &JsString, b: &JsString) -> Result<bool, EngineError> {
    if a == b || normalize(a)? == normalize(b)? {
        return Ok(true);
    }
    let ta = tokens(a)?;
    let tb = tokens(b)?;
    let sequence = |tokens: &[String]| {
        tokens
            .iter()
            .map(|t| Canonical::of(t))
            .map(|t| t.joined().to_owned())
            .collect::<Vec<_>>()
            .join(" ")
    };
    if sequence(&ta) == sequence(&tb) {
        return Ok(true);
    }
    if meaningful_difference(a, b)? {
        return Ok(false);
    }
    let lexicon = vocabulary()?;
    let ta = ta
        .into_iter()
        .filter(|t| !has(&lexicon.stop, t))
        .collect::<Vec<_>>();
    let tb = tb
        .into_iter()
        .filter(|t| !has(&lexicon.stop, t))
        .collect::<Vec<_>>();
    Ok(jaccard(&ta, &tb) >= 0.9)
}
fn covers(source: &SalientTerms, merged: &SalientTerms) -> bool {
    source.numbers.iter().all(|v| merged.numbers.contains(v))
        && source.entities.iter().all(|v| merged.entities.contains(v))
        && source
            .content_terms
            .iter()
            .all(|v| merged.content_terms.contains(v))
        && source
            .technologies
            .iter()
            .chain(&source.databases)
            .all(|v| merged.technologies.contains(v) || merged.databases.contains(v))
        && (!source.has_negation || merged.has_negation)
        && (!source.has_temporal_marker || merged.has_temporal_marker)
}
/// Refuse a proposed merged text if either source loses any protected salient term.
pub fn preserves_facts(a: &JsString, b: &JsString, merged: &JsString) -> Result<bool, EngineError> {
    if trim(merged).is_empty() {
        return Ok(false);
    }
    let merged = extract_terms(merged)?;
    Ok(covers(&extract_terms(a)?, &merged) && covers(&extract_terms(b)?, &merged))
}
