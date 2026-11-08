//! Deterministic fact-quality and automatic importance rules from the pinned Node engine.
//!
//! Word and phrase matching retains the original NFC/NFD sensitivity and German defects.
//! No input text enters errors or logs; every returned reason is a fixed classification code.

use crate::{
    contract::EngineError,
    text::js::{self, JsString},
};
use serde::{Deserialize, Serialize};

#[path = "fact_quality_lexicon.rs"]
mod lexicon;
#[path = "fact_quality_text.rs"]
pub(crate) mod matching;

use lexicon::{
    ARCHITECTURE_WORDS, DURABLE_MARKERS, EMOTION_ONLY_WORDS, NEGATION_MARKERS, PREFERENCE_VERBS,
    PROJECT_TECH_TERMS, SECURITY_WORDS, STATUS_VERBS, TEMPORAL_MARKERS, TRIVIAL_FILLER,
};
use matching::{
    concat, contains_any, contains_phrase, content_count, join, lower, normalize, replace_pattern,
};
pub(super) use matching::{
    contains_named_entity, pattern_count, pattern_test, split_whitespace, tokenize, trim,
};

/// Maximum importance assigned automatically; the agent's intentional band begins above it.
pub const AUTOMATIC_IMPORTANCE_MAX: f64 = 0.94;

/// One deterministic detector's boolean and ordered reasons.
#[derive(Clone, Debug)]
pub struct Detection {
    /// Whether this signal is present.
    pub detected: bool,
    /// Fixed descriptions in the order the Node detector appends them.
    pub reasons: Vec<String>,
}

impl Detection {
    /// Encode the exported detector's actual boolean field, followed by its reasons.
    #[must_use]
    pub fn to_node_json(&self, field: &str) -> String {
        format!(
            "{{{}:{},\"reasons\":{}}}",
            JsString::from(field).to_json(),
            self.detected,
            strings_json(&self.reasons)
        )
    }
}

/// Durability classification; precedence is ephemeral, temporary, durable, unknown.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Durability {
    /// Node's durability band.
    pub durability: String,
    /// Ordered fixed explanations.
    pub reasons: Vec<String>,
}

/// Complete deterministic quality explanation used by importance and promotion.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactQuality {
    /// Durability band.
    pub durability: String,
    /// Ordered preference/project/correction/security hints.
    pub category_hints: Vec<String>,
    /// Low, medium or high importance band.
    pub importance_band: String,
    /// Whether durable material is eligible for promotion.
    pub should_promote: bool,
    /// Whether the memory should be downranked.
    pub should_downrank: bool,
    /// Ordered fixed explanations.
    pub reasons: Vec<String>,
}

impl FactQuality {
    /// Encode the explanatory fields in the exact order returned by the Node classifier.
    #[must_use]
    pub fn to_node_json(&self) -> String {
        quality_json(self)
    }
}

/// Importance floors and caps read by Node `normalizeImportanceScore`.
#[derive(Clone, Copy)]
pub struct ImportanceOptions {
    /// Apply the 0.2 cap to trivial content.
    pub downrank_trivial: bool,
    /// Apply the 0.45 cap to temporary content unless explicitly remembered.
    pub downrank_temporary: bool,
    /// Durable preference floor.
    pub min_durable_preference: f64,
    /// Concrete project fact floor.
    pub min_project_fact: f64,
    /// Explicit instruction/correction floor.
    pub min_explicit_remember: f64,
    /// Security/deployment fact floor.
    pub min_security_deploy: f64,
}

impl Default for ImportanceOptions {
    fn default() -> Self {
        Self {
            downrank_trivial: true,
            downrank_temporary: true,
            min_durable_preference: 0.55,
            min_project_fact: 0.65,
            min_explicit_remember: 0.7,
            min_security_deploy: 0.7,
        }
    }
}

