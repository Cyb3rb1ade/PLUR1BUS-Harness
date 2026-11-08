//! Pure strength, encoding and promotion rules from pinned `lib/memory-dynamics.js`.
//!
//! Ordered tolerant JSON retains Node's entry-spread order and unknown row fields.
//! Retrieval reinforcement only computes a patch: recall owns its application and counters.

use crate::text::{
    js::{js_to_lower_case, js_trim, JsString},
    json::TolerantJsonValue as Json,
};
use sha2::{Digest, Sha256};

/// Threshold shared by intentional core markers and deep emotional core encoding.
pub const CORE_MEMORY_THRESHOLD: f64 = 0.95;
/// Core half-life, in days.
pub const CORE_MEMORY_HALF_LIFE_DAYS: f64 = 36_500.0;
/// Lower edge of the agent's intentional importance band.
pub const AGENT_BAND_MIN: f64 = 0.95;
/// Ten-year flashbulb floor when the feature is explicitly enabled.
pub const FLASHBULB_HALF_LIFE_DAYS: f64 = 3650.0;
/// Calibrated automatic flashbulb score threshold.
pub const FLASHBULB_THRESHOLD: f64 = 0.8;
/// Historical floor retained while flashbulb encoding is disabled (R16).
pub const FLASHBULB_HALF_LIFE_LEGACY_DAYS: f64 = 90.0;
/// Intentional importance marker; repetition alone cannot reach this band.
pub const MANUAL_CORE_IMPORTANCE: f64 = AGENT_BAND_MIN;
/// Retrieval may extend ordinary half-lives up to this cap, without shortening longer ones.
pub const RETRIEVAL_HALF_LIFE_MAX_DAYS: f64 = 600.0;
/// Momentary retrieval strengthening.
pub const RETRIEVAL_STRENGTH_BOOST: f64 = 0.15;
/// Spaced retrieval extension multiplier.
pub const RETRIEVAL_HALF_LIFE_FACTOR: f64 = 1.15;
/// Minimum interval between half-life extensions.
pub const RETRIEVAL_MIN_SPACING_MS: f64 = 86_400_000.0;

/// Missing and null status count as active; an empty status does not.
#[must_use]
pub fn is_live_row(row: &Json) -> bool {
    js_string(nullish(get(row, "status"), &string("active"))) == "active"
}

/// Whether the row carries a manual importance marker, including Node Number coercion.
#[must_use]
pub fn is_manual_core_marker(row: &Json) -> bool {
    number(get(row, "importance")) >= MANUAL_CORE_IMPORTANCE
}

/// Exact core class or a boolean/numeric never-forget marker; strings do not qualify.
#[must_use]
pub fn is_core_memory(row: &Json) -> bool {
    get(row, "memoryClass") == Some(&string("core"))
        || get(row, "neverForget") == Some(&Json::Bool(true))
        || matches!(get(row, "neverForget"), Some(Json::Number(n)) if n.parse::<f64>() == Ok(1.0))
}

/// Merge expiry preserves permanence (zero, absent or non-finite); otherwise the later expiry wins.
/// Both the capture merge and explicit store adapters use this C7 rule.
pub fn merged_expires_at(candidate: Option<&Json>, incoming: Option<&Json>) -> f64 {
    let a = number(candidate);
    let b = number(incoming);
    if !a.is_finite() || a <= 0. || !b.is_finite() || b <= 0. {
        0.
    } else {
        a.max(b)
    }
}

/// Exponential forgetting after the first valid dynamics/strengthening/creation timestamp.
#[must_use]
pub fn compute_decayed_strength(row: &Json, now: f64) -> f64 {
    if is_core_memory(row) {
        return 1.0;
    }
    let initial = clamp(
        number(Some(nullish(get(row, "memoryStrength"), &json_number(1.0)))),
        0.01,
        1.0,
    );
    let half_life = num_or(row, "halfLifeDays", 30.0);
    let half_life = if half_life.is_finite() {
        half_life.max(1.0)
    } else {
        30.0
    };
    let elapsed =
        now - first_timestamp(row, &["lastDynamicsAt", "lastStrengthenedAt", "createdAt"]);
    if !elapsed.is_finite() || elapsed <= 0.0 {
        return initial;
    }
    clamp(
        initial * 0.5_f64.powf(elapsed / (half_life * 86_400_000.0)),
        0.01,
        1.0,
    )
}

