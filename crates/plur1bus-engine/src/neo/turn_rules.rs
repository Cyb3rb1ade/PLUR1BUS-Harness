//! Exact C4 category/origin precedence. These rules classify text, never establish authority.
use super::turns::Role;
use crate::{
    contract::EngineError,
    text::js::{js_to_lower_case, JsString},
};
use regress::Regex;
use std::sync::OnceLock;
struct Patterns {
    assistant: Vec<(&'static str, Regex)>,
    user: Vec<(&'static str, Regex)>,
    origin: Vec<(&'static str, Regex)>,
    tool_category: Regex,
    tool_origin: Regex,
}
fn unavailable() -> EngineError {
    EngineError::NotAvailable {
        reason: "neo-turn-pattern-initialization".into(),
    }
}
fn patterns() -> Result<&'static Patterns, EngineError> {
    static VALUE: OnceLock<Result<Patterns, ()>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            let compile = |v: &str| Regex::new(v).map_err(|_| ());
            let table = |defs: &[(&'static str, &str)]| {
                defs.iter()
                    .map(|(name, pattern)| Ok((*name, compile(pattern)?)))
                    .collect::<Result<Vec<_>, ()>>()
            };
            Ok(Patterns {
                assistant: table(&[
                    (
                        "assistant_plan",
                        r"\b(plan|i will|ich werde|vorschlag|proposal|sollten wir|we should)\b",
                    ),
                    (
                        "assistant_suggestion",
                        r"\b(maybe|could|könnte|suggest|empfehle|recommend)\b",
                    ),
                ])?,
                user: table(&[
                    (
                        "bug",
                        r"bug|fehler|regression|kaputt|broken|failure|failed|traceback|exception",
                    ),
                    (
                        "open_question",
                        r"todo|to-do|offen|open question|frage|unklar",
                    ),
                    (
                        "architecture_decision",
                        r"decision|entscheid|nehmen wir|gewählt|chosen|architecture|architektur",
                    ),
                    (
                        "technical_constraint",
                        r"must|muss|niemals|never|hard policy|constraint|verboten|allowed|erlaubt",
                    ),
                    (
                        "workspace_rule",
                        r"workspace|scope|isolation|leak|shared|private",
                    ),
                    (
                        "user_preference",
                        r"prefer|bevorzug|mag|style|ton|antwortstil|kurz|ausführlich",
                    ),
                    (
                        "tooling_constraint",
                        r"github|git|docker|cron|systemctl|shell|hook|provider|runner",
                    ),
                    ("external_source", r"https?://"),
                ])?,
                origin: table(&[
                    (
                        "user_correction",
                        r"\b(no|nein|wrong|falsch|nicht so|korrig|correction|aber)\b",
                    ),
                    (
                        "user_confirmation",
                        r"\b(yes|ja|genau|richtig|passt|confirmed|bestätigt)\b",
                    ),
                    (
                        "user_rejection",
                        r"\b(nope|ablehnen|reject|stop|nicht mehr)\b",
                    ),
                ])?,
                tool_category: compile("test|passed|failed|assert|coverage")?,
                tool_origin: compile("test|assert|passed|failed")?,
            })
        })
        .as_ref()
        .map_err(|()| unavailable())
}
fn matches(pattern: &Regex, text: &JsString) -> bool {
    pattern
        .find_from_ucs2(text.as_utf16_units(), 0)
        .next()
        .is_some()
}
fn first(table: &[(&'static str, Regex)], text: &JsString, fallback: &'static str) -> &'static str {
    table
        .iter()
        .find(|(_, pattern)| matches(pattern, text))
        .map_or(fallback, |(name, _)| *name)
}
pub(super) fn classify(
    text: &JsString,
    role: Role,
) -> Result<(&'static str, &'static str), EngineError> {
    let p = patterns()?;
    // Unpaired units are non-word characters in all these patterns. Lossy conversion is
    // used only for this classification view, never for record contents or stable IDs.
    let lower = JsString::from(js_to_lower_case(&text.to_utf8_lossy()).as_str());
    Ok(match role {
        Role::Assistant => {
            let category = first(&p.assistant, &lower, "assistant_claim");
            (category, category)
        }
        Role::Tool => (
            if matches(&p.tool_category, &lower) {
                "test_result"
            } else {
                "tooling_constraint"
            },
            if matches(&p.tool_origin, &lower) {
                "test_result"
            } else {
                "tool_result"
            },
        ),
        Role::User => (
            first(&p.user, &lower, "project_fact"),
            first(&p.origin, &lower, "user_explicit"),
        ),
    })
}
