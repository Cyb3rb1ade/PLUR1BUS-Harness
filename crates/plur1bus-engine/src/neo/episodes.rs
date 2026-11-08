//! Deterministic C4 episode construction for captured turns, with caller-owned UUID and clock.
//! No narrative provider or filesystem is accessed. The writer must derive source authority.
use super::{
    derived_fields::{object, text, validate_object},
    episode_emotion, episode_text,
    merged_order::{field, truthy},
};
use crate::{
    capture::dynamics::{json_number, number},
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};

/// Inputs to the ordinary capture episode constructor. Identity/time are supplied before WAL.
pub struct BuildOptions<'a> {
    /// Preselected UUID, retained through retries by the durable caller.
    pub id: &'a JsString,
    /// Explicit ISO fallback and creation time.
    pub now: &'a JsString,
    /// Actual workspace, independently authorized by the writer.
    pub workspace_key: &'a JsString,
    /// Actual capturing agent.
    pub agent_id: &'a JsString,
    /// Session route used only for the descriptive location.
    pub session_key: &'a JsString,
    /// Explicit display labels; absent means Node's Nutzer/agent defaults.
    pub participant_names: Option<(&'a JsString, &'a JsString)>,
    /// Actual caller-bound mood snapshot. Absent uses legacy turn valence.
    pub mood: Option<&'a Json>,
}
fn time(v: &Json) -> Result<i64, StoreError> {
    match v {
        Json::Number(n) => n
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && n.abs() <= 8.64e15)
            .map(|n| n.trunc() as i64)
            .ok_or(StoreError::InvalidInput),
        Json::String(s) => DateTime::parse_from_rfc3339(&s.to_utf8_lossy())
            .map(|t| t.timestamp_millis())
            .map_err(|_| StoreError::InvalidInput),
        Json::Null => Ok(0),
        Json::Bool(v) => Ok(i64::from(*v)),
        _ => Err(StoreError::InvalidInput),
    }
}
fn iso(time: i64) -> Result<String, StoreError> {
    Ok(Utc
        .timestamp_millis_opt(time)
        .single()
        .ok_or(StoreError::InvalidInput)?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
/// Stable chronological grouping. Zero gap uses Node's 30-minute default, and the cap is >= 1.
/// Capture timestamps are ISO or numeric epochs; invalid/nonstandard date strings fail closed.
pub fn group(
    turns: &[Json],
    max_gap_minutes: f64,
    max_turns: usize,
    cancel: &Cancel,
) -> Result<Vec<Vec<Json>>, EngineError> {
    cancel.check()?;
    if !max_gap_minutes.is_finite() {
        return Err(StoreError::InvalidInput.into());
    }
    let max_gap = if max_gap_minutes == 0. {
        30.
    } else {
        max_gap_minutes
    } * 60000.;
    let mut sorted = Vec::with_capacity(turns.len());
    for turn in turns {
        cancel.check()?;
        validate_object(turn)?;
        let at = field(turn, "createdAt")
            .filter(|v| truthy(v))
            .map_or(Ok(0), time)?;
        sorted.push((at, turn));
    }
    sorted.sort_by_key(|(at, _)| *at);
    let mut groups = Vec::new();
    let mut current = Vec::new();
    let mut previous = 0;
    for (at, turn) in sorted {
        cancel.check()?;
        if !current.is_empty()
            && ((at as f64 - previous as f64) > max_gap || current.len() >= max_turns.max(1))
        {
            groups.push(std::mem::take(&mut current));
        }
        current.push(turn.clone());
        previous = at;
    }
    if !current.is_empty() {
        groups.push(current);
    }
    Ok(groups)
}
/// Build the actual ordinary capture shape, without persistence or broader visibility grants.
pub fn create(
    turns: &[Json],
    options: &BuildOptions<'_>,
    cancel: &Cancel,
) -> Result<Option<Json>, EngineError> {
    cancel.check()?;
    if options.id.is_empty() || options.now.is_empty() {
        return Err(StoreError::InvalidInput.into());
    }
    let now = time(&Json::String(options.now.clone()))?;
    let Some(first) = turns.first() else {
        return Ok(None);
    };
    for turn in turns {
        validate_object(turn)?;
    }
    let last = turns.last().ok_or(StoreError::InvalidInput)?;
    let start = field(first, "createdAt")
        .filter(|v| truthy(v))
        .map_or(Ok(now), time)?;
    let end = field(last, "createdAt")
        .filter(|v| truthy(v))
        .map_or(Ok(now), time)?;
    let duration = (((end as f64 - start as f64) / 60000.) + 0.5).floor();
    let labels = episode_text::analyze(turns, options.participant_names, cancel)?;
    let emotion = episode_emotion::calculate(turns, options.mood);
    let start = iso(start)?;
    let end = iso(end)?;
    let workspace = selected(options.workspace_key, first, "workspaceKey");
    let agent = selected(options.agent_id, first, "agentId");
    let route = options.session_key.to_utf8_lossy();
    let location = [
        (":direct:", "dm"),
        (":group:", "group"),
        (":heartbeat", "heartbeat"),
        (":cron", "cron"),
    ]
    .into_iter()
    .find(|(pattern, _)| route.contains(pattern))
    .map_or("session", |(_, label)| label);
    let strings = |v: Vec<JsString>| Json::Array(v.into_iter().map(Json::String).collect());
    let memories = turns
        .iter()
        .filter_map(|t| field(t, "id").filter(|id| truthy(id)).cloned())
        .collect();
    let visibility_workspace = if !options.workspace_key.is_empty() {
        Json::String(options.workspace_key.clone())
    } else {
        field(first, "workspaceKey")
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or_else(|| text(""))
    };
    let result = object(vec![
        ("id", Json::String(options.id.clone())),
        ("mentioned", Json::Array(vec![])),
        ("voiceSpeakers", strings(labels.voices)),
        ("workspaceKey", workspace),
        ("agentId", agent.clone()),
        ("title", text(&format!("Gespräch vom {}", &start[..10]))),
        (
            "summary",
            text(&format!(
                "{} Turns, {} Min",
                turns.len(),
                ryu_js::Buffer::new().format(duration)
            )),
        ),
        ("startTime", text(&start)),
        ("endTime", text(&end)),
        ("durationMinutes", json_number(duration)),
        ("participants", strings(labels.participants)),
        ("topics", strings(labels.topics)),
        ("memoryIds", Json::Array(memories)),
        ("emotionalTone", emotion.tone),
        ("emotionalDominant", text(emotion.dominant)),
        ("emotionalIntensity", json_number(emotion.intensity)),
        ("location", text(location)),
        ("importance", json_number(0.6)),
        ("narrativeArc", text("exploration")),
        ("turningPoint", text("")),
        ("vividness", json_number(0.)),
        ("replayCount", json_number(0.)),
        ("lastReplayed", Json::Null),
        ("createdAt", text(&iso(now)?)),
        ("turnCount", json_number(turns.len() as f64)),
        (
            "visibility",
            object(vec![
                ("scope", text("agent_private")),
                ("agentId", agent),
                ("workspaceIdentity", visibility_workspace),
                ("ownerUserId", text("")),
            ]),
        ),
    ]);
    cancel.check()?;
    Ok(Some(result))
}
fn selected(explicit: &JsString, first: &Json, key: &str) -> Json {
    if !explicit.is_empty() {
        Json::String(explicit.clone())
    } else {
        field(first, key)
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or_else(|| text("default"))
    }
}
/// Recompute vividness using an explicit host time; missing historical timestamps use epoch.
pub fn vividness(episode: &Json, now_ms: i64) -> Result<f64, StoreError> {
    validate_object(episode)?;
    let zero = json_number(0.);
    let tone = field(episode, "emotionalTone");
    let intensity = tone
        .and_then(|t| field(t, "emotionalIntensity"))
        .filter(|v| truthy(v));
    let intensity = if let Some(v) = intensity {
        number(Some(v))
    } else {
        let sum = match tone {
            Some(Json::Object(values)) => values.iter().map(|(_, v)| number(Some(v))).sum::<f64>(),
            _ => 0.,
        } / 7.;
        if sum.is_nan() || sum == 0. {
            0.
        } else {
            sum
        }
    };
    let anchor = ["startTime", "createdAt"]
        .iter()
        .filter_map(|key| field(episode, key))
        .find(|v| truthy(v))
        .unwrap_or(&zero);
    let age_days = (now_ms as f64 - time(anchor)? as f64) / 86400000.;
    let recency = (1. - age_days / 30.).max(0.);
    let numeric = |key| {
        number(Some(
            field(episode, key).filter(|v| truthy(v)).unwrap_or(&zero),
        ))
    };
    Ok(intensity * 0.3
        + recency * 0.3
        + (numeric("replayCount") / 10.).min(1.) * 0.2
        + (numeric("durationMinutes") / 60.).min(1.) * 0.2)
}