/// Compute retrieval counters and spaced strength/half-life reinforcement without writing them.
#[must_use]
pub fn apply_retrieval_reinforcement(row: &Json, now: f64) -> Json {
    let count = number_or_zero(number(get(row, "retrievalCount"))) + 1.0;
    if is_core_memory(row) {
        return object(&[
            ("retrievalCount", json_number(count)),
            ("lastRetrievedAt", json_number(now)),
            ("memoryStrength", json_number(1.0)),
            ("lastStrengthenedAt", json_number(now)),
            ("lastDynamicsAt", json_number(now)),
        ]);
    }
    let strength = clamp(
        compute_decayed_strength(row, now) + RETRIEVAL_STRENGTH_BOOST,
        0.01,
        0.99,
    );
    let raw = number(get(row, "halfLifeDays"));
    let current = if raw.is_finite() && raw > 0.0 {
        raw
    } else {
        30.0
    };
    let elapsed =
        now - first_timestamp(row, &["lastStrengthenedAt", "lastDynamicsAt", "createdAt"]);
    let extended = if elapsed.is_finite() && elapsed >= RETRIEVAL_MIN_SPACING_MS {
        RETRIEVAL_HALF_LIFE_MAX_DAYS.min(current * RETRIEVAL_HALF_LIFE_FACTOR)
    } else {
        current
    };
    object(&[
        ("retrievalCount", json_number(count)),
        ("lastRetrievedAt", json_number(now)),
        ("memoryStrength", json_number(strength)),
        ("halfLifeDays", json_number(current.max(extended))),
        ("lastStrengthenedAt", json_number(now)),
        ("lastDynamicsAt", json_number(now)),
    ])
}

/// Explain promotion eligibility in Node order, including its unbounded candidate score.
#[must_use]
pub fn compute_promotion_candidate(row: &Json, sessions: f64) -> Json {
    let mut reasons = Vec::new();
    let retrievals = number_or_zero(number(get(row, "retrievalCount")));
    let importance = num_or(row, "importance", 0.5);
    let category = lower(row, "category");
    if lower(row, "memoryClass") == "core" {
        reasons.push(string("memoryClass is core — already highest class"));
        return promotion(false, 0.0, reasons);
    }
    if retrievals < 3.0 {
        reasons.push(string(&format!(
            "retrievalCount {} < 3",
            number_text(retrievals)
        )));
    }
    if importance < 0.7 {
        reasons.push(string(&format!(
            "importance {} < 0.7",
            number_text(importance)
        )));
    }
    if sessions < 2.0 {
        reasons.push(string(&format!(
            "sessionCount {} < 2",
            number_text(sessions)
        )));
    }
    if category == "fact" || category == "general" {
        reasons.push(string(&format!(
            "category '{category}' is transient — not eligible"
        )));
    }
    let candidate = retrievals >= 3.0
        && importance >= 0.7
        && sessions >= 2.0
        && category != "fact"
        && category != "general";
    let score = if candidate {
        reasons.push(string("meets all promotion criteria"));
        importance * 0.4 + (retrievals / 10.0) * 0.3 + (sessions / 5.0) * 0.3
    } else {
        0.0
    };
    promotion(candidate, score, reasons)
}

fn promotion(candidate: bool, score: f64, reasons: Vec<Json>) -> Json {
    object(&[
        ("isCandidate", Json::Bool(candidate)),
        ("score", json_number(score)),
        ("reasons", Json::Array(reasons)),
    ])
}

