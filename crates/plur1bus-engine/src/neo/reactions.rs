//! Exact C4 reaction precedence and behavior projections, with explicit extraction time.
use super::{
    derived::Turn,
    derived_fields::*,
    turns::{normalize_statement, stable_id, Role},
};
use crate::{
    capture::dynamics::json_number,
    contract::EngineError,
    text::{
        js::{js_to_lower_case, JsString},
        json::TolerantJsonValue as Json,
    },
};
use regress::Regex;
use std::sync::OnceLock;

const EVIDENCE_UNITS: usize = 1000;

struct Reaction {
    target: &'static str,
    polarity: f64,
    intensity: f64,
    confidence: f64,
    explicitness: &'static str,
    pattern: Regex,
}
struct Patterns {
    reactions: Vec<Reaction>,
    categories: Vec<(&'static str, Regex)>,
}
fn patterns() -> Result<&'static Patterns, EngineError> {
    static VALUE: OnceLock<Result<Patterns, ()>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            let compile = |s: &str| Regex::new(s).map_err(|_| ());
            let mut reactions = vec![];
            for (target, polarity, intensity, confidence, explicitness, pattern) in [
                (
                    "behavior",
                    -1.,
                    0.9,
                    0.85,
                    "explicit_correction",
                    r"\b(no|nein|wrong|falsch|nicht so|korrig|correction|aber)\b",
                ),
                (
                    "architecture_decision",
                    1.,
                    0.65,
                    0.75,
                    "explicit_praise",
                    r"\b(ja|yes|genau|richtig|passt|confirmed|stimmt)\b",
                ),
                (
                    "behavior",
                    1.,
                    0.85,
                    0.8,
                    "explicit_instruction",
                    r"\b(mach|do it|immer|always|niemals|never|soll|muss|must)\b",
                ),
                (
                    "open_question",
                    0.,
                    0.7,
                    0.65,
                    "ambiguous",
                    r"\b(fehl|missing|gap|was ist mit|what about)\b",
                ),
            ] {
                reactions.push(Reaction {
                    target,
                    polarity,
                    intensity,
                    confidence,
                    explicitness,
                    pattern: compile(pattern)?,
                });
            }
            let categories = [
                (
                    "communication_style",
                    "style|ton|kurz|ausführlich|direct|direkt",
                ),
                (
                    "tooling_constraints",
                    "cron|shell|systemctl|execstartpre|patch|hook|tool",
                ),
                (
                    "memory_policy",
                    "memory|recall|capture|workspace|scope|leak",
                ),
                (
                    "architecture_constraints",
                    "architecture|architektur|slot|augment|core",
                ),
            ]
            .into_iter()
            .map(|(name, pattern)| Ok((name, compile(pattern)?)))
            .collect::<Result<Vec<_>, ()>>()?;
            Ok(Patterns {
                reactions,
                categories,
            })
        })
        .as_ref()
        .map_err(|()| EngineError::NotAvailable {
            reason: "neo-reaction-pattern-initialization".into(),
        })
}
fn lower(text: &JsString) -> JsString {
    // Replacing lone surrogates in this classification view cannot create a keyword or word boundary.
    // Evidence, statements and identities always retain the original UTF-16 units.
    JsString::from(js_to_lower_case(&text.to_utf8_lossy()).as_str())
}
fn matches(pattern: &Regex, text: &JsString) -> bool {
    pattern
        .find_from_ucs2(text.as_utf16_units(), 0)
        .next()
        .is_some()
}
pub(super) fn derive(
    turn: &Turn<'_>,
    extracted_at: &JsString,
) -> Result<Option<(Json, Option<Json>)>, EngineError> {
    if turn.role != Role::User {
        return Ok(None);
    }
    let p = patterns()?;
    let lowered = lower(turn.content);
    let Some(reaction) = p.reactions.iter().find(|r| matches(&r.pattern, &lowered)) else {
        return Ok(None);
    };
    let id = stable_id(
        "react",
        vec![
            string(turn.id),
            text(reaction.target),
            turn.replies.clone(),
            json_number(reaction.polarity),
            json_number(reaction.intensity),
            text(reaction.explicitness),
            string(&normalize_statement(turn.content)),
        ],
    );
    let evidence = slice(turn.content, EVIDENCE_UNITS);
    let signal = object(vec![
        ("id", string(&id)),
        ("workspaceKey", string(turn.workspace)),
        ("agentId", string(turn.agent)),
        ("sessionId", string(turn.session)),
        ("turnId", string(turn.id)),
        ("targetType", text(reaction.target)),
        ("targetIds", turn.replies.clone()),
        ("polarity", json_number(reaction.polarity)),
        ("intensity", json_number(reaction.intensity)),
        ("confidence", json_number(reaction.confidence)),
        ("explicitness", text(reaction.explicitness)),
        ("evidence", string(&evidence)),
        ("extractedAt", string(extracted_at)),
    ]);
    let behavior = if reaction.explicitness == "ambiguous" {
        None
    } else {
        Some(behavior(turn, &id, &evidence, reaction, extracted_at, p))
    };
    Ok(Some((signal, behavior)))
}
fn behavior(
    turn: &Turn<'_>,
    signal_id: &JsString,
    evidence: &JsString,
    reaction: &Reaction,
    extracted_at: &JsString,
    patterns: &Patterns,
) -> Json {
    let lowered = lower(evidence);
    let category = patterns
        .categories
        .iter()
        .find(|(_, p)| matches(p, &lowered))
        .map_or("workflow_preference", |(name, _)| *name);
    let statement = slice(&normalize_statement(evidence), EVIDENCE_UNITS);
    let id = stable_id(
        "behavior",
        vec![string(signal_id), text(category), string(&statement)],
    );
    let status = if reaction.polarity < 0. {
        "conflict"
    } else if matches!(
        reaction.explicitness,
        "explicit_correction" | "explicit_instruction"
    ) {
        "active"
    } else {
        "candidate"
    };
    let mut fields = vec![
        ("id", string(&id)),
        ("workspaceKey", string(turn.workspace)),
        ("agentId", string(turn.agent)),
        ("category", text(category)),
        ("statement", string(&statement)),
        ("status", text(status)),
        ("confidence", json_number(reaction.confidence)),
        ("salience", json_number(reaction.intensity)),
        ("sourceSignals", Json::Array(vec![string(signal_id)])),
    ];
    if reaction.polarity > 0. {
        fields.push(("lastConfirmedAt", string(extracted_at)));
    }
    if reaction.polarity < 0. {
        fields.push(("lastContradictedAt", string(extracted_at)));
    }
    fields.extend([
        ("embeddingStatus", text("pending")),
        ("createdAt", string(extracted_at)),
    ]);
    object(fields)
}