impl ImportanceOptions {
    /// Read only the documented options, preserving explicit false values.
    #[must_use]
    pub fn from_json(options: &serde_json::Value) -> Self {
        let defaults = Self::default();
        Self {
            downrank_trivial: options
                .get("downrankTrivial")
                .map_or(defaults.downrank_trivial, json_truthy),
            downrank_temporary: options
                .get("downrankTemporary")
                .map_or(defaults.downrank_temporary, json_truthy),
            min_durable_preference: option_number(
                options,
                "minDurablePreference",
                defaults.min_durable_preference,
            ),
            min_project_fact: option_number(options, "minProjectFact", defaults.min_project_fact),
            min_explicit_remember: option_number(
                options,
                "minExplicitRemember",
                defaults.min_explicit_remember,
            ),
            min_security_deploy: option_number(
                options,
                "minSecurityDeploy",
                defaults.min_security_deploy,
            ),
        }
    }
}

/// Importance result with lossless caller-supplied category reasons.
pub struct MemoryImportance {
    /// Final finite importance score.
    pub importance: f64,
    /// Ordered explanations joined by a semicolon and space.
    pub importance_reason: JsString,
    /// Deterministic quality signals.
    pub fact_quality: FactQuality,
    /// Optional category explanation; absent remains undefined in Node JSON.
    pub category_reason: Option<JsString>,
}

impl MemoryImportance {
    /// Encode fields in Node order, preserving a lone surrogate in category reasons.
    #[must_use]
    pub fn to_node_json(&self) -> String {
        let mut out = format!(
            "{{\"importance\":{},\"importanceReason\":{},\"factQuality\":{}",
            number_json(self.importance),
            self.importance_reason.to_json(),
            quality_json(&self.fact_quality)
        );
        if let Some(reason) = &self.category_reason {
            out.push_str(&format!(",\"categoryReason\":{}", reason.to_json()));
        }
        out.push('}');
        out
    }
}

/// Empty/punctuation-only text, filler acknowledgements and content-free short phrases.
pub fn detect_trivial_memory(text: &JsString) -> Result<Detection, EngineError> {
    let lower = normalize(text);
    if lower.is_empty() || pattern_test(r"^[^a-zA-Z0-9\u00C0-\u024F]*$", "", text)? {
        return Ok(detection(true, &["empty or punctuation-only"]));
    }
    let tokens = tokenize(text)?;
    let cleaned = trim(&replace_pattern(r"[^\p{L}\p{N}\s]", "u", &lower, "")?);
    if tokens.len() <= 2 && TRIVIAL_FILLER.contains(&cleaned.to_utf8_lossy().as_str()) {
        return Ok(detection(true, &["filler acknowledgement"]));
    }
    Ok(if content_count(text)? == 0 && tokens.len() <= 3 {
        detection(true, &["no content tokens"])
    } else {
        detection(false, &[])
    })
}

/// Detect temporal markers and transient command/status output, retaining runtime-fact exceptions.
pub fn detect_temporary_memory(text: &JsString) -> Result<Detection, EngineError> {
    let lower = normalize(text);
    let mut out = detection(false, &[]);
    if contains_phrase(&lower, TEMPORAL_MARKERS)? {
        out.detected = true;
        out.reasons.push("contains temporary marker".to_owned());
    }
    let runtime = pattern_test(
        r"\b(läuft auf|runs on|deployed on|deployed to)\b",
        "i",
        &lower,
    )?;
    if contains_any(&lower, STATUS_VERBS)? && !runtime {
        out.detected = true;
        out.reasons.push("transient status verb".to_owned());
    }
    if !runtime
        && pattern_test(r"\b(npm|yarn|pnpm|test|build|deploy)\b", "", &lower)?
        && pattern_test(
            r"\b(finished|passed|failed|done|complete|läuft|fertig)\b",
            "",
            &lower,
        )?
    {
        out.detected = true;
        out.reasons.push("one-off command output".to_owned());
    }
    Ok(out)
}