/// Compute a daily decay patch without strengthening or retrieval counter updates.
#[must_use]
pub fn apply_daily_decay(row: &Json, now: f64) -> Json {
    object(&[
        (
            "memoryStrength",
            json_number(compute_decayed_strength(row, now)),
        ),
        ("lastDynamicsAt", json_number(now)),
    ])
}

/// Flashbulb importance/emotion aggregate, clamped exactly like Node.
#[must_use]
pub fn compute_flashbulb_score(row: &Json) -> f64 {
    clamp(
        num_or(row, "emotionalIntensity", 0.0) * 0.5 + num_or(row, "importance", 0.5) * 0.5,
        0.0,
        1.0,
    )
}

/// Modulate a positive base half-life, preserving an invalid/nonpositive base's original type.
#[must_use]
pub fn modulate_half_life_days(base: &Json, intensity: &Json, factor: &Json) -> Json {
    let days = number(Some(base));
    if !days.is_finite() || days <= 0.0 {
        return base.clone();
    }
    let factor = number(Some(factor));
    let factor = if factor.is_finite() {
        factor.max(0.0)
    } else {
        1.0
    };
    json_number((days * (1.0 + clamp(number(Some(intensity)), 0.0, 1.0) * factor)).round())
}

/// Encode flashbulb strength when its threshold is crossed, never shortening the supplied base.
#[must_use]
pub fn apply_flashbulb_encoding(
    row: &Json,
    now: f64,
    threshold: f64,
    base: f64,
    floor: f64,
) -> Option<Json> {
    if compute_flashbulb_score(row) < threshold {
        return None;
    }
    let floor = if floor.is_finite() {
        floor
    } else {
        FLASHBULB_HALF_LIFE_DAYS
    };
    Some(object(&[
        ("memoryStrength", json_number(0.95)),
        ("halfLifeDays", json_number(number_or_zero(base).max(floor))),
        ("lastStrengthenedAt", json_number(now)),
        ("lastDynamicsAt", json_number(now)),
    ]))
}

/// Existing/manual core markers qualify immediately; other rows need both high emotion and importance.
#[must_use]
pub fn compute_core_memory_score(row: &Json) -> f64 {
    if is_core_memory(row) || is_manual_core_marker(row) {
        return 1.0;
    }
    let emotion = num_or(row, "emotionalIntensity", 0.0);
    let importance = num_or(row, "importance", 0.5);
    if emotion < CORE_MEMORY_THRESHOLD || importance < CORE_MEMORY_THRESHOLD {
        return 0.0;
    }
    clamp(emotion * 0.5 + importance * 0.5, 0.0, 1.0)
}

/// Core encoding clears expiry and sets the protected class/half-life at the configured threshold.
#[must_use]
pub fn apply_core_memory_encoding(row: &Json, now: f64, threshold: f64) -> Option<Json> {
    let score = compute_core_memory_score(row);
    if score < threshold {
        return None;
    }
    let reason = or_value(
        get(row, "coreMemoryReason"),
        string(if is_manual_core_marker(row) {
            "manual_importance_marker"
        } else {
            "deep_flashbulb_threshold"
        }),
    );
    Some(object(&[
        ("memoryClass", string("core")),
        ("neverForget", json_number(1.0)),
        ("coreMemoryScore", json_number(score)),
        ("coreMemoryReason", reason),
        ("memoryStrength", json_number(1.0)),
        ("halfLifeDays", json_number(CORE_MEMORY_HALF_LIFE_DAYS)),
        ("expiresAt", json_number(0.0)),
        ("lastStrengthenedAt", json_number(now)),
        ("lastDynamicsAt", json_number(now)),
    ]))
}

