//! Candidate discovery over bounded, archived workflow evidence.

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::evidence::{Execution, Proof};
use super::{text_id, tool_name, tool_version, valid_scope, Scope, R};
use crate::approvals::js_json::J;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::sessions::types::{
    EventRecord, MemoryMode, SessionPage, SessionRecord, TurnRecord, TurnState,
};
use serde::{Deserialize, Serialize};

/// Limits checked before session contents are read.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Minimum distinct qualifying sessions.
    pub min_sessions: usize,
    /// Minimum steps in a workflow.
    pub min_steps: usize,
    /// Maximum steps in a workflow.
    pub max_steps: usize,
    /// Maximum archived sessions read.
    pub max_sessions: usize,
    /// Maximum event rows examined per session.
    pub max_events: usize,
}

/// A current registered executable and its version.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Tool {
    /// Registered tool name.
    pub name: String,
    /// Exact immutable manifest digest.
    pub version: String,
}

/// A disabled proposal for human review. The miner has no installer.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Artifact format.
    pub schema: String,
    /// Artifact kind.
    pub kind: String,
    /// Authorship recorded by mining.
    pub author: String,
    /// Durable activation flag, always false for mined proposals.
    pub enabled: bool,
    /// Public proposal name.
    pub name: String,
    /// Digest of scope and sequence.
    pub workflow_hash: String,
    /// Reviewable procedural summary without private call content.
    pub skill_md: String,
    /// Count-only explanation of repetition.
    pub reason: String,
    /// Distinct qualifying sessions.
    pub session_ids: Vec<String>,
}

/// The authorized historical session projection.
pub trait Sessions {
    /// List archived sessions in the bound scope, with observable truncation.
    fn archived(&self, scope: &Scope, max: usize) -> R<SessionPage>;
    /// List metadata for turns in this verified session.
    fn turns(&self, session: &str) -> R<Vec<TurnRecord>>;
    /// Page structural workflow events after a stable sequence.
    fn events(&self, session: &str, after: i64, max: usize) -> R<Vec<EventRecord>>;
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            min_sessions: 2,
            min_steps: 2,
            max_steps: 20,
            max_sessions: 200,
            max_events: 20_000,
        }
    }
}

fn valid_bounds(config: Settings) -> bool {
    (2..=200).contains(&config.min_sessions)
        && (config.min_sessions..=200).contains(&config.max_sessions)
        && (1..=100).contains(&config.min_steps)
        && (config.min_steps..=100).contains(&config.max_steps)
        && (1..=20_000).contains(&config.max_events)
}

fn same_scope(session: &SessionRecord, scope: &Scope) -> bool {
    session.owner == scope.owner
        && session.agent_id == scope.agent_id
        && session.scope == scope.scope
        && session.memory_mode == MemoryMode::Remember
        && session.archived_at.is_some()
        && (1..=128).contains(&session.id.len())
        && session
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn incomplete(reason: &'static str) -> CollabError {
    CollabError::with_reason(C::Conflict, "mining scope is incomplete", reason)
}

fn stored_events(source: &dyn Sessions, id: &str, max: usize) -> R<Vec<EventRecord>> {
    let mut events = Vec::new();
    let mut after = 0;
    loop {
        let limit = 2000.min(max + 1 - events.len());
        let page = source.events(id, after, limit)?;
        if page.len() > limit {
            return Err(CollabError::new(C::Storage, "invalid mining event page"));
        }
        if page.is_empty() {
            return Ok(events);
        }
        for event in page {
            if event.session_id != id || event.seq <= after {
                return Err(CollabError::new(C::Storage, "invalid mining event page"));
            }
            after = event.seq;
            events.push(event);
        }
        if events.len() > max {
            return Err(incomplete("event-window-truncated"));
        }
    }
}

fn succeeded(result: &EventRecord) -> bool {
    if result.data.get("isError") == Some(&J::Bool(true)) {
        return false;
    }
    let Some(output) = result
        .data
        .get("output")
        .and_then(J::as_str)
        .filter(|s| s.len() <= 65_536)
    else {
        return false;
    };
    J::parse(output).is_some_and(|value| value.get("isError") == Some(&J::Bool(false)))
}

fn steps<'a>(
    scope: &Scope,
    turn: &TurnRecord,
    events: &[&EventRecord],
    catalog: &HashMap<&str, &'a Tool>,
    proof: &dyn Proof,
    bounds: Settings,
) -> R<Option<Vec<&'a Tool>>> {
    let calls = events
        .iter()
        .copied()
        .filter(|e| e.kind == "tool.call")
        .collect::<Vec<_>>();
    if !(bounds.min_steps..=bounds.max_steps).contains(&calls.len()) {
        return Ok(None);
    }
    let mut ids = HashSet::new();
    let mut workflow = Vec::new();
    for call in calls {
        let Some(id) = call
            .data
            .get("id")
            .and_then(J::as_str)
            .filter(|id| text_id(id, 256))
        else {
            return Ok(None);
        };
        if !ids.insert(id) {
            return Ok(None);
        }
        let Some(tool) = call
            .data
            .get("name")
            .and_then(J::as_str)
            .and_then(|name| catalog.get(name))
        else {
            return Ok(None);
        };
        let e = Execution {
            owner: scope.owner.clone(),
            agent_id: scope.agent_id.clone(),
            session_id: turn.session_id.clone(),
            turn_id: turn.id.clone(),
            call_id: id.into(),
            tool: tool.name.clone(),
            version: tool.version.clone(),
            success: true,
        };
        if !proof.verified(scope, &e)? {
            return Ok(None);
        }
        let mut results = events.iter().copied().filter(|event| {
            event.kind == "tool.result"
                && event.seq > call.seq
                && event.data.get("id").and_then(J::as_str) == Some(id)
        });
        if !results.next().is_some_and(succeeded) || results.next().is_some() {
            return Ok(None);
        }
        workflow.push(*tool);
    }
    Ok(Some(workflow))
}