/// Detect preference verbs and explicit durable instructions; temporary markers may override them.
pub fn detect_durable_preference(text: &JsString) -> Result<Detection, EngineError> {
    let lower = normalize(text);
    let mut out = detection(false, &[]);
    if contains_any(&lower, PREFERENCE_VERBS)? {
        out.detected = true;
        out.reasons.push("preference verb".to_owned());
    }
    let explicit = contains_phrase(&lower, DURABLE_MARKERS)?;
    if explicit {
        out.detected = true;
        out.reasons.push("explicit instruction".to_owned());
    }
    if detect_temporary_memory(text)?.detected && !explicit {
        out = detection(false, &["preference verb overridden by temporary marker"]);
    }
    Ok(out)
}

/// Detect technical/version/architecture/security facts and descriptive named entities.
pub fn detect_project_fact(text: &JsString) -> Result<Detection, EngineError> {
    let lower = normalize(text);
    let mut out = detection(false, &[]);
    let technical = contains_any(&lower, PROJECT_TECH_TERMS)?;
    let content = content_count(text)?;
    if technical {
        out.reasons.push("technical term".to_owned());
    }
    if technical && pattern_test(r"\b\d+(\.\d+)?\b", "", &lower)? {
        out.reasons
            .push("version or number with technical context".to_owned());
    }
    if contains_any(&lower, ARCHITECTURE_WORDS)? && content >= 3 {
        out.reasons
            .push("architecture language with substance".to_owned());
    }
    if contains_any(&lower, SECURITY_WORDS)? && content >= 3 {
        out.reasons.push("concrete security/deploy fact".to_owned());
    }
    if contains_named_entity(text)? && content >= 3 {
        out.reasons
            .push("named entity with descriptive content".to_owned());
    }
    out.detected = !out.reasons.is_empty();
    Ok(out)
}

/// Detect correction patterns, temporal negation and direct contradictions in Node order.
pub fn detect_correction_signal(text: &JsString) -> Result<Detection, EngineError> {
    let mut out = detection(false, &[]);
    for pattern in [
        r"\bnot\b.+?\banymore\b",
        r"\bno\s+longer\b",
        r"\binstead\s+of\b",
        r"\brather\s+than\b",
        r"\bstatt\b.+?\bnun\b",
        r"\bnicht\s+mehr\b",
        r"\bjetzt\b.+?\bstatt\b",
        r"\b(statt|sondern)\b",
    ] {
        if pattern_test(pattern, "i", text)? {
            out.reasons.push("correction pattern".to_owned());
            break;
        }
    }
    if contains_any(&normalize(text), NEGATION_MARKERS)? && detect_temporary_memory(text)?.detected
    {
        out.reasons.push("negation with temporal marker".to_owned());
    }
    if pattern_test(r"\b\w+\b\s*,?\s+not\s+\b\w+\b", "i", text)?
        || pattern_test(r"\b\w+\b\s*,?\s+nicht\s+\b\w+\b", "i", text)?
    {
        out.reasons.push("direct contradiction pattern".to_owned());
    }
    out.detected = !out.reasons.is_empty();
    Ok(out)
}

/// Classify durability with the Node short-circuit precedence and explanation list.
pub fn classify_fact_durability(text: &JsString) -> Result<Durability, EngineError> {
    let trivial = detect_trivial_memory(text)?;
    if trivial.detected {
        return Ok(durability("ephemeral", trivial.reasons));
    }
    let temporary = detect_temporary_memory(text)?;
    if temporary.detected {
        return Ok(durability("temporary", temporary.reasons));
    }
    let preference = detect_durable_preference(text)?;
    let project = detect_project_fact(text)?;
    let correction = detect_correction_signal(text)?;
    if preference.detected || project.detected || correction.detected {
        let reasons = [preference.reasons, project.reasons, correction.reasons].concat();
        return Ok(durability(
            "durable",
            if reasons.is_empty() {
                vec!["has durable content".to_owned()]
            } else {
                reasons
            },
        ));
    }
    Ok(durability(
        "unknown",
        vec!["no strong durability signal".to_owned()],
    ))
}