/// Resolve category defaults or raw non-null config overrides; core and dream classes take precedence.
#[must_use]
pub fn resolve_half_life_days(
    category: &str,
    memory_class: Option<&str>,
    overrides: &Json,
) -> Json {
    if memory_class == Some("core") {
        return json_number(CORE_MEMORY_HALF_LIFE_DAYS);
    }
    let (group, default) = if memory_class == Some("dream") {
        ("dream", 30.0)
    } else {
        match js_to_lower_case(category).as_str() {
            "fact" | "general" => ("transient", 60.0),
            "person" | "work" => ("longContext", 600.0),
            "project" | "decision" => ("project", 600.0),
            _ => ("episodic", 180.0),
        }
    };
    nullish(get(overrides, group), &json_number(default)).clone()
}

/// Resolve encoding bands; intentional agent importance precedes flashbulb and automatic bands.
#[must_use]
pub fn resolve_half_life_from_encoding(importance: &Json, flashbulb: bool) -> f64 {
    let importance = number(Some(importance));
    let importance = if importance.is_finite() {
        importance
    } else {
        0.5
    };
    if importance >= AGENT_BAND_MIN {
        CORE_MEMORY_HALF_LIFE_DAYS
    } else if flashbulb {
        FLASHBULB_HALF_LIFE_DAYS
    } else if importance < 0.4 {
        30.0
    } else if importance < 0.7 {
        180.0
    } else {
        600.0
    }
}

/// Apply new-entry encoding/version defaults, or decay an existing row, retaining property order.
#[must_use]
pub fn apply_dynamics_defaults(entry: &Json, now: f64, overrides: &Json, opts: &Json) -> Json {
    let mut out = entry.clone();
    if !truthy(get(entry, "lastDynamicsAt")) {
        apply_new_encoding(entry, &mut out, now, overrides, opts);
        apply_new_defaults(entry, &mut out, now);
    } else {
        let decayed = apply_daily_decay(&out, now);
        assign(&mut out, &decayed);
        for name in ["replayCount", "lastReplayed"] {
            set(
                &mut out,
                name,
                nullish(get(entry, name), &json_number(0.0)).clone(),
            );
        }
    }
    out
}

/// Construct the privacy-preserving retrieval record; recall supplies its UUID and owns persistence.
/// The query is hashed after Node string coercion and is never included in the returned record.
#[must_use]
pub fn create_retrieval_ledger_entry(params: &Json, id: &str, now: f64) -> Json {
    let query_hash = if truthy(get(params, "queryHash")) {
        get(params, "queryHash").cloned().unwrap_or(Json::Null)
    } else if truthy(get(params, "query")) {
        let query = js_string(get(params, "query").unwrap_or(&Json::Null));
        string(&format!("{:x}", Sha256::digest(query.as_bytes())))
    } else {
        Json::Null
    };
    let selected = match get(params, "selectedIds") {
        Some(Json::Array(ids)) => Json::Array(ids.clone()),
        _ => Json::Array(Vec::new()),
    };
    object(&[
        ("id", string(id)),
        ("agentId", or_value(get(params, "agentId"), Json::Null)),
        (
            "workspaceKey",
            or_value(get(params, "workspaceKey"), Json::Null),
        ),
        ("queryHash", query_hash),
        (
            "resultsCount",
            nullish(get(params, "resultsCount"), &json_number(0.0)).clone(),
        ),
        ("selectedIds", selected),
        (
            "timestamp",
            get(params, "timestamp")
                .cloned()
                .unwrap_or_else(|| json_number(now)),
        ),
    ])
}

