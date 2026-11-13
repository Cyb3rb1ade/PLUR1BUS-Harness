//! Build checkpoint-coupled episode plans from actual durable source rows.
use super::{
    capture_plan,
    derived_fields::{object, set, text, validate_object},
    episode_state, journal_io,
    merged_order::field,
    postprocessing,
    turn_batch::{self, BatchOptions},
    turns::TurnBuilder,
    watermark,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError, TurnRecord},
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[path = "episode_plan_narrative.rs"]
mod narrative;

pub(super) fn array<'a>(value: &'a Json, name: &str) -> Result<&'a [Json], StoreError> {
    match field(value, name) {
        Some(Json::Array(v)) => Ok(v),
        _ => Err(StoreError::Corrupt),
    }
}
pub(super) fn strings(value: &[Json]) -> Result<Vec<JsString>, StoreError> {
    value
        .iter()
        .map(|v| match v {
            Json::String(s) if !s.is_empty() => Ok(s.clone()),
            _ => Err(StoreError::Corrupt),
        })
        .collect()
}
pub(super) fn fingerprint(value: &Json) -> Json {
    text(&format!(
        "{:x}",
        Sha256::digest(write_json(value).as_bytes())
    ))
}
pub(super) fn sources(
    dir: &TrustedDirectory,
    cancel: &Cancel,
) -> Result<HashMap<JsString, Json>, EngineError> {
    journal_io::latest(journal_io::rows(dir, "turn-journal.jsonl", cancel)?)?
        .into_iter()
        .map(|row| Ok((journal_io::id(&row)?, row)))
        .collect()
}
fn source<'a>(
    rows: &'a HashMap<JsString, Json>,
    id: &JsString,
    ctx: &RequestContext,
) -> Result<&'a Json, StoreError> {
    let row = rows.get(id).ok_or(StoreError::Corrupt)?;
    if !journal_io::owned(row, ctx)
        || field(row, "scope") != Some(&text("agent_private"))
        || ["tombstoned", "pruned", "deleted"]
            .iter()
            .any(|s| field(row, "status") == Some(&text(s)))
        || field(row, "deleted") == Some(&Json::Bool(true))
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(row)
}
pub(super) fn verify_sources(
    plan: &Json,
    dir: &TrustedDirectory,
    ctx: &RequestContext,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let rows = sources(dir, cancel)?;
    for expected in array(plan, "sources")? {
        validate_object(expected)?;
        let id = journal_io::id(expected)?;
        if field(expected, "digest") != Some(&fingerprint(source(&rows, &id, ctx)?)) {
            return Err(StoreError::InvalidInput.into());
        }
    }
    Ok(())
}
fn entry(state: &Json, key: &JsString) -> Result<Json, StoreError> {
    let Some(map) = field(state, "episodeSessions") else {
        return Ok(object(vec![]));
    };
    validate_object(map)?;
    let Json::Object(entries) = map else {
        return Err(StoreError::Corrupt);
    };
    let value = entries
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| object(vec![]));
    validate_object(&value)?;
    Ok(value)
}
pub(super) struct Build<'a> {
    pub turn: &'a TurnRecord,
    pub metadata: Option<&'a [turn_batch::MessageMetadata]>,
    pub ctx: &'a RequestContext,
    pub dir: &'a TrustedDirectory,
    pub session: &'a JsString,
    pub now: &'a JsString,
    pub mood: &'a Json,
    pub names: &'a dyn Fn() -> Result<super::participant_names::ParticipantNames, EngineError>,
    pub narrative: Option<&'a dyn crate::contract::LlmPort>,
    pub check: &'a dyn Fn() -> Result<(), EngineError>,
}
pub(super) fn build(
    input: &Build<'_>,
    state: &Json,
    cancel: &Cancel,
) -> Result<Option<Json>, EngineError> {
    let Build {
        turn,
        ctx,
        dir,
        session,
        now,
        mood,
        names,
        ..
    } = *input;
    let watermark = watermark::read_session(state, session);
    if watermark.known && watermark.count == turn.messages.len() as f64 {
        return Ok(None);
    }
    let previous = entry(state, &watermark.key)?;
    let known = field(&previous, "episodedTurnIds")
        .map(|_| strings(array(&previous, "episodedTurnIds")?))
        .transpose()?
        .unwrap_or_default();
    let open = field(&previous, "openEpisode").filter(|v| !matches!(v, Json::Null));
    let rows = sources(dir, cancel)?;
    let workspace = JsString::from(ctx.workspace_key.as_str());
    let agent = JsString::from(ctx.agent_id.as_str());
    let raw_session = JsString::from(turn.session_key.as_deref().unwrap_or(""));
    let selected = turn_batch::from_host_messages_since(
        &TurnBuilder::new()?,
        &turn.messages,
        input.metadata,
        &BatchOptions {
            workspace_key: &workspace,
            agent_id: &agent,
            session_key: &raw_session,
            session_id: session,
            start_turn_index: 0.,
            created_at: now,
        },
        watermark.count as usize,
        cancel,
    )?;
    let mut required = Vec::new();
    let mut actual = Vec::new();
    for selected in selected {
        let id = journal_io::id(&selected)?;
        let row = source(&rows, &id, ctx)?;
        required.push(id);
        actual.push(row.clone());
    }
    if let Some(open) = open {
        validate_object(open)?;
        for snapshot in array(open, "turns")? {
            let id = journal_io::id(snapshot)?;
            let row = source(&rows, &id, ctx)?;
            if episode_state::snapshot(row) != *snapshot {
                return Err(StoreError::Corrupt.into());
            }
            required.push(id);
        }
    }
    let names = names()?;
    let extracted = episode_state::extract(
        &actual,
        &episode_state::Options {
            now,
            workspace_key: &workspace,
            agent_id: &agent,
            session_key: session,
            participant_names: Some((&names.user, &names.assistant)),
            mood: Some(mood),
            open_episode: open,
            episoded_turn_ids: &known,
            max_gap_minutes: 30.,
            max_episode_turns: 50,
        },
        &mut || Ok(JsString::from(uuid::Uuid::new_v4().to_string().as_str())),
        cancel,
    )?;
    let mut episodes = array(&extracted, "episodes")?.to_vec();
    let ids = episodes
        .iter()
        .map(|row| strings(array(row, "memoryIds")?))
        .collect::<Result<Vec<_>, _>>()?;
    let selection = postprocessing::filter_already_episoded(&ids, &known);
    let ids: Vec<_> = selection.indices.iter().map(|i| ids[*i].clone()).collect();
    episodes = selection
        .indices
        .iter()
        .map(|i| episodes[*i].clone())
        .collect();
    narrative::enrich(input, &mut episodes, open, &rows, &names, cancel)?;
    for episode in &mut episodes {
        capture_plan::stamp(episode, ctx)?;
    }
    let existing = journal_io::rows(dir, "episodes.jsonl", cancel)?;
    let mut predecessors = Vec::new();
    for episode in &episodes {
        let rev = super::episode_io::revision(episode)?;
        if rev == 0 {
            continue;
        }
        let id = journal_io::id(episode)?;
        let old = existing
            .iter()
            .rev()
            .find(|row| journal_io::id(row).ok().as_ref() == Some(&id))
            .ok_or(StoreError::Corrupt)?;
        if !journal_io::owned(old, ctx) || super::episode_io::revision(old)? != rev - 1 {
            return Err(StoreError::Corrupt.into());
        }
        predecessors.push(object(vec![
            ("id", Json::String(id)),
            ("digest", fingerprint(old)),
            ("revision", Json::Number((rev - 1).to_string())),
        ]));
    }
    let known = postprocessing::merge_episoded_ids(&known, &ids, 2000.);
    let next_entry = object(vec![
        (
            "openEpisode",
            field(&extracted, "openEpisode")
                .cloned()
                .ok_or(StoreError::Corrupt)?,
        ),
        (
            "episodedTurnIds",
            Json::Array(known.into_iter().map(Json::String).collect()),
        ),
    ]);
    let patch = watermark::plan_advance(
        state,
        session,
        &Json::Number(watermark.count.to_string()),
        &Json::Number(turn.messages.len().to_string()),
        now,
    )?
    .ok_or(StoreError::Corrupt)?;
    let mut next = state.clone();
    let Json::Object(patch) = patch else {
        return Err(StoreError::Corrupt.into());
    };
    for (key, value) in patch {
        set(&mut next, &key.to_utf8_lossy(), value)?;
    }
    let retained = match field(&next, "sessionWatermarks") {
        Some(Json::Object(v)) => v,
        _ => return Err(StoreError::Corrupt.into()),
    };
    let mut entries = match field(state, "episodeSessions") {
        Some(Json::Object(v)) => v.clone(),
        _ => vec![],
    };
    entries.retain(|(k, _)| k != &watermark.key && retained.iter().any(|(key, _)| key == k));
    entries.push((watermark.key, next_entry));
    set(&mut next, "episodeSessions", Json::Object(entries))?;
    required.sort_by(|a, b| a.as_utf16_units().cmp(b.as_utf16_units()));
    required.dedup();
    let sources = required
        .into_iter()
        .map(|id| {
            Ok(object(vec![
                ("digest", fingerprint(source(&rows, &id, ctx)?)),
                ("id", Json::String(id)),
            ]))
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(Some(object(vec![
        ("session", Json::String(session.clone())),
        ("previous", state.clone()),
        ("next", next),
        ("sources", Json::Array(sources)),
        ("predecessors", Json::Array(predecessors)),
        ("episodes", Json::Array(episodes)),
    ])))
}

/// Sessions still acknowledge completed capture when optional Neo episodes are disabled or background-only.
pub(super) fn checkpoint_only(
    turn: &TurnRecord,
    state: &Json,
    session: &JsString,
    now: &JsString,
) -> Result<Option<Json>, EngineError> {
    let current = watermark::read_session(state, session);
    if current.known && current.count == turn.messages.len() as f64 {
        return Ok(None);
    }
    let patch = watermark::plan_advance(
        state,
        session,
        &Json::Number(current.count.to_string()),
        &Json::Number(turn.messages.len().to_string()),
        now,
    )?
    .ok_or(StoreError::Corrupt)?;
    let mut next = state.clone();
    let Json::Object(patch) = patch else {
        return Err(StoreError::Corrupt.into());
    };
    for (key, value) in patch {
        set(&mut next, &key.to_utf8_lossy(), value)?;
    }
    if let Some(map) = field(state, "episodeSessions") {
        validate_object(map)?;
        let Json::Object(mut entries) = map.clone() else {
            return Err(StoreError::Corrupt.into());
        };
        let Some(Json::Object(retained)) = field(&next, "sessionWatermarks") else {
            return Err(StoreError::Corrupt.into());
        };
        entries.retain(|(key, _)| retained.iter().any(|(k, _)| k == key));
        set(&mut next, "episodeSessions", Json::Object(entries))?;
    }
    Ok(Some(object(vec![
        ("session", Json::String(session.clone())),
        ("previous", state.clone()),
        ("next", next),
        ("sources", Json::Array(vec![])),
        ("predecessors", Json::Array(vec![])),
        ("episodes", Json::Array(vec![])),
    ])))
}
