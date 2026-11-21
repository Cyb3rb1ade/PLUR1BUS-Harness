//! Transcript selection for the learning pass.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::OnceLock;

use icu_collator::{options::CollatorOptions, CollatorBorrowed};
use icu_locale_core::locale;
use sha2::{Digest, Sha256};

use crate::identity::principals::derive_user_principal;
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, MemoryAgentScope, Principal, PrincipalKind, Resource};
use crate::toolcall::json::V;
pub mod aggregation;
pub mod config;
pub mod installation;
pub mod review;
pub mod runner;
pub mod service;
pub mod store;

// Match the en-US default of the pinned Node runtime used by the parity recorder.
fn locale_compare(left: &str, right: &str) -> Ordering {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            CollatorBorrowed::try_new(locale!("en-US").into(), CollatorOptions::default()).ok()
        })
        .as_ref()
        .map_or_else(|| left.cmp(right), |collator| collator.compare(left, right))
}

/// Target scope, owner and destination for a learning run.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Scope named by the wire format.
    pub scope: String,
    /// Authenticated account ID.
    pub owner: String,
    /// Destination agent ID.
    pub agent_id: String,
    /// Project ID for project learning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

/// Timestamp bounds for loading evidence, in epoch milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Window {
    /// Inclusive lower bound.
    pub from: i64,
    /// Exclusive upper bound.
    pub to: i64,
}

/// Current, scoped transcript access through the host.
pub trait Source {
    /// Resolve the current authenticated person.
    fn current_person(&self, owner: &str) -> Option<Principal>;
    /// Return a bounded page of session metadata.
    fn sessions(
        &self,
        target: &Target,
        window: Window,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<V>, Error>;
    /// Confirm the live target binding independently of the stored target data.
    fn may_read_target(&self, target: &Target, who: &Principal) -> bool;
    /// Find current metadata for one previously authorized evidence session.
    fn session(&self, _id: &str) -> Result<Option<V>, Error> {
        Ok(None)
    }
    /// Load only the specified current evidence rows for the session.
    fn evidence(&self, _row: &V, _refs: &[V]) -> Result<V, Error> {
        Err(Error::Source)
    }
    /// Load only trusted, value-free tool failure metadata for installation scope.
    fn tool_errors(
        &self,
        _target: &Target,
        _window: Window,
    ) -> Result<Vec<crate::sessions::types::LearningToolError>, Error> {
        Err(Error::Source)
    }
    /// Evaluate current session ownership, registration and exposure.
    fn may_read(&self, target: &Target, session: &V, who: &Principal) -> bool;
    /// Load the scoped transcript. The session must be its current incarnation.
    fn transcript(&self, session: &V, window: Window) -> Result<V, Error>;
}

/// Failures visible to the learning ledger.
#[derive(Clone, Copy, Debug)]
pub enum Error {
    /// The requested scope or current authority is invalid.
    Rights,
    /// The session or transcript source is inconsistent.
    Source,
    /// Loaded material exceeds the transcript limits.
    Cap,
    /// A model result failed bounded structured validation.
    InvalidOutput,
    /// The trusted target settings disabled learning.
    Disabled,
    /// No eligible transcript evidence was present.
    NoSessions,
    /// The model token ceiling refused the operation.
    Budget,
    /// This target hit the UTC failure cap.
    BreakerOpen,
    /// No permitted model route is configured.
    NoModel,
    /// The target's project data requires a local route.
    LocalOnly,
    /// A model effect or usage receipt could not be validated.
    ProviderFailed,
    /// The caller stopped learning before publication.
    Interrupted,
}

impl Error {
    /// Stable wire reason.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rights => "rights-changed",
            Self::Source => "source-unavailable",
            Self::Cap => "transcript-cap",
            Self::InvalidOutput => "invalid-output",
            Self::Disabled => "disabled",
            Self::NoSessions => "no-sessions",
            Self::Budget => "budget",
            Self::BreakerOpen => "breaker-open",
            Self::NoModel => "no-model",
            Self::LocalOnly => "local-only",
            Self::ProviderFailed => "provider-failed",
            Self::Interrupted => "interrupted",
        }
    }
}

/// Admitted transcripts and truncation information before content loading.
pub struct Selection {
    /// Full transcript envelopes in ranked order.
    pub transcripts: Vec<V>,
    /// Count of eligible sessions left unloaded by the caller's cap.
    pub omitted_sessions: usize,
}

