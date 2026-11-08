//! C4 open-episode continuation plans without providers, filesystem access or authority grants.
use super::{
    derived_fields::{object, set, validate_object},
    episodes::{self, BuildOptions},
    merged_order::{field, string, truthy},
};
use crate::{
    capture::dynamics::{json_number, number},
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use std::collections::HashSet;

/// Caller-validated state and actual source facts. The writer freezes the returned plan before use.
pub struct Options<'a> {
    /// Explicit host time shared by all newly built episodes.
    pub now: &'a JsString,
    /// Actual workspace storage identity.
    pub workspace_key: &'a JsString,
    /// Actual capturing agent.
    pub agent_id: &'a JsString,
    /// Stable conversation route, used only for descriptive location.
    pub session_key: &'a JsString,
    /// Resolved display labels; absent defaults to Nutzer and the actual agent label.
    pub participant_names: Option<(&'a JsString, &'a JsString)>,
    /// Actual caller-bound mood snapshot.
    pub mood: Option<&'a Json>,
    /// Previously committed open episode, read under its principal-bound state lease.
    pub open_episode: Option<&'a Json>,
    /// Turn identities acknowledged by prior durable episode publication.
    pub episoded_turn_ids: &'a [JsString],
    /// A zero gap retains Node's 30-minute default; negative values remain meaningful.
    pub max_gap_minutes: f64,
    /// Maximum group size, clamped to at least one.
    pub max_episode_turns: usize,
}
fn prop(row: &Json, key: &str) -> Json {
    field(row, key).cloned().unwrap_or(Json::Null)
}
fn time_or_epoch(row: &Json, key: &str) -> Result<i64, StoreError> {
    field(row, key)
        .filter(|v| truthy(v))
        .map_or(Ok(0), episodes::time)
}
fn snapshot(turn: &Json) -> Json {
    let content = field(turn, "content")
        .filter(|v| truthy(v))
        .map(string)
        .unwrap_or_default();
    let mut out = object(vec![]);
    // Preserve undefined omission and ordered fields, including opaque UTF-16 snapshot cuts.
    if let Json::Object(fields) = &mut out {
        for key in ["id", "role"] {
            if let Some(value) = field(turn, key) {
                fields.push((JsString::from(key), value.clone()));
            }
        }
        fields.push((
            JsString::from("content"),
            Json::String(content.utf16_slice(0, 600)),
        ));
        if let Some(value) = field(turn, "createdAt") {
            fields.push((JsString::from("createdAt"), value.clone()));
        }
    }
    out
}

