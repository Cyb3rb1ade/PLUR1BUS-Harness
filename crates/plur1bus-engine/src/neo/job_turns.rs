//! Bounded, versioned user turns for native jobs with explicit owner authority.
use super::{
    capture_journal::CaptureJournal,
    derived_fields::text,
    dream_sources::private,
    journal_io,
    merged_order::{date, field},
};
use crate::{
    contract::{Cancel, EngineError, JobName},
    jobs::authority::JobAuthority,
    text::{
        js::{js_trim, utf16_slice, JsString},
        json::{write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};

#[derive(PartialEq, Eq)]
pub(crate) struct UserTurn {
    pub id: JsString,
    pub timestamp: i64,
    pub content: String,
    revision: [u8; 32],
}

pub(crate) fn with_recent_user_turns<T>(
    journal: &CaptureJournal,
    authority: &JobAuthority,
    now: i64,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
    action: impl FnOnce(Vec<UserTurn>, &dyn Fn() -> Result<(), EngineError>) -> Result<T, EngineError>,
) -> Result<T, EngineError> {
    if authority.job() != JobName::ProactiveCheck {
        return Err(crate::jobs::authority::unbound());
    }
    let (principal, agent) = authority.caller();
    let ctx = authority.request();
    journal.with_operation_reader(principal, agent, ctx, cancel, check, |dir, check| {
        let rows = journal_io::rows(dir, "turn-journal.jsonl", cancel)?;
        let owned = rows.into_iter().filter(|row| private(row, ctx)).collect();
        let mut turns = Vec::new();
        for (index, row) in journal_io::latest(owned)?.into_iter().enumerate() {
            cancel.check()?;
            if field(&row, "role") != Some(&text("user"))
                || field(&row, "quality").and_then(|v| field(v, "promptInjectionSuspected"))
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
            let content = utf16_slice(js_trim(&content.to_utf8_lossy()), 0, 2400).to_utf8_lossy();
            if content.is_empty() {
                continue;
            }
            turns.push((
                index,
                UserTurn {
                    id: journal_io::id(&row)?,
                    timestamp: timestamp as i64,
                    content,
                    revision: Sha256::digest(write_json(&row).as_bytes()).into(),
                },
            ));
        }
        turns.sort_by_key(|(index, turn)| std::cmp::Reverse((turn.timestamp, *index)));
        action(
            turns.into_iter().take(500).map(|(_, turn)| turn).collect(),
            check,
        )
    })
}