const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const SESSIONS: usize = 50;
const MESSAGES: usize = 2000;
const EVENTS: usize = 4000;
const BYTES: usize = 262_144;
const PAGE: usize = 51;
const ROWS: usize = 20_000;

fn digest(value: &V) -> String {
    format!("{:x}", Sha256::digest(value.stringify().as_bytes()))
}

fn string(row: &V, key: &str) -> Result<String, Error> {
    let value = row.get(key).and_then(V::as_js).ok_or(Error::Source)?;
    String::from_utf16(value.units()).map_err(|_| Error::Source)
}

fn array<'a>(row: &'a V, key: &str) -> Result<&'a [V], Error> {
    row.get(key).and_then(V::as_arr).ok_or(Error::Source)
}

fn equals(row: &V, key: &str, value: &str) -> bool {
    row.get(key).is_some_and(|v| v.is_str(value))
}

fn target_value(target: &Target) -> Result<V, Error> {
    let text = serde_json::to_string(target).map_err(|_| Error::InvalidOutput)?;
    crate::toolcall::json::parse(&text).ok_or(Error::InvalidOutput)
}

/// SHA-256 over the legacy target tuple.
pub fn target_hash(target: &Target) -> String {
    digest(&V::Arr(vec![
        V::s(&target.scope),
        V::s(&target.owner),
        V::s(&target.agent_id),
        target.project_id.as_deref().map_or(V::Null, V::s),
    ]))
}

fn parts(transcript: &V) -> Result<(String, V), Error> {
    let id = string(transcript.get("session").ok_or(Error::Source)?, "id")?;
    let messages = array(transcript, "messages")?;
    let events = array(transcript, "events")?;
    let person_ids = transcript
        .get("personMessageIds")
        .cloned()
        .unwrap_or(V::Arr(Vec::new()));
    Ok((
        id.clone(),
        V::Arr(vec![
            V::s(&id),
            V::Arr(messages.to_vec()),
            V::Arr(events.to_vec()),
            person_ids,
        ]),
    ))
}

/// Digest ordered evidence with the legacy JSON representation.
pub fn selection_digest(transcripts: &[V]) -> Result<String, Error> {
    let mut rows = transcripts
        .iter()
        .map(parts)
        .collect::<Result<Vec<_>, _>>()?;
    rows.sort_by(|a, b| locale_compare(&a.0, &b.0));
    Ok(digest(&V::Arr(
        rows.into_iter().map(|(_, row)| row).collect(),
    )))
}

fn target_valid(target: &Target) -> bool {
    let id = |v: &str| {
        !v.is_empty() && v.encode_utf16().count() <= 128 && !v.chars().any(|c| c <= '\u{1f}')
    };
    id(&target.owner)
        && id(&target.agent_id)
        && match target.scope.as_str() {
            "agent" | "installation" => target.project_id.is_none(),
            "project" => target.project_id.as_deref().is_some_and(id),
            _ => false,
        }
}

fn grants(who: &Principal, scope: MemoryAgentScope, agent: &str, now: i64) -> bool {
    let action = match scope {
        MemoryAgentScope::AgentPrivate => "memory.agent-private.read",
        MemoryAgentScope::Workspace => "memory.workspace.read",
    };
    authorize(
        Some(who),
        action,
        &Resource::MemoryAgent {
            scope,
            agent_id: agent.into(),
        },
        &AuthorizeContext {
            now: Some(now as f64),
        },
    )
    .is_allow()
}

fn current(
    source: &dyn Source,
    target: &Target,
    who: &Principal,
    now: i64,
) -> Result<Principal, Error> {
    let scope = if target.scope == "project" {
        MemoryAgentScope::Workspace
    } else {
        MemoryAgentScope::AgentPrivate
    };
    let caller = |p: &Principal| {
        p.kind == Some(PrincipalKind::Person)
            && p.user_id == target.owner
            && grants(p, scope, &target.agent_id, now)
    };
    if !caller(who) {
        return Err(Error::Rights);
    }
    source
        .current_person(&target.owner)
        .filter(caller)
        .filter(|live| source.may_read_target(target, live))
        .ok_or(Error::Rights)
}

fn readable(
    source: &dyn Source,
    target: &Target,
    who: &Principal,
    live: &Principal,
    row: &V,
    now: i64,
) -> Result<bool, Error> {
    let agent = string(row, "agentId")?;
    Ok(grants(who, MemoryAgentScope::AgentPrivate, &agent, now)
        && grants(live, MemoryAgentScope::AgentPrivate, &agent, now)
        && source.may_read(target, row, live))
}

