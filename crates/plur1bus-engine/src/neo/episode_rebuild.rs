//! The maintenance rebuild uses the same scoped turns and workspace lease as capture.
use super::super::{
    append_cap_io,
    append_source::SourceProof,
    capture_plan,
    derived_fields::{set, text},
    episode_io, episode_plan, episodes, journal_io,
    merged_order::{field, time},
    participant_names,
};
use crate::{
    capture::dynamics::json_number,
    context::RequestContext,
    contract::{Cancel, EngineError, JobName, LlmPort, StoreError},
    jobs::authority::JobAuthority,
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const EPISODES: &str = "episodes.jsonl";
const EPISODE_LIMIT: usize = 2000;
const TURN_LIMIT: usize = 5000;
const DAY_MS: i64 = 86_400_000;

impl super::EpisodeStore {
    /// Rebuild recent episodes in the exact private workspace that supplied the original turns.
    pub(crate) fn rebuild_for_job(
        &self,
        authority: &JobAuthority,
        now: i64,
        narrative: Option<&dyn LlmPort>,
        cancel: &Cancel,
    ) -> Result<usize, EngineError> {
        if authority.job() != JobName::EpisodesRebuild {
            return Err(crate::jobs::authority::unbound());
        }
        let (principal, agent) = authority.caller();
        let ctx = authority.request();
        self.journal.with_operation_cleanup(
            principal,
            agent,
            ctx,
            cancel,
            &|| Ok(()),
            |dir, check| {
                let Some((proof, before)) = SourceProof::read(dir, EPISODES, cancel)? else {
                    return Ok(0);
                };
                if !before.is_empty() && !before.ends_with(b"\n") {
                    return Err(StoreError::Corrupt.into());
                }
                let rows = journal_io::parse_rows(&before, cancel)?;
                let current = latest(&rows, ctx, true, cancel)?;
                if current.is_empty() {
                    return Ok(0);
                }
                let Some((turn_proof, turn_bytes)) =
                    SourceProof::read(dir, "turn-journal.jsonl", cancel)?
                else {
                    return Ok(0);
                };
                let turns = journal_io::parse_rows(&turn_bytes, cancel)?;
                let mut selected = latest(&turns, ctx, false, cancel)?;
                selected.truncate(TURN_LIMIT);
                let by_id = selected
                    .iter()
                    .copied()
                    .map(|row| Ok((journal_io::id(row)?, row)))
                    .collect::<Result<HashMap<_, _>, StoreError>>()?;
                let path = self
                    .host
                    .workspace_dir(&ctx.agent_id)?
                    .ok_or(StoreError::InvalidInput)?;
                let workspace = TrustedDirectory::open(Path::new(&path))?;
                check()?;
                let names = participant_names::resolve(&workspace, ctx.agent_id.as_str(), cancel)?;
                let now_iso = chrono::DateTime::from_timestamp_millis(now)
                    .ok_or(StoreError::InvalidInput)?
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let rebuild = Rebuild {
                    names: &names,
                    now_iso: &now_iso,
                    now,
                    ctx,
                    narrative,
                };
                let mut next = before.clone();
                let mut count = 0;
                for old in current.into_iter().take(EPISODE_LIMIT) {
                    cancel.check()?;
                    if created(old).is_none_or(|created| created < now.saturating_sub(DAY_MS)) {
                        continue;
                    }
                    let sources = episode_turns(old, &selected, &by_id);
                    check()?;
                    let Some(row) = rebuild.row(old, sources, cancel)? else {
                        continue;
                    };
                    let encoded = write_json(&row);
                    if next.len().saturating_add(encoded.len() + 1) > journal_io::MAX_BYTES
                        || rows.len() + count >= journal_io::MAX_ROWS
                    {
                        return Err(StoreError::Unavailable.into());
                    }
                    next.extend_from_slice(encoded.as_bytes());
                    next.push(b'\n');
                    count += 1;
                }
                if count > 0 {
                    let verify = || -> Result<(), EngineError> {
                        check()?;
                        workspace.assert_unchanged()?;
                        turn_proof.verify(dir, "turn-journal.jsonl", &turn_bytes)?;
                        if journal_io::bytes(dir, "turn-journal.jsonl", cancel)?.as_deref()
                            != Some(turn_bytes.as_slice())
                        {
                            return Err(StoreError::Unavailable.into());
                        }
                        check()
                    };
                    proof.verify(dir, EPISODES, &before)?;
                    append_cap_io::replace_live(
                        dir,
                        EPISODES,
                        proof.identity,
                        &before,
                        &next,
                        cancel,
                        &verify,
                    )?;
                }
                Ok(count)
            },
        )
    }
}

fn private(row: &Json, ctx: &RequestContext) -> bool {
    journal_io::owned(row, ctx) && field(row, "scope") == Some(&text("agent_private"))
}

fn live(row: &Json) -> bool {
    field(row, "deleted") != Some(&Json::Bool(true))
        && !["pruned", "tombstoned", "deleted"]
            .iter()
            .any(|status| field(row, "status") == Some(&text(status)))
}

fn latest<'a>(
    rows: &'a [Json],
    ctx: &RequestContext,
    revisions: bool,
    cancel: &Cancel,
) -> Result<Vec<&'a Json>, EngineError> {
    let mut private_rows = HashMap::new();
    let mut foreign_ids = HashSet::new();
    for (position, row) in rows.iter().enumerate() {
        cancel.check()?;
        let id = journal_io::id(row)?;
        if !private(row, ctx) {
            foreign_ids.insert(id);
            continue;
        }
        let revision = if revisions {
            episode_io::revision(row)?
        } else {
            0
        };
        let stamp = (revision, time(row, true), position);
        let slot = private_rows.entry(id).or_insert((stamp, row));
        if stamp > slot.0 {
            *slot = (stamp, row);
        }
    }
    let mut selected: Vec<_> = private_rows
        .into_iter()
        .filter_map(|(id, (stamp, row))| {
            (!foreign_ids.contains(&id) && live(row)).then_some((stamp.1, stamp.2, row))
        })
        .collect();
    selected.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    Ok(selected.into_iter().map(|(_, _, row)| row).collect())
}