fn apply_new_encoding(entry: &Json, out: &mut Json, now: f64, overrides: &Json, opts: &Json) {
    let base = get(entry, "halfLifeDays")
        .filter(|v| **v != Json::Null)
        .cloned()
        .unwrap_or_else(|| {
            let days = resolve_half_life_days(
                &js_string(get(entry, "category").unwrap_or(&Json::Null)),
                get(entry, "memoryClass").map(js_string).as_deref(),
                overrides,
            );
            modulate_half_life_days(
                &days,
                get(entry, "emotionalIntensity").unwrap_or(&Json::Null),
                nullish(get(opts, "intensityHalfLifeFactor"), &json_number(1.0)),
            )
        });
    if let Some(core) = apply_core_memory_encoding(out, now, CORE_MEMORY_THRESHOLD) {
        assign(out, &core);
        return;
    }
    let floor = if get(opts, "flashbulbEncodingEnabled") == Some(&Json::Bool(true)) {
        FLASHBULB_HALF_LIFE_DAYS
    } else {
        FLASHBULB_HALF_LIFE_LEGACY_DAYS
    };
    if let Some(flashbulb) =
        apply_flashbulb_encoding(out, now, FLASHBULB_THRESHOLD, number(Some(&base)), floor)
    {
        assign(out, &flashbulb);
        set(
            out,
            "memoryClass",
            or_value(get(entry, "memoryClass"), string("flashbulb")),
        );
    } else {
        set(
            out,
            "memoryStrength",
            nullish(get(entry, "memoryStrength"), &json_number(1.0)).clone(),
        );
        set(out, "halfLifeDays", base);
        set(out, "lastDynamicsAt", json_number(now));
        set(
            out,
            "memoryClass",
            or_value(get(entry, "memoryClass"), string("standard")),
        );
    }
    set(
        out,
        "neverForget",
        json_number(f64::from(truthy(get(entry, "neverForget")))),
    );
    let core_score = nullish(
        get(entry, "coreMemoryScore"),
        &json_number(compute_core_memory_score(out)),
    )
    .clone();
    set(out, "coreMemoryScore", core_score);
    set(
        out,
        "coreMemoryReason",
        or_value(get(entry, "coreMemoryReason"), string("")),
    );
}

fn apply_new_defaults(entry: &Json, out: &mut Json, now: f64) {
    for (name, default) in [
        ("retrievalCount", 0.0),
        ("lastRetrievedAt", 0.0),
        ("replayCount", 0.0),
        ("lastReplayed", 0.0),
    ] {
        set(
            out,
            name,
            nullish(get(entry, name), &json_number(default)).clone(),
        );
    }
    let strengthened = nullish(
        get(out, "lastStrengthenedAt"),
        nullish(get(entry, "lastStrengthenedAt"), &json_number(0.0)),
    )
    .clone();
    set(out, "lastStrengthenedAt", strengthened);
    set(
        out,
        "versionNumber",
        nullish(get(entry, "versionNumber"), &json_number(1.0)).clone(),
    );
    for name in [
        "previousVersion",
        "supersededBy",
        "updateSource",
        "updateEvidence",
    ] {
        set(out, name, or_value(get(entry, name), string("")));
    }
    set(
        out,
        "reconsolidationConfidence",
        nullish(get(entry, "reconsolidationConfidence"), &json_number(0.0)).clone(),
    );
    set(
        out,
        "status",
        or_value(get(entry, "status"), string("active")),
    );
    for name in ["versionCreatedAt", "updatedAt"] {
        set(out, name, or_value(get(entry, name), json_number(now)));
    }
}

fn get<'a>(row: &'a Json, name: &str) -> Option<&'a Json> {
    if let Json::Object(fields) = row {
        fields
            .iter()
            .rev()
            .find(|(key, _)| key == &JsString::from(name))
            .map(|(_, value)| value)
    } else {
        None
    }
}

fn nullish<'a>(value: Option<&'a Json>, default: &'a Json) -> &'a Json {
    value
        .filter(|value| **value != Json::Null)
        .unwrap_or(default)
}

pub(super) fn truthy(value: Option<&Json>) -> bool {
    match value {
        None | Some(Json::Null) => false,
        Some(Json::Bool(v)) => *v,
        Some(Json::Number(raw)) => raw.parse::<f64>().is_ok_and(|v| v != 0.0 && !v.is_nan()),
        Some(Json::String(v)) => !v.is_empty(),
        Some(Json::Array(_) | Json::Object(_)) => true,
    }
}

fn or_value(value: Option<&Json>, default: Json) -> Json {
    value
        .filter(|value| truthy(Some(value)))
        .cloned()
        .unwrap_or(default)
}