/// Explain the deterministic quality signals, floors and conservative promotion eligibility.
pub fn explain_fact_quality(text: &JsString) -> Result<FactQuality, EngineError> {
    let trivial = detect_trivial_memory(text)?;
    let temporary = detect_temporary_memory(text)?;
    let preference = detect_durable_preference(text)?;
    let project = detect_project_fact(text)?;
    let correction = detect_correction_signal(text)?;
    let mut hints = Vec::new();
    if preference.detected {
        hints.push("preference".to_owned());
    }
    if project.detected {
        hints.push("project".to_owned());
    }
    if correction.detected {
        hints.push("correction".to_owned());
    }
    if contains_any(text, SECURITY_WORDS)? {
        hints.push("security".to_owned());
    }
    let explicit = contains_phrase(&normalize(text), DURABLE_MARKERS)?;
    let (mut band, mut promote, downrank) =
        if trivial.detected || temporary.detected && !preference.detected {
            ("low", false, true)
        } else if correction.detected || explicit {
            ("high", true, false)
        } else if preference.detected {
            ("medium", true, false)
        } else if project.detected {
            (
                if content_count(text)? >= 5 {
                    "high"
                } else {
                    "medium"
                },
                true,
                false,
            )
        } else {
            ("low", false, false)
        };
    let mut reasons = [
        trivial.reasons,
        temporary.reasons,
        preference.reasons,
        project.reasons,
        correction.reasons,
    ]
    .concat();
    let tokens = tokenize(text)?;
    if !tokens.is_empty()
        && tokens
            .iter()
            .all(|t| EMOTION_ONLY_WORDS.contains(&t.as_str()) || js::utf16_len(t) <= 2)
    {
        band = "low";
        promote = false;
        reasons.push("emotion-only without durable preference".to_owned());
    }
    if !tokens.is_empty()
        && tokens
            .iter()
            .all(|t| PROJECT_TECH_TERMS.contains(&t.as_str()) || js::utf16_len(t) <= 2)
        && !correction.detected
        && !explicit
    {
        band = "low";
        promote = false;
        reasons.push("generic technical keywords without subject".to_owned());
    }
    if reasons.is_empty() {
        reasons.push("no strong signal".to_owned());
    }
    Ok(FactQuality {
        durability: classify_fact_durability(text)?.durability,
        category_hints: hints,
        importance_band: band.to_owned(),
        should_promote: promote,
        should_downrank: downrank,
        reasons,
    })
}

/// Preserve explicit importance, otherwise cap at the automatic band.
#[must_use]
pub fn cap_automatic_importance(value: f64, is_explicit: bool) -> f64 {
    if is_explicit || value.is_nan() {
        value
    } else {
        value.min(AUTOMATIC_IMPORTANCE_MAX)
    }
}

/// Apply the Node automatic/explicit scoring policy. Unused category/origin context is not invented.
pub fn compute_memory_importance(
    text: &JsString,
    category_reason: Option<&JsString>,
    explicit: Option<f64>,
) -> Result<MemoryImportance, EngineError> {
    let explicit = explicit.filter(|score| score.is_finite());
    let quality = explain_fact_quality(text)?;
    let mut reasons = Vec::new();
    if let Some(reason) = category_reason.filter(|reason| !reason.is_empty()) {
        reasons.push(concat(&[&JsString::from("category: "), reason]));
    }
    reasons.extend(
        quality
            .reasons
            .iter()
            .map(|reason| JsString::from(reason.as_str())),
    );
    let options = ImportanceOptions {
        downrank_temporary: explicit.is_none(),
        ..Default::default()
    };
    let normalized = normalize_importance_score(explicit, &reasons, &options)?;
    let capped = cap_automatic_importance(normalized, explicit.is_some());
    let mut reason = join(&reasons, "; ");
    if reason.is_empty() {
        reason = JsString::from("default importance");
    }
    if explicit.is_none() && capped < normalized {
        reason = concat(&[
            &reason,
            &JsString::from(format!(
                "; automatic cap {AUTOMATIC_IMPORTANCE_MAX} applied (was {normalized})"
            )),
        ]);
    }
    Ok(MemoryImportance {
        importance: capped,
        importance_reason: reason,
        fact_quality: quality,
        category_reason: category_reason.cloned(),
    })
}