fn timestamp(row: &Json, key: &str) -> Option<i64> {
    field(row, key).and_then(|value| episodes::time(value).ok())
}

fn created(row: &Json) -> Option<i64> {
    timestamp(row, "createdAt").or_else(|| timestamp(row, "startTime"))
}

fn episode_turns<'a>(
    old: &Json,
    turns: &[&'a Json],
    by_id: &HashMap<JsString, &'a Json>,
) -> Vec<&'a Json> {
    let mut rows = Vec::new();
    if let Some(Json::Array(ids)) = field(old, "memoryIds") {
        rows.extend(ids.iter().filter_map(|id| {
            if let Json::String(id) = id {
                by_id.get(id).copied()
            } else {
                None
            }
        }));
    }
    if rows.is_empty() {
        if let (Some(start), Some(end)) = (timestamp(old, "startTime"), timestamp(old, "endTime")) {
            let from = start.saturating_sub(2000);
            let to = end.saturating_add(2000);
            if from < to {
                rows.extend(turns.iter().copied().filter(|row| {
                    matches!(field(row, "role"), Some(role) if role == &text("user") || role == &text("assistant"))
                        && timestamp(row, "createdAt").is_some_and(|at| (from..=to).contains(&at))
                }));
            }
        }
    }
    rows.sort_by_key(|row| timestamp(row, "createdAt").unwrap_or(0));
    rows
}

struct Rebuild<'a> {
    names: &'a participant_names::ParticipantNames,
    now_iso: &'a str,
    now: i64,
    ctx: &'a RequestContext,
    narrative: Option<&'a dyn LlmPort>,
}

impl Rebuild<'_> {
    fn row(
        &self,
        old: &Json,
        sources: Vec<&Json>,
        cancel: &Cancel,
    ) -> Result<Option<Json>, EngineError> {
        let Self {
            names,
            now_iso,
            now,
            ctx,
            narrative,
        } = *self;
        if sources.is_empty() {
            return Ok(None);
        }
        let sources: Vec<_> = sources.into_iter().cloned().collect();
        let fingerprint = episode_plan::fingerprint(&Json::Array(vec![
            text("episode-rebuild-v1"),
            Json::Bool(narrative.is_some()),
            Json::String(names.user.clone()),
            Json::String(names.assistant.clone()),
            Json::Array(sources.iter().map(episode_plan::fingerprint).collect()),
        ]));
        if field(old, "nativeRebuildSourceHash") == Some(&fingerprint) {
            return Ok(None);
        }
        let mut row = episodes::create(
            &sources,
            &episodes::BuildOptions {
                id: &journal_io::id(old)?,
                now: &now_iso.into(),
                workspace_key: &ctx.workspace_key.as_str().into(),
                agent_id: &ctx.agent_id.as_str().into(),
                session_key: &JsString::default(),
                participant_names: Some((&names.user, &names.assistant)),
                mood: None,
            },
            cancel,
        )?
        .ok_or(StoreError::InvalidInput)?;
        for key in [
            "createdAt",
            "location",
            "importance",
            "replayCount",
            "lastReplayed",
            "visibility",
        ] {
            if let Some(value) = field(old, key) {
                set(&mut row, key, value.clone())?;
            }
        }
        let revision = episode_io::revision(old)?
            .checked_add(1)
            .filter(|revision| *revision <= 9_007_199_254_740_991)
            .ok_or(StoreError::Corrupt)?;
        set(&mut row, "revision", Json::Number(revision.to_string()))?;
        set(&mut row, "rebuilt", Json::Bool(true))?;
        set(&mut row, "nativeRebuildSourceHash", fingerprint)?;
        if narrative.is_some() && sources.len() >= 2 {
            row = super::super::narrative::enrich(
                &row,
                &sources,
                Some((&names.user, &names.assistant)),
                narrative,
                cancel,
            )?;
        }
        let vividness = episodes::vividness(&row, now)?;
        set(&mut row, "vividness", json_number(vividness))?;
        capture_plan::stamp(&mut row, ctx)?;
        Ok(Some(row))
    }
}