pub(crate) fn number(value: Option<&Json>) -> f64 {
    match value {
        None | Some(Json::Object(_)) => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(value)) => f64::from(*value),
        Some(Json::Number(raw)) => raw.parse().unwrap_or(f64::NAN),
        Some(Json::String(_) | Json::Array(_)) => {
            parse_number(&js_string(value.unwrap_or(&Json::Null)))
        }
    }
}

fn parse_number(raw: &str) -> f64 {
    let raw = js_trim(raw);
    if raw.is_empty() {
        return 0.0;
    }
    if matches!(raw, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if raw == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = raw.strip_prefix(prefix) {
            return radix_number(digits, radix);
        }
    }
    if raw
        .chars()
        .any(|ch| !ch.is_ascii_digit() && !"+-.eE".contains(ch))
    {
        return f64::NAN;
    }
    raw.parse().unwrap_or(f64::NAN)
}

fn radix_number(raw: &str, radix: u32) -> f64 {
    if raw.is_empty() {
        return f64::NAN;
    }
    // Convert to an exact decimal integer before the single IEEE-754 rounding step.
    // Repeated f64 multiply/add would round large hex values at every digit.
    let mut decimal = vec![0_u32];
    for digit in raw.chars() {
        let Some(mut carry) = digit.to_digit(radix) else {
            return f64::NAN;
        };
        if !digit.is_ascii() {
            return f64::NAN;
        }
        for place in &mut decimal {
            let value = *place * radix + carry;
            *place = value % 10;
            carry = value / 10;
        }
        while carry > 0 {
            decimal.push(carry % 10);
            carry /= 10;
        }
    }
    let text: String = decimal
        .into_iter()
        .rev()
        .filter_map(|digit| char::from_digit(digit, 10))
        .collect();
    text.parse().unwrap_or(f64::NAN)
}

fn num_or(row: &Json, name: &str, default: f64) -> f64 {
    number(Some(nullish(get(row, name), &json_number(default))))
}
fn number_or_zero(value: f64) -> f64 {
    if value.is_nan() || value == 0.0 {
        0.0
    } else {
        value
    }
}
fn lower(row: &Json, name: &str) -> String {
    js_to_lower_case(&js_string(&or_value(get(row, name), string(""))))
}
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.min(max).max(min)
    } else {
        min
    }
}
fn first_timestamp(row: &Json, names: &[&str]) -> f64 {
    names
        .iter()
        .map(|name| number(get(row, name)))
        .find(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0)
}

pub(super) fn js_string(value: &Json) -> String {
    match value {
        Json::Null => "null".to_owned(),
        Json::Bool(v) => v.to_string(),
        Json::Number(raw) => number_text(raw.parse().unwrap_or(f64::NAN)),
        Json::String(v) => v.to_utf8_lossy(),
        Json::Object(_) => "[object Object]".to_owned(),
        Json::Array(items) => items
            .iter()
            .map(|v| {
                if *v == Json::Null {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn string(value: &str) -> Json {
    Json::String(JsString::from(value))
}
fn object(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(key, value)| (JsString::from(*key), value.clone()))
            .collect(),
    )
}
fn set(row: &mut Json, name: &str, value: Json) {
    let Json::Object(fields) = row else {
        return;
    };
    if let Some((_, old)) = fields
        .iter_mut()
        .find(|(key, _)| key == &JsString::from(name))
    {
        *old = value;
    } else {
        fields.push((JsString::from(name), value));
    }
}
fn assign(row: &mut Json, patch: &Json) {
    if let Json::Object(fields) = patch {
        for (name, value) in fields {
            set(row, &name.to_utf8_lossy(), value.clone());
        }
    }
}

/// Canonical Node JSON number; non-finite values stringify to null.
#[must_use]
pub fn json_number(value: f64) -> Json {
    if value.is_finite() {
        Json::Number(number_text(value))
    } else {
        Json::Null
    }
}

fn number_text(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}