fn workflow_hash(scope: &Scope, workflow: &[&Tool]) -> R<String> {
    let val = serde_json::json!([scope, workflow]);
    let canonical = crate::prompt::canonical_json(&val)
        .map_err(|_| CollabError::new(C::Invalid, "workflow cannot be canonicalized"))?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn present(hash: String, steps: &[&Tool], sessions: BTreeSet<String>) -> Candidate {
    let name = format!("mined-workflow-{}", &hash[..16]);
    let mut skill=format!("---\nname: {name}\ndescription: Repeat a reviewed sequence of approved tool operations.\n---\n\n# Reviewed workflow\n\nBefore each step, derive arguments from the current authorized request. Preserve every dispatcher policy check and approval. Do not reuse session arguments, paths, output, secrets or identities.\n\n");
    for (index, t) in steps.iter().enumerate() {
        use std::fmt::Write as _;
        let _ = writeln!(
            skill,
            "{}. Invoke {} through the central dispatcher and verify its result.",
            index + 1,
            t.name
        );
    }
    Candidate {
        schema: "plur1bus.skill-candidate/1".into(),
        kind: "skill".into(),
        author: "agent".into(),
        enabled: false,
        name,
        workflow_hash: hash,
        skill_md: skill,
        reason: format!(
            "{} approved tool steps succeeded in {} completed sessions in the same scope.",
            steps.len(),
            sessions.len()
        ),
        session_ids: sessions.into_iter().collect(),
    }
}

pub(super) fn mine(
    sessions: &dyn Sessions,
    scope: &Scope,
    tools: &[Tool],
    proof: &dyn Proof,
    settings: Settings,
) -> R<Vec<Candidate>> {
    if !valid_scope(scope) || !valid_bounds(settings) {
        return Err(CollabError::new(
            C::Invalid,
            "invalid mining scope or bounds",
        ));
    }
    let mut catalog = HashMap::new();
    for tool in tools
        .iter()
        .filter(|t| tool_name(&t.name) && tool_version(&t.version))
    {
        if catalog
            .insert(tool.name.as_str(), tool)
            .is_some_and(|old: &Tool| old.version != tool.version)
        {
            return Err(CollabError::new(
                C::Invalid,
                "conflicting registered tool version",
            ));
        }
    }
    let listed = sessions.archived(scope, settings.max_sessions)?;
    if listed.truncated || listed.sessions.len() > settings.max_sessions {
        return Err(incomplete("session-window-truncated"));
    }
    let mut groups: BTreeMap<String, (Vec<&Tool>, BTreeSet<String>)> = BTreeMap::new();
    let mut seen = HashSet::new();
    for session in listed.sessions.iter().filter(|s| same_scope(s, scope)) {
        if !seen.insert(&session.id) {
            return Err(CollabError::new(C::Storage, "duplicate mining session"));
        }
        let turns = sessions.turns(&session.id)?;
        if turns.len() > settings.max_events {
            return Err(incomplete("turn-window-truncated"));
        }
        let mut scoped = Vec::new();
        let mut ids = HashSet::new();
        for turn in turns {
            if turn.session_id != session.id || !ids.insert(turn.id.clone()) {
                return Err(CollabError::new(C::Storage, "invalid mining turn page"));
            }
            if turn.state == TurnState::Completed && !turn.incognito && turn.ended_at.is_some() {
                scoped.push(turn);
            }
        }
        if scoped.is_empty() {
            continue;
        }
        let events = stored_events(sessions, &session.id, settings.max_events)?;
        let mut by_turn: HashMap<&str, Vec<&EventRecord>> = HashMap::new();
        for event in &events {
            if let Some(id) = event.turn_id.as_deref() {
                by_turn.entry(id).or_default().push(event);
            }
        }
        for turn in &scoped {
            let Some(events) = by_turn.get(turn.id.as_str()) else {
                continue;
            };
            let Some(workflow) = steps(scope, turn, events, &catalog, proof, settings)? else {
                continue;
            };
            groups
                .entry(workflow_hash(scope, &workflow)?)
                .or_insert_with(|| (workflow, BTreeSet::new()))
                .1
                .insert(session.id.clone());
        }
    }
    Ok(groups
        .into_iter()
        .filter(|(_, (_, ids))| ids.len() >= settings.min_sessions)
        .map(|(hash, (tools, sessions))| present(hash, &tools, sessions))
        .collect())
}

#[cfg(test)]
#[path = "miner_vectors.rs"]
pub(in crate::skill_mining) mod vectors;