fn admits(target: &Target, owner: &str, row: &V) -> bool {
    equals(row, "owner", owner)
        && equals(row, "memoryMode", "remember")
        && (target.scope != "agent" || equals(row, "agentId", &target.agent_id))
        && target
            .project_id
            .as_deref()
            .is_none_or(|p| equals(row, "scope", p))
}

fn verify_transcript(transcript: &V, expected: &V, id: &str) -> Result<bool, Error> {
    let session = transcript.get("session").ok_or(Error::Source)?;
    for field in [
        "id",
        "owner",
        "agentId",
        "scope",
        "memoryMode",
        "chatKey",
        "kind",
        "origin",
    ] {
        match (session.get(field), expected.get(field)) {
            (Some(actual), Some(expected)) if actual.deep_equal(expected) => {}
            (None, None) => {}
            _ => return Err(Error::Source),
        }
    }
    let messages = array(transcript, "messages")?;
    let events = array(transcript, "events")?;
    if messages
        .iter()
        .chain(events)
        .any(|item| !equals(item, "sessionId", id))
    {
        return Err(Error::Source);
    }
    if messages.len() > MESSAGES || events.len() > EVENTS || transcript.stringify().len() > BYTES {
        return Err(Error::Cap);
    }
    if let Some(persons) = transcript.get("personMessageIds") {
        let persons = persons.as_arr().ok_or(Error::Source)?;
        if !persons.is_empty() && !equals(session, "kind", "channel") {
            return Err(Error::Source);
        }
        let user_message_ids = messages
            .iter()
            .filter(|m| equals(m, "role", "user"))
            .filter_map(|m| m.get("id").and_then(V::as_js))
            .collect::<HashSet<_>>();
        if persons
            .iter()
            .any(|p| p.as_js().is_none_or(|id| !user_message_ids.contains(id)))
        {
            return Err(Error::Source);
        }
    }
    Ok(!messages.is_empty() || !events.is_empty())
}

/// Take a bounded transcript snapshot after checking ownership and access.
pub fn select(
    source: &dyn Source,
    target: &Target,
    who: &Principal,
    window: Window,
    cap: usize,
    now: i64,
) -> Result<Selection, Error> {
    if !target_valid(target)
        || !(1..=SESSIONS).contains(&cap)
        || window.from < 0
        || window.to <= window.from
        || window.to > SAFE_INTEGER
    {
        return Err(Error::Rights);
    }
    let live = current(source, target, who, now)?;
    let owner = derive_user_principal(&target.owner).map_err(|_| Error::Rights)?;
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    for offset in (0..=ROWS).step_by(PAGE) {
        let page = source.sessions(target, window, PAGE, offset)?;
        let count = page.len();
        if count > PAGE || offset + count > ROWS {
            return Err(Error::Source);
        }
        for row in page {
            let id = string(&row, "id")?;
            if id.is_empty() || !seen.insert(id.clone()) {
                return Err(Error::Source);
            }
            if admits(target, &owner, &row) && readable(source, target, who, &live, &row, now)? {
                let rank = row
                    .get("lastTurnAt")
                    .and_then(V::as_f64)
                    .or_else(|| row.get("updatedAt").and_then(V::as_f64))
                    .filter(|t| {
                        t.is_finite() && t.fract() == 0.0 && (0.0..=SAFE_INTEGER as f64).contains(t)
                    })
                    .ok_or(Error::Source)?;
                sessions.push((rank, id, row));
            }
        }
        if count < PAGE {
            break;
        }
    }
    sessions.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| locale_compare(&a.1, &b.1)));
    let omitted_sessions = sessions.len().saturating_sub(cap);
    let mut transcripts = Vec::new();
    for (_, id, row) in sessions.into_iter().take(cap) {
        let live = current(source, target, who, now)?;
        if !readable(source, target, who, &live, &row, now)? {
            return Err(Error::Rights);
        }
        let transcript = source.transcript(&row, window)?;
        let live = current(source, target, who, now)?;
        if !readable(source, target, who, &live, &row, now)? {
            return Err(Error::Rights);
        }
        if verify_transcript(&transcript, &row, &id)? {
            transcripts.push(transcript);
        }
    }
    Ok(Selection {
        transcripts,
        omitted_sessions,
    })
}

#[cfg(test)]
#[path = "learn_vectors.rs"]
mod vectors;