/// Conservative promotion gate; only decision/fact categories qualify.
#[must_use]
pub fn should_promote_memory(
    category: &str,
    importance: f64,
    quality: Option<&FactQuality>,
    threshold: f64,
) -> bool {
    let Some(quality) = quality else {
        return false;
    };
    if quality.should_downrank || !quality.should_promote && importance < threshold {
        return false;
    }
    matches!(category, "decision" | "fact") && importance >= threshold
}

/// Apply ordered floors followed by temporary/trivial caps, then the finite unit interval clamp.
pub fn normalize_importance_score(
    score: Option<f64>,
    reasons: &[JsString],
    opts: &ImportanceOptions,
) -> Result<f64, EngineError> {
    let lowered: Vec<_> = reasons.iter().map(lower).collect();
    let has = |pattern: &str| -> Result<bool, EngineError> {
        for reason in &lowered {
            if pattern_test(pattern, "", reason)? {
                return Ok(true);
            }
        }
        Ok(false)
    };
    let trivial =
        has(r"filler acknowledgement|empty or punctuation-only|no content tokens|trivial")?;
    let temporary = has(r"temporary marker|transient status|one-off command")?;
    let explicit = has(r"\bexplicit instruction\b|explicit remember instruction|remember this")?;
    let generic = has(r"\bgeneric technical keywords without subject\b")?;
    let mut value = score.filter(|score| score.is_finite()).unwrap_or(0.5);
    if has(r"\bpreference verb\b")? {
        value = max(value, opts.min_durable_preference);
    }
    if explicit {
        value = max(value, opts.min_explicit_remember);
    }
    if !generic
        && has(
            r"\b(architecture language with substance|technical term|version or number with technical context|named entity with descriptive content)\b",
        )?
    {
        value = max(value, opts.min_project_fact);
    }
    if has(r"\b(correction pattern|direct contradiction pattern|negation with temporal marker)\b")?
    {
        value = max(value, opts.min_explicit_remember);
    }
    if has(r"\bconcrete security\/deploy fact\b")? {
        value = max(value, opts.min_security_deploy);
    }
    if opts.downrank_temporary && temporary && !explicit {
        value = if value.is_nan() {
            value
        } else {
            value.min(0.45)
        };
    }
    if opts.downrank_trivial && trivial {
        value = if value.is_nan() {
            value
        } else {
            value.min(0.2)
        };
    }
    Ok(if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    })
}

fn detection(detected: bool, reasons: &[&str]) -> Detection {
    Detection {
        detected,
        reasons: reasons.iter().map(|r| (*r).to_owned()).collect(),
    }
}
fn durability(value: &str, reasons: Vec<String>) -> Durability {
    Durability {
        durability: value.to_owned(),
        reasons,
    }
}
fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
fn strings_json(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|s| JsString::from(s.as_str()).to_json())
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn quality_json(q: &FactQuality) -> String {
    format!("{{\"durability\":{},\"categoryHints\":{},\"importanceBand\":{},\"shouldPromote\":{},\"shouldDownrank\":{},\"reasons\":{}}}",
        JsString::from(q.durability.as_str()).to_json(), strings_json(&q.category_hints), JsString::from(q.importance_band.as_str()).to_json(), q.should_promote, q.should_downrank, strings_json(&q.reasons))
}

/// Encode finite score results using the Node JSON number spelling.
#[must_use]
pub fn number_json(value: f64) -> String {
    crate::text::json::write_json(&super::dynamics::json_number(value))
}

fn json_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn option_number(value: &serde_json::Value, key: &str, default: f64) -> f64 {
    match value.get(key) {
        None => default,
        Some(serde_json::Value::Null) => 0.0,
        Some(serde_json::Value::Bool(b)) => f64::from(*b),
        Some(serde_json::Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        Some(v) => v.as_f64().unwrap_or(f64::NAN),
    }
}
