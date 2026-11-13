//! S2b source binding for a deferred Light Dream.
use super::{
    acl,
    capture_journal::CaptureJournal,
    derived_fields::text,
    journal_io,
    merged_order::{date, field},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, JobName, StoreError},
    jobs::authority::JobAuthority,
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const TURNS: &str = "turn-journal.jsonl";
const DREAMS: &str = "dream-diary.jsonl";
const MAX_TURNS: usize = 20;
const MAX_AGE_MS: f64 = 86_400_000.;

pub(crate) struct LightSource {
    pub(crate) key: String,
    pub(crate) turns: Vec<(&'static str, JsString)>,
    pub(crate) visibility: acl::Visibility,
    at_ms: i64,
}

pub(crate) fn light(
    journal: &CaptureJournal,
    authority: &JobAuthority,
    now: i64,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<Option<LightSource>, EngineError> {
    if authority.job() != JobName::LightDream {
        return Err(crate::jobs::authority::unbound());
    }
    let (principal, agent) = authority.caller();
    let ctx = authority.request();
    journal.with_operation_reader(principal, agent, ctx, cancel, check, |dir, _| {
        select(dir, ctx, now, cancel)
    })
}

pub(crate) fn with_light_result<T>(
    journal: &CaptureJournal,
    authority: &JobAuthority,
    source: &LightSource,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
    record: Option<&serde_json::Value>,
    publish: impl FnOnce(&serde_json::Value) -> Result<T, EngineError>,
) -> Result<Option<T>, EngineError> {
    if authority.job() != JobName::LightDream {
        return Err(crate::jobs::authority::unbound());
    }
    let (principal, agent) = authority.caller();
    let ctx = authority.request();
    journal.with_operation_reader(principal, agent, ctx, cancel, check, |dir, check| {
        if select(dir, ctx, source.at_ms, cancel)?.is_none_or(|current| current.key != source.key) {
            return Err(StoreError::Unavailable.into());
        }
        let bytes = journal_io::bytes(dir, DREAMS, cancel)?.unwrap_or_default();
        let mut prior = None;
        for row in journal_io::parse_rows(&bytes, cancel)? {
            if field(&row, "id") == Some(&text(&source.key)) {
                if prior.is_some() || !private(&row, ctx) {
                    return Err(StoreError::Corrupt.into());
                }
                prior =
                    Some(serde_json::from_str(&write_json(&row)).map_err(|_| StoreError::Corrupt)?);
            }
        }
        check()?;
        if let Some(prior) = prior {
            dir.sync_file_durable(DREAMS)?;
            return publish(&prior).map(Some);
        }
        let Some(record) = record else {
            return Ok(None);
        };
        let record_json = parse_json(&record.to_string()).map_err(|_| StoreError::Corrupt)?;
        if !private(&record_json, ctx) || field(&record_json, "id") != Some(&text(&source.key)) {
            return Err(StoreError::InvalidInput.into());
        }
        let committed = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        if committed < bytes.len() {
            check()?;
            dir.truncate_jsonl_tail(DREAMS, bytes.len() as u64, committed as u64)?;
        }
        dir.append_jsonl_durable(DREAMS, &record_json, 32 * 1024)?;
        check()?;
        publish(record).map(Some)
    })
}

fn select(
    dir: &TrustedDirectory,
    ctx: &RequestContext,
    now: i64,
    cancel: &Cancel,
) -> Result<Option<LightSource>, EngineError> {
    let mut latest = HashMap::new();
    for (index, row) in journal_io::rows(dir, TURNS, cancel)?
        .into_iter()
        .enumerate()
    {
        cancel.check()?;
        if !private(&row, ctx) {
            continue;
        }
        let id = journal_io::id(&row)?;
        let timestamp = super::merged_order::time(&row, true);
        match latest.entry(id) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert((index, timestamp, row));
            }
            std::collections::hash_map::Entry::Occupied(mut entry)
                if (timestamp, index) >= (entry.get().1, entry.get().0) =>
            {
                entry.insert((index, timestamp, row));
            }
            std::collections::hash_map::Entry::Occupied(_) => {}
        }
    }
    let mut visible: Vec<_> = latest
        .into_values()
        .filter_map(|(index, _, row)| {
            if field(&row, "quality").and_then(|v| field(v, "promptInjectionSuspected"))
                == Some(&Json::Bool(true))
                || field(&row, "visibility").and_then(|v| field(v, "recallable"))
                    == Some(&Json::Bool(false))
            {
                return None;
            }
            let created = date(field(&row, "createdAt")?);
            if !created.is_finite() || created > now as f64 || created < now as f64 - MAX_AGE_MS {
                return None;
            }
            let role = match field(&row, "role")? {
                value if value == &text("user") => "user",
                value if value == &text("assistant") => "assistant",
                _ => return None,
            };
            let Json::String(session) = field(&row, "sessionId")? else {
                return None;
            };
            let Json::String(content) = field(&row, "content")? else {
                return None;
            };
            if session.is_empty() || content.is_empty() {
                return None;
            }
            Some((created, index, session.clone(), role, content.clone(), row))
        })
        .collect();
    visible.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let Some((_, _, session, _, _, _)) = visible.last() else {
        return Ok(None);
    };
    let mut chosen: Vec<_> = visible
        .iter()
        .rev()
        .filter(|row| &row.2 == session)
        .take(MAX_TURNS)
        .collect();
    chosen.reverse();
    if !chosen.iter().any(|row| row.3 == "user") {
        return Ok(None);
    }
    let mut digest = Sha256::new();
    for part in [
        ctx.agent_id.as_str(),
        &ctx.owner_user_id,
        &ctx.workspace_key,
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    let mut turns = Vec::new();
    for (_, _, _, role, content, row) in chosen {
        cancel.check()?;
        let bytes = write_json(row);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes.as_bytes());
        turns.push((*role, content.utf16_slice(0, 300)));
    }
    Ok(Some(LightSource {
        key: format!("light-{:x}", digest.finalize()),
        turns,
        at_ms: now,
        visibility: acl::Visibility {
            scope: "agent_private".into(),
            agent_id: ctx.agent_id.to_string(),
            workspace_identity: ctx.workspace_key.clone(),
            owner_user_id: ctx.owner_user_id.clone(),
        },
    }))
}

fn private(row: &Json, ctx: &RequestContext) -> bool {
    journal_io::owned(row, ctx)
        && field(row, "scope") == Some(&text("agent_private"))
        && acl::bindings(row, ctx).is_ok_and(|binding| binding.scope == "agent_private")
}
