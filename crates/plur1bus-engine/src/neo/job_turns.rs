//! Bounded, versioned user turns for native jobs with explicit owner authority.
use super::{
    capture_journal::CaptureJournal,
    derived_fields::text,
    dream_sources::private,
    journal_io,
    merged_order::{date, field},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, JobName},
    jobs::authority::JobAuthority,
    store::directory::TrustedDirectory,
    text::{
        js::{js_trim, utf16_slice, JsString},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};

#[derive(PartialEq)]
pub(crate) struct ConversationTurn {
    pub id: JsString,
    pub timestamp: i64,
    pub content: String,
    pub session: JsString,
    pub role: &'static str,
    revision: [u8; 32],
}

pub(crate) fn with_conversation_turns<T>(
    journal: &CaptureJournal,
    authority: &JobAuthority,
    now: i64,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
    action: impl FnOnce(
        Vec<ConversationTurn>,
        &TrustedDirectory,
        &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<T, EngineError>,
) -> Result<T, EngineError> {
    let user_only = match authority.job() {
        JobName::ProactiveCheck => true,
        JobName::FeedbackReport | JobName::PersonaEvolve | JobName::MetaReflect => false,
        _ => return Err(crate::jobs::authority::unbound()),
    };
    let (principal, agent) = authority.caller();
    let ctx = authority.request();
    journal.with_operation_reader(principal, agent, ctx, cancel, check, |dir, check| {
        let rows = journal_io::rows(dir, "turn-journal.jsonl", cancel)?;
        let owned = rows.into_iter().filter(|row| private(row, ctx)).collect();
        let mut turns = Vec::new();
        for (index, row) in journal_io::latest(owned)?.into_iter().enumerate() {
            cancel.check()?;
            let role = match field(&row, "role") {
                Some(role) if role == &text("user") => "user",
                Some(role) if !user_only && role == &text("assistant") => "assistant",
                _ => continue,
            };
            let capture = field(&row, "captureContext");
            if (capture.is_some() || !user_only) && !foreground(capture) {
                continue;
            }
            if field(&row, "quality").and_then(|v| field(v, "promptInjectionSuspected"))
                == Some(&Json::Bool(true))
                || field(&row, "visibility").and_then(|v| field(v, "recallable"))
                    == Some(&Json::Bool(false))
            {
                continue;
            }
            let Some(timestamp) = field(&row, "createdAt").map(date) else {
                continue;
            };
            if !timestamp.is_finite()
                || timestamp > now as f64
                || timestamp < now.saturating_sub(30 * 86_400_000) as f64
            {
                continue;
            }
            let Some(Json::String(content)) = field(&row, "content") else {
                continue;
            };
            let cap = if user_only { 2400 } else { 32_000 };
            let content = utf16_slice(js_trim(&content.to_utf8_lossy()), 0, cap).to_utf8_lossy();
            if content.is_empty() {
                continue;
            }
            let session = match field(&row, "sessionId") {
                Some(Json::String(session)) if !session.is_empty() => session.clone(),
                _ if user_only => JsString::default(),
                _ => continue,
            };
            turns.push((
                index,
                ConversationTurn {
                    id: journal_io::id(&row)?,
                    timestamp: timestamp as i64,
                    content,
                    session,
                    role,
                    revision: Sha256::digest(write_json(&row).as_bytes()).into(),
                },
            ));
        }
        turns.sort_by_key(|(index, turn)| std::cmp::Reverse((turn.timestamp, *index)));
        action(
            turns.into_iter().take(500).map(|(_, turn)| turn).collect(),
            dir,
            check,
        )
    })
}

fn foreground(context: Option<&Json>) -> bool {
    context.is_some_and(|context| {
        field(context, "origin") == Some(&text("user"))
            && field(context, "background") == Some(&Json::Bool(false))
    })
}

pub(crate) fn private_candidates(
    dir: &TrustedDirectory,
    ctx: &RequestContext,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    let mut owned = vec![];
    for row in journal_io::rows(dir, "memory-candidates.jsonl", cancel)? {
        cancel.check()?;
        if private(&row, ctx) {
            owned.push(row);
        }
    }
    let mut latest = journal_io::latest(owned)?;
    latest.sort_by(|a, b| {
        super::merged_order::time(b, true).total_cmp(&super::merged_order::time(a, true))
    });
    latest.truncate(1000);
    Ok(latest)
}
