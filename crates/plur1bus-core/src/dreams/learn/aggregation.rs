//! Scoped evidence extraction and shadow-only learning scores.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

use icu_normalizer::ComposingNormalizerBorrowed;

use super::{array, digest, equals, string, target_hash, Error, Target};
use crate::exposure::scanner::SensitivityScanner;
use crate::js::{is_js_space, js_trim, sort_default};
use crate::logs::writer::iso_time;
use crate::metrics::registry::locale_compare;
use crate::toolcall::json::{parse, Obj, V};

const LIMIT_TEXT: usize = 4000;
const LIMIT_EVIDENCE: usize = 100;
const LIMIT_FINDINGS: usize = 100;
const INVALID: Error = Error::InvalidOutput;

pub(super) fn normalized(text: &str) -> String {
    ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .split(is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn only(value: &V, keys: &[&str]) -> bool {
    value.as_obj().is_some_and(|obj| {
        obj.entries()
            .iter()
            .all(|(k, _)| keys.iter().any(|name| k.is(name)))
    })
}

fn required(value: &V, field: &str) -> Result<String, Error> {
    string(value, field).map_err(|_| INVALID)
}

fn bounded(text: &str, length: usize) -> bool {
    text.encode_utf16().count() <= length
}

fn nonblank(text: &str, length: usize) -> bool {
    !js_trim(text).is_empty() && bounded(text, length)
}

fn record(value: &V) -> Result<Obj, Error> {
    value.as_obj().cloned().ok_or(INVALID)
}

pub(super) fn date(value: &V, field: &str) -> Result<String, Error> {
    let ms = value
        .get(field)
        .and_then(V::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= super::SAFE_INTEGER as f64)
        .ok_or(INVALID)?;
    let iso = iso_time(ms as i64).map_err(|_| INVALID)?;
    Ok(iso[..10].to_owned())
}

fn event_matches(event: &V, id: &str) -> bool {
    event
        .get("seq")
        .and_then(V::as_f64)
        .is_some_and(|n| crate::policy::js_value::number_to_string(n) == id)
}

fn validate_checks(raw: &V) -> Result<(), Error> {
    let items = raw.as_arr().filter(|v| v.len() <= 8).ok_or(INVALID)?;
    for item in items {
        if !only(item, &["path", "contains"]) {
            return Err(INVALID);
        }
        let path = required(item, "path")?;
        let query = required(item, "contains")?;
        if !bounded(&path, 256) || query.is_empty() || !bounded(&query, 1000) {
            return Err(INVALID);
        }
    }
    Ok(())
}

fn evidence(reference: &V, transcript: &V) -> Result<V, Error> {
    if !only(reference, &["source", "id"]) {
        return Err(INVALID);
    }
    let id = required(reference, "id")?;
    let source = required(reference, "source")?;
    let session = transcript.get("session").ok_or(INVALID)?;
    let session_id = required(session, "id")?;
    let (item, timestamp) = match source.as_str() {
        "message" => (
            array(transcript, "messages")?
                .iter()
                .find(|m| equals(m, "id", &id)),
            "createdAt",
        ),
        "event" => (
            array(transcript, "events")?
                .iter()
                .find(|e| event_matches(e, &id)),
            "at",
        ),
        _ => return Err(INVALID),
    };
    let item = item.ok_or(INVALID)?;
    let turn = required(item, "turnId")?;
    if turn.is_empty() || !equals(item, "sessionId", &session_id) {
        return Err(INVALID);
    }
    let trust = if source == "message"
        && equals(item, "role", "user")
        && !session.get("origin").is_some_and(V::truthy)
        && (!equals(session, "kind", "channel")
            || transcript
                .get("personMessageIds")
                .and_then(V::as_arr)
                .is_some_and(|ids| ids.iter().any(|x| x.is_str(&id))))
    {
        "person"
    } else if source == "message" && equals(item, "role", "assistant") {
        "agent"
    } else {
        "untrusted"
    };
    Ok(V::obj([
        ("sessionId", V::s(&session_id)),
        ("turnId", V::s(&turn)),
        ("sourceId", V::s(&id)),
        ("source", V::s(&source)),
        ("trust", V::s(trust)),
        ("day", V::s(&date(item, timestamp)?)),
        ("agentId", V::s(&required(session, "agentId")?)),
        ("owner", V::s(&required(session, "owner")?)),
    ]))
}

fn extraction(input: &V, transcript: &V) -> Result<V, Error> {
    if !only(
        input,
        &[
            "kind",
            "change",
            "text",
            "memoryId",
            "evidence",
            "checks",
            "contentKey",
        ],
    ) {
        return Err(INVALID);
    }
    let kind = required(input, "kind")?;
    let change = required(input, "change")?;
    let text = required(input, "text")?;
    if !matches!(kind.as_str(), "knowledge" | "procedural")
        || !matches!(
            change.as_str(),
            "add" | "correct" | "duplicate" | "stale" | "retire"
        )
        || !nonblank(&text, LIMIT_TEXT)
    {
        return Err(INVALID);
    }
    let mut result = Obj::from_pairs(vec![
        ("kind".into(), V::s(&kind)),
        ("change".into(), V::s(&change)),
        ("text".into(), V::s(js_trim(&text))),
    ]);
    if input.get("contentKey").is_some() {
        let key = required(input, "contentKey")?;
        if !nonblank(&key, 120) || key.chars().any(|c| c <= '\u{1f}') {
            return Err(INVALID);
        }
        result.set("contentKey", V::s(&normalized(&key)));
    } else if change == "add" {
        return Err(INVALID);
    }
    if input.get("memoryId").is_some() {
        let id = required(input, "memoryId")?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        {
            return Err(INVALID);
        }
        result.set("memoryId", V::s(&id));
    }
    let refs = array(input, "evidence").map_err(|_| INVALID)?;
    if refs.is_empty() || refs.len() > LIMIT_EVIDENCE {
        return Err(INVALID);
    }
    result.set(
        "evidence",
        V::Arr(
            refs.iter()
                .map(|e| evidence(e, transcript))
                .collect::<Result<_, _>>()?,
        ),
    );
    if let Some(checks) = input.get("checks") {
        validate_checks(checks)?;
        result.set("checks", checks.clone());
    }
    Ok(V::Obj(result))
}

/// Validate model extraction and derive evidence trust from the admitted transcript.
pub fn parse_extraction(raw: &str, transcript: &V) -> Result<Vec<V>, Error> {
    if raw.len() > super::BYTES {
        return Err(INVALID);
    }
    let parsed = parse(raw).ok_or(INVALID)?;
    let rows = parsed.as_arr().filter(|v| v.len() <= 10).ok_or(INVALID)?;
    rows.iter().map(|row| extraction(row, transcript)).collect()
}

pub(super) fn content_key(raw: &V) -> Result<String, Error> {
    let kind = required(raw, "kind")?;
    let change = required(raw, "change")?;
    let id = match string(raw, "memoryId") {
        Ok(memory) if change != "add" && !memory.is_empty() => {
            V::Arr(vec![V::s("memory"), V::s(&memory)])
        }
        _ => {
            let claim = string(raw, "contentKey").map_or_else(|_| required(raw, "text"), Ok)?;
            V::Arr(vec![V::s("claim"), V::s(&normalized(&claim))])
        }
    };
    Ok(V::Arr(vec![V::s(&kind), V::s(&change), id]).stringify())
}

fn ref_key(item: &V) -> Result<String, Error> {
    let key = ["sessionId", "source", "sourceId"]
        .into_iter()
        .map(|name| required(item, name).map(|s| V::s(&s)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(V::Arr(key).stringify())
}

fn compare(a: &str, b: &str) -> Ordering {
    locale_compare(a, b).then_with(|| a.cmp(b))
}

fn unique_by<'a>(
    values: impl IntoIterator<Item = &'a V>,
    key: fn(&V) -> Result<String, Error>,
) -> Result<Vec<V>, Error> {
    let mut unique = BTreeMap::new();
    for item in values {
        unique.insert(key(item)?, item);
    }
    let mut rows: Vec<_> = unique.into_iter().collect();
    rows.sort_by(|a, b| compare(&a.0, &b.0));
    Ok(rows.into_iter().map(|(_, item)| item.clone()).collect())
}

fn distinct(values: &[V], key: &str) -> Result<usize, Error> {
    Ok(values
        .iter()
        .map(|v| required(v, key))
        .collect::<Result<HashSet<_>, _>>()?
        .len())
}

fn prevalence(items: &[V], total: usize) -> Result<V, Error> {
    Ok(V::obj([
        ("sessions", V::Num(distinct(items, "sessionId")? as f64)),
        ("total", V::Num(total as f64)),
        ("days", V::Num(distinct(items, "day")? as f64)),
        ("agents", V::Num(distinct(items, "agentId")? as f64)),
        ("persons", V::Num(distinct(items, "owner")? as f64)),
    ]))
}

fn check_key(item: &V) -> Result<String, Error> {
    Ok(V::Arr(vec![
        V::s(&required(item, "path")?),
        V::s(&required(item, "contains")?),
    ])
    .stringify())
}

/// Build reproducible, bounded findings from the extracted evidence.
pub fn aggregate(raw: &[V], target: &Target, run: &str, total: usize) -> Result<Vec<V>, Error> {
    if raw.len() > super::SESSIONS * 10 || total > super::SESSIONS {
        return Err(INVALID);
    }
    let mut groups = BTreeMap::<_, Vec<_>>::new();
    for finding in raw {
        groups
            .entry(content_key(finding)?)
            .or_default()
            .push(finding);
    }
    if groups.len() > LIMIT_FINDINGS {
        return Err(INVALID);
    }
    let context = super::target_value(target)?;
    let mut findings = Vec::new();
    for (key, group) in groups {
        let mut entries = group
            .iter()
            .map(|f| required(f, "text").map(|text| (text, *f)))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_by(|a, b| compare(&a.0, &b.0));
        let mut finding = record(entries[0].1)?;
        let parts = group
            .iter()
            .map(|f| array(f, "evidence"))
            .collect::<Result<Vec<_>, _>>()?;
        let refs = unique_by(parts.into_iter().flatten(), ref_key)?;
        let checks = unique_by(
            group
                .iter()
                .filter_map(|f| f.get("checks").and_then(V::as_arr))
                .flatten(),
            check_key,
        )?;
        if !checks.is_empty() {
            finding.set("checks", V::Arr(checks));
        }
        let spread = prevalence(&refs, total)?;
        let sessions = spread.get("sessions").and_then(V::as_f64).ok_or(INVALID)?;
        finding.set("evidence", V::Arr(refs));
        let id = digest(&V::Arr(vec![V::s(&target_hash(target)), V::s(&key)]));
        let procedure = finding.get("kind").is_some_and(|x| x.is_str("procedural"));
        for (field, value) in [
            ("id", V::s(&id)),
            ("runId", V::s(run)),
            ("target", context.clone()),
            ("revision", V::Num(1.0)),
            ("prevalence", spread),
            (
                "verify",
                V::s(if target.scope == "project" {
                    "unknown"
                } else {
                    "not-applicable"
                }),
            ),
            ("agreement", V::s("unknown")),
            ("score", V::Num(0.0)),
            ("desiredTier", V::s("C")),
            ("effectiveTier", V::s("C")),
            ("skeptic", V::s("not-required")),
            ("models", V::Arr(Vec::new())),
            ("promptVersion", V::s(super::store::PROMPT_VERSION)),
            (
                "status",
                V::s(if procedure { "waiting-h3" } else { "pending" }),
            ),
        ] {
            finding.set(field, value);
        }
        findings.push((sessions, id, V::Obj(finding)));
    }
    findings.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| compare(&a.1, &b.1)));
    Ok(findings.into_iter().map(|(_, _, value)| value).collect())
}

/// Proposed claim vocabulary, stable by normalized claim key.
pub fn vocabulary(raw: &[V]) -> Result<Vec<V>, Error> {
    let mut choices = Vec::new();
    for item in raw.iter().filter(|f| equals(f, "change", "add")) {
        let text = required(item, "text")?;
        let key = normalized(&string(item, "contentKey").unwrap_or_else(|_| text.clone()));
        choices.push((key, text));
    }
    choices.sort_by(|a, b| compare(&a.1, &b.1));
    let mut items: Vec<_> = choices
        .into_iter()
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .collect();
    items.sort_by(|a, b| compare(&a.0, &b.0));
    Ok(items
        .into_iter()
        .map(|(key, text)| V::obj([("key", V::s(&key)), ("text", V::s(&text))]))
        .collect())
}

/// Combine refreshed evidence for the same claim.
pub fn merge_evidence(old: &V, next: &V) -> Result<V, Error> {
    let refs = unique_by(
        array(old, "evidence")?
            .iter()
            .chain(array(next, "evidence")?),
        ref_key,
    )?;
    let total = |v: &V| {
        v.get("prevalence")
            .and_then(|p| p.get("total"))
            .and_then(V::as_f64)
            .unwrap_or(0.0)
    };
    let total = (total(old).max(total(next)) as usize).max(distinct(&refs, "sessionId")?);
    let mut merged = record(next)?;
    merged.set("prevalence", prevalence(&refs, total)?);
    if let Some(V::Obj(mut pattern)) = next.get("toolPattern").cloned() {
        let mut agents = refs
            .iter()
            .map(|r| required(r, "agentId"))
            .collect::<Result<HashSet<_>, _>>()?
            .into_iter()
            .collect::<Vec<_>>();
        sort_default(&mut agents);
        pattern.set("count", V::Num(refs.len() as f64));
        pattern.set("affectedAgents", V::strs(&agents));
        merged.set("toolPattern", V::Obj(pattern));
    }
    merged.set("evidence", V::Arr(refs));
    Ok(V::Obj(merged))
}

/// Trusted facts the score cannot infer from a model reply.
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Safety {
    /// The destination was authored by a person.
    pub person_authored: bool,
    /// The host detected sensitive material.
    pub sensitive: bool,
    /// The destination agrees with the checked claim scope.
    pub target_verified: bool,
}

fn instruction_like(text: &str) -> bool {
    const WORDS: &[&str] = &[
        "always",
        "never",
        "must",
        "ignore",
        "remember",
        "instruction",
        "instructions",
        "system prompt",
        "immer",
        "niemals",
        "nie",
        "musst",
        "muss",
        "ignoriere",
        "speichere",
        "anweisung",
        "anweisungen",
        "merke",
    ];
    let lower = text.replace('ſ', "s").to_lowercase();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    WORDS.iter().any(|needle| {
        lower.match_indices(needle).any(|(at, word_hit)| {
            lower[..at].chars().next_back().is_none_or(|c| !word(c))
                && lower[at + word_hit.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !word(c))
        })
    })
}

/// Grade a finding counterfactually and always retain effective tier C.
pub fn score(raw: &V, safety: Safety) -> Result<V, Error> {
    let text = required(raw, "text")?;
    let change = required(raw, "change")?;
    let p = raw.get("prevalence").ok_or(INVALID)?;
    let count = |key| {
        p.get(key)
            .and_then(V::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or(INVALID)
    };
    let sessions = count("sessions")?;
    let days = count("days")?;
    let spread = count("agents")?.max(count("persons")?);
    let supported = equals(raw, "verify", "supported");
    let agrees = equals(raw, "agreement", "agrees");
    let verified = supported
        && raw.get("checks").and_then(V::as_arr).is_some_and(|checks| {
            checks.iter().any(|c| {
                string(c, "contains").is_ok_and(|needle| {
                    needle.chars().count() >= 16
                        && needle.chars().any(char::is_alphanumeric)
                        && text.contains(&needle)
                })
            })
        });
    let evidence = array(raw, "evidence")?;
    let person = evidence.iter().any(|e| equals(e, "trust", "person"));
    let trusted = verified || person || evidence.iter().any(|e| equals(e, "trust", "verified"));
    let graded_change = matches!(change.as_str(), "add" | "duplicate" | "stale");
    let bonus = |condition| if condition { 0.05 } else { 0.0 };
    let mut points: f64 = if trusted {
        (if person { 0.35 } else { 0.25 })
            + 0.3 * (sessions / 3.0).min(1.0)
            + 0.2 * (days / 2.0).min(1.0)
            + bonus(spread >= 2.0)
            + bonus(supported)
            + bonus(agrees)
            + bonus(graded_change)
    } else {
        0.0
    };
    points = points.min(1.0);
    let contradicted = equals(raw, "verify", "contradicted");
    if (contradicted && change != "stale") || equals(raw, "agreement", "contradicts") {
        points = points.min(0.2);
    }
    points = (points * 1000.0).round() / 1000.0;
    static SCANNER: OnceLock<Option<SensitivityScanner>> = OnceLock::new();
    let sensitive = SCANNER
        .get_or_init(|| SensitivityScanner::new().ok())
        .as_ref()
        .is_none_or(|scanner| !scanner.scan(&text, None).is_empty());
    let manual = !safety.target_verified
        || safety.person_authored
        || safety.sensitive
        || sensitive
        || instruction_like(&text)
        || equals(raw, "kind", "procedural")
        || change == "retire"
        || (change == "duplicate" && !agrees)
        || (change == "stale" && !contradicted);
    let target = raw.get("target").ok_or(INVALID)?;
    let desired = if manual || !trusted {
        "C"
    } else if equals(target, "scope", "agent")
        && graded_change
        && points >= 0.8
        && sessions >= 3.0
        && days >= 2.0
    {
        "A"
    } else if equals(target, "scope", "project") && points >= 0.9 && spread >= 2.0 {
        "B"
    } else {
        "C"
    };
    let mut finding = record(raw)?;
    finding.set("score", V::Num(points));
    finding.set("desiredTier", V::s(desired));
    finding.set("effectiveTier", V::s("C"));
    Ok(V::Obj(finding))
}

/// Compute calibration precision without permitting automated application.
pub fn precision_gate(accepted: u64, decided: u64) -> V {
    let precision = (decided != 0).then(|| accepted as f64 / decided as f64);
    let reason = if decided < 50 {
        "shadow-incomplete"
    } else if precision.is_some_and(|p| p < 0.95) {
        "precision-below-gate"
    } else {
        "revert-unavailable"
    };
    V::obj([
        ("accepted", V::Num(accepted as f64)),
        ("decided", V::Num(decided as f64)),
        ("precision", precision.map_or(V::Null, V::Num)),
        ("allowed", V::Bool(false)),
        ("reason", V::s(reason)),
    ])
}

#[cfg(test)]
#[path = "aggregation_vectors.rs"]
mod vectors;