/// Plan the normal capture path. UUIDs are allocated exactly when Node creates an episode,
/// including groups the outer postprocessor will later skip. Allocation failure/cancellation
/// returns no partial plan. No checkpoint or source authorization is implied by this result.
pub fn extract(
    turns: &[Json],
    options: &Options<'_>,
    allocate_id: &mut dyn FnMut() -> Result<JsString, EngineError>,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    cancel.check()?;
    let previous = options
        .open_episode
        .filter(|v| truthy(v))
        .cloned()
        .unwrap_or(Json::Null);
    let fresh: Vec<_> = turns
        .iter()
        .filter(|v| matches!(v, Json::Object(_) | Json::Array(_)))
        .cloned()
        .collect();
    if fresh.is_empty() {
        return Ok(result(vec![], previous, Json::Null, 0));
    }
    if !options.max_gap_minutes.is_finite() {
        return Err(StoreError::InvalidInput.into());
    }
    for turn in &fresh {
        validate_object(turn)?;
    }
    let open = options
        .open_episode
        .filter(|v| matches!(v, Json::Object(_)))
        .filter(|v| matches!(field(v, "turns"), Some(Json::Array(turns)) if !turns.is_empty()));
    if let Some(open) = open {
        validate_object(open)?;
    }
    let old_turns = open
        .and_then(|v| field(v, "turns"))
        .and_then(|v| {
            if let Json::Array(v) = v {
                Some(v.as_slice())
            } else {
                None
            }
        })
        .unwrap_or(&[]);
    for turn in old_turns {
        validate_object(turn)?;
    }
    let first = fresh
        .iter()
        .map(|t| time_or_epoch(t, "createdAt"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .min()
        .ok_or(StoreError::InvalidInput)?;
    let end = open.map(|v| time_or_epoch(v, "endTime")).transpose()?;
    let known: Vec<_> = old_turns.iter().map(|t| field(t, "id")).collect();
    let novel: Vec<_> = fresh
        .iter()
        .filter(|t| !known.contains(&field(t, "id")))
        .cloned()
        .collect();
    let cap = options.max_episode_turns.max(1);
    let gap = if options.max_gap_minutes == 0. {
        30.
    } else {
        options.max_gap_minutes
    } * 60000.;
    let continuing = open.is_some()
        && !novel.is_empty()
        && end.is_some_and(|end| first as f64 - end as f64 <= gap)
        && old_turns.len() < cap;
    let combined = if continuing {
        old_turns.iter().cloned().chain(novel).collect::<Vec<_>>()
    } else {
        fresh
    };
    let groups = episodes::group(&combined, options.max_gap_minutes, cap, cancel)?;
    let user = JsString::from("Nutzer");
    let agent = if options.agent_id.is_empty() {
        JsString::from("agent")
    } else {
        options.agent_id.clone()
    };
    let names = options.participant_names.unwrap_or((&user, &agent));
    let seen: HashSet<_> = options.episoded_turn_ids.iter().collect();
    let now = episodes::time(&Json::String(options.now.clone()))?;
    let mut episodes = Vec::new();
    let mut skipped = 0;
    let mut last_known = false;
    let mut continued = Json::Null;
    for (index, group) in groups.iter().enumerate() {
        cancel.check()?;
        let id = allocate_id()?;
        let build = BuildOptions {
            id: &id,
            now: options.now,
            workspace_key: options.workspace_key,
            agent_id: options.agent_id,
            session_key: options.session_key,
            participant_names: Some(names),
            mood: options.mood,
        };
        let mut episode =
            episodes::create(group, &build, cancel)?.ok_or(StoreError::InvalidInput)?;
        if continuing && index == 0 {
            let open = open.ok_or(StoreError::InvalidInput)?;
            continued = prop(open, "id");
            set(&mut episode, "id", continued.clone())?;
            if let Some(created) = field(open, "createdAt").filter(|v| truthy(v)) {
                set(&mut episode, "createdAt", created.clone())?;
            }
            set(&mut episode, "continued", Json::Bool(true))?;
            let revision = number(field(open, "revision"));
            let revision = if revision.is_nan() || revision == 0. {
                0.
            } else {
                revision
            };
            set(&mut episode, "revision", json_number(revision + 1.))?;
        }
        let already = !seen.is_empty() && !group.is_empty() && group.iter().all(|turn| {
            matches!(field(turn, "id"), Some(Json::String(id)) if !id.is_empty() && seen.contains(id))
        });
        skipped += usize::from(already);
        last_known = index == groups.len() - 1 && already;
        let vividness = episodes::vividness(&episode, now)?;
        set(&mut episode, "vividness", json_number(vividness))?;
        cancel.check()?;
        episodes.push(episode);
    }
    let next = if last_known {
        previous
    } else if let (Some(last), Some(group)) = (episodes.last(), groups.last()) {
        let vault = if field(last, "id") == Some(&continued) {
            open.and_then(|v| field(v, "vaultPath"))
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(Json::Null)
        } else {
            Json::Null
        };
        object(vec![
            ("id", prop(last, "id")),
            ("endTime", prop(last, "endTime")),
            ("createdAt", prop(last, "createdAt")),
            (
                "revision",
                field(last, "revision")
                    .filter(|v| truthy(v))
                    .cloned()
                    .unwrap_or_else(|| json_number(0.)),
            ),
            ("vaultPath", vault),
            (
                "turns",
                Json::Array(
                    group
                        .iter()
                        .skip(group.len().saturating_sub(cap))
                        .map(snapshot)
                        .collect(),
                ),
            ),
        ])
    } else {
        previous
    };
    Ok(result(episodes, next, continued, skipped))
}
fn result(episodes: Vec<Json>, open: Json, continued: Json, skipped: usize) -> Json {
    object(vec![
        ("episodes", Json::Array(episodes)),
        ("openEpisode", open),
        ("continuedId", continued),
        ("skippedEpisodedSpans", json_number(skipped as f64)),
    ])
}
