//! Capture projections narrowed by authenticated ownership before durable planning.
use super::{
    derived,
    derived_fields::{object, set, text},
    journal_io::{self, FILES},
    merged_order::field,
    turn_batch::{self, BatchOptions},
    turns::{self, TurnBuilder},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError, TurnRecord},
    store::directory::TrustedDirectory,
    text::{js::JsString, json::TolerantJsonValue as Json},
};

pub(super) fn stamp(row: &mut Json, ctx: &RequestContext) -> Result<(), StoreError> {
    let authority = [
        ("agentId", ctx.agent_id.as_str()),
        ("ownerUserId", &ctx.owner_user_id),
        ("workspaceIdentity", &ctx.workspace_key),
        ("scope", "agent_private"),
    ];
    for (key, value) in authority {
        set(row, key, text(value))?;
    }
    set(row, "workspaceKey", text(&ctx.workspace_key))?;
    for name in ["visibility", "origin"] {
        let mut nested = field(row, name).cloned().unwrap_or_else(|| object(vec![]));
        for (key, value) in authority {
            set(&mut nested, key, text(value))?;
        }
        set(row, name, nested)?;
    }
    Ok(())
}
fn new_rows(
    input: Vec<Json>,
    existing: &[Json],
    ctx: &RequestContext,
    content_dedupe: bool,
    history_len: usize,
    dedupe_tail: usize,
) -> Result<Vec<Json>, StoreError> {
    let mut identities = std::collections::HashMap::new();
    let mut content = std::collections::HashSet::new();
    for (index, row) in existing.iter().enumerate() {
        let owned = journal_io::owned(row, ctx);
        identities
            .entry(journal_io::id(row)?)
            .and_modify(|v| *v &= owned)
            .or_insert(owned);
        if owned
            && content_dedupe
            && (index < history_len || index >= existing.len().saturating_sub(dedupe_tail))
        {
            if let Some(Json::String(value)) = field(row, "normalizedStatement") {
                content.insert(value.clone());
            }
        }
    }
    let mut accepted = Vec::new();
    for mut row in input {
        stamp(&mut row, ctx)?;
        let id = journal_io::id(&row)?;
        if let Some(owned) = identities.get(&id) {
            if !owned {
                return Err(StoreError::InvalidInput);
            }
            continue;
        }
        if content_dedupe {
            if let Some(Json::String(value)) = field(&row, "normalizedStatement") {
                if !content.insert(value.clone()) {
                    continue;
                }
            }
        }
        identities.insert(id, true);
        accepted.push(row);
    }
    Ok(accepted)
}

pub(super) fn build(
    turn: &TurnRecord,
    metadata: Option<&[turn_batch::MessageMetadata]>,
    ctx: &RequestContext,
    dir: &TrustedDirectory,
    time: &JsString,
    policy: &super::store_policy::StorePolicy,
    cancel: &Cancel,
) -> Result<Vec<Vec<Json>>, EngineError> {
    let workspace = JsString::from(ctx.workspace_key.as_str());
    let agent = JsString::from(ctx.agent_id.as_str());
    let session = JsString::from(turn.session_key.as_deref().unwrap_or(""));
    let run = JsString::from(
        turn.session_key
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(turn.run_id.as_deref())
            .unwrap_or(""),
    );
    let turns = turn_batch::from_host_messages_since(
        &TurnBuilder::new()?,
        &turn.messages,
        metadata,
        &BatchOptions {
            workspace_key: &workspace,
            agent_id: &agent,
            session_key: &session,
            session_id: &run,
            start_turn_index: 0.,
            created_at: time,
        },
        0,
        cancel,
    )?;
    let derived = derived::from_turns(&turns, time, cancel)?;
    let history = super::append_history::read(dir, cancel)?;
    let mut groups = Vec::new();
    for (index, input) in [
        turns,
        derived.candidates,
        derived.reactions,
        derived.behavior,
    ]
    .into_iter()
    .enumerate()
    {
        cancel.check()?;
        let mut existing = history[index].clone();
        existing.extend(journal_io::rows(dir, FILES[index], cancel)?);
        groups.push(new_rows(
            input,
            &existing,
            ctx,
            index == 1,
            history[index].len(),
            policy.dedupe_tail_records,
        )?);
    }
    let mut queue = Vec::new();
    for (index, kind) in [(0, "turn"), (1, "memory"), (3, "behavior")] {
        for row in &groups[index] {
            let target = journal_io::id(row)?;
            let impact = ["impact", "risk", "priority"]
                .iter()
                .filter_map(|key| field(row, key))
                .find(|v| super::merged_order::truthy(v))
                .map(super::merged_order::string)
                .unwrap_or_default()
                .to_utf8_lossy()
                .to_lowercase();
            let impact = if matches!(impact.as_str(), "critical" | "high" | "medium" | "low") {
                impact.as_str()
            } else {
                "low"
            };
            let id = turns::stable_id(
                "embq",
                vec![text(kind), Json::String(target.clone()), text(impact)],
            );
            let status = field(row, "embeddingStatus")
                .filter(|v| super::merged_order::truthy(v))
                .cloned()
                .unwrap_or_else(|| text("pending"));
            let mut item = object(vec![
                ("id", Json::String(id)),
                ("targetId", Json::String(target)),
                ("targetType", text(kind)),
                ("workspaceKey", text(&ctx.workspace_key)),
                ("agentId", text(ctx.agent_id.as_str())),
                ("impact", text(impact)),
                ("status", status),
                ("queuedAt", Json::String(time.clone())),
            ]);
            stamp(&mut item, ctx)?;
            queue.push(item);
        }
    }
    let mut existing = history[4].clone();
    existing.extend(journal_io::rows(dir, FILES[4], cancel)?);
    groups.push(new_rows(
        queue,
        &existing,
        ctx,
        false,
        history[4].len(),
        policy.dedupe_tail_records,
    )?);
    Ok(groups)
}
