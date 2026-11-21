//! Content-free installation learning.

use std::collections::{BTreeMap, HashSet};

use super::{
    admits, current, digest, equals, readable, string, target_hash, target_valid, target_value,
    Error, Source, Target, Window,
};
use crate::identity::principals::derive_user_principal;
use crate::js::sort_default;
use crate::rbac::types::{Principal, Role};
use crate::sessions::types::LearningToolError;
use crate::toolcall::json::{parse, V};

/// Aggregate procedural patterns without loading transcripts or invoking a model.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// IDs of admitted sessions.
    pub session_ids: Vec<String>,
    /// Frozen digest of selected metadata.
    pub digest: String,
    /// True when limits omitted sessions or groups.
    pub truncated: bool,
    /// Count of omitted sessions.
    pub omitted_sessions: usize,
    /// Grouped, content-free findings.
    #[serde(skip)]
    pub findings: Vec<V>,
}

const LIMIT_ROWS: usize = 4000;
const LIMIT_GROUPS: usize = 100;

fn metadata(row: &LearningToolError) -> Result<V, Error> {
    let value = parse(&row.metadata.stringify()).ok_or(Error::Source)?;
    let object = value
        .as_obj()
        .filter(|o| o.len() == 4)
        .ok_or(Error::Source)?;
    let version = object.get("version").and_then(V::as_f64);
    let tool = string(&value, "tool")?;
    let code = string(&value, "errorClass")?;
    if version != Some(1.0)
        || tool.is_empty()
        || tool.len() > 128
        || !tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b':'))
        || !matches!(
            code.as_str(),
            "tool-unknown"
                | "tool-call-invalid"
                | "tool-denied"
                | "tool-not-approved"
                | "tool-timeout"
                | "tool-failed"
                | "tool-result-too-large"
                | "tool-result-invalid"
                | "aborted"
        )
    {
        return Err(Error::Source);
    }
    let shape = object
        .get("shape")
        .and_then(V::as_obj)
        .filter(|s| s.len() == 9)
        .ok_or(Error::Source)?;
    if !matches!(shape.get("truncated"), Some(V::Bool(_))) {
        return Err(Error::Source);
    }
    let checked = |key: &str, max: f64| {
        shape
            .get(key)
            .and_then(V::as_f64)
            .filter(|n| n.fract() == 0.0 && (0.0..=max).contains(n))
            .ok_or(Error::Source)
    };
    checked("depth", 8.0)?;
    checked("fields", 65_536.0)?;
    let mut visited = 0.0;
    for kind in [
        "objects", "arrays", "strings", "numbers", "booleans", "nulls",
    ] {
        visited += checked(kind, 256.0)?;
    }
    if visited > 256.0 {
        return Err(Error::Source);
    }
    Ok(value)
}

fn record(row: &LearningToolError, meta: &V) -> V {
    V::obj([
        ("sessionId", V::s(&row.session_id)),
        ("turnId", V::s(&row.turn_id)),
        ("seq", V::Num(row.seq as f64)),
        ("at", V::Num(row.at as f64)),
        ("metadata", meta.clone()),
    ])
}

/// Read only the trusted tool-error projection for an authorized owner.
pub fn collect(
    source: &dyn Source,
    target: &Target,
    who: &Principal,
    window: Window,
    run: &str,
    cap: usize,
    now: i64,
) -> Result<Outcome, Error> {
    if !target_valid(target)
        || target.scope != "installation"
        || who.role != Role::Owner
        || !(1..=super::SESSIONS).contains(&cap)
        || window.from < 0
        || window.to <= window.from
        || window.to > super::SAFE_INTEGER
    {
        return Err(Error::Rights);
    }
    let live = current(source, target, who, now)?;
    if live.role != Role::Owner {
        return Err(Error::Rights);
    }
    let rows = source.tool_errors(target, window)?;
    if rows.len() > LIMIT_ROWS {
        return Err(Error::Cap);
    }
    let owner = derive_user_principal(&target.owner).map_err(|_| Error::Rights)?;
    let mut states: BTreeMap<String, Option<V>> = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    let mut chosen = Vec::new();
    let mut groups: BTreeMap<String, (V, Vec<V>)> = BTreeMap::new();
    for row in rows {
        let sid = &row.session_id;
        if !states.contains_key(sid) {
            let session = source.session(sid)?;
            states.insert(
                sid.clone(),
                session.filter(|s| equals(s, "id", sid) && admits(target, &owner, s)),
            );
        }
        let Some(session) = states.get(sid).and_then(Option::as_ref) else {
            continue;
        };
        if !readable(source, target, who, &live, session, now)? {
            continue;
        }
        if !seen.insert((sid.clone(), row.seq))
            || row.turn_id.is_empty()
            || !(1..=super::SAFE_INTEGER).contains(&row.seq)
            || !(0..window.to).contains(&row.at)
        {
            return Err(Error::Source);
        }
        if !sessions.contains(sid) {
            sessions.push(sid.clone());
        }
        if !sessions.iter().take(cap).any(|id| id == sid) {
            continue;
        }
        let meta = metadata(&row)?;
        let key = digest(&meta);
        let entry = record(&row, &meta);
        let proof = V::obj([
            ("sessionId", V::s(sid)),
            ("turnId", V::s(&row.turn_id)),
            ("sourceId", V::s(&row.seq.to_string())),
            ("source", V::s("event")),
            ("trust", V::s("untrusted")),
            ("agentId", V::s(&string(session, "agentId")?)),
            ("owner", V::s(&owner)),
            ("day", V::s(&super::aggregation::date(&entry, "at")?)),
        ]);
        groups
            .entry(key)
            .or_insert_with(|| (meta, Vec::new()))
            .1
            .push(proof);
        chosen.push(entry);
    }
    if current(source, target, who, now)?.role != Role::Owner {
        return Err(Error::Rights);
    }
    let omitted_sessions = sessions.len().saturating_sub(cap);
    sessions.truncate(cap);
    let truncated = omitted_sessions > 0 || groups.len() > LIMIT_GROUPS;
    let mut findings = Vec::new();
    for (key, (record, proofs)) in groups.into_iter().take(LIMIT_GROUPS) {
        let count = |key: &str| -> Result<usize, Error> {
            Ok(proofs
                .iter()
                .map(|r| string(r, key))
                .collect::<Result<HashSet<_>, _>>()?
                .len())
        };
        let mut agents = proofs
            .iter()
            .map(|r| string(r, "agentId"))
            .collect::<Result<HashSet<_>, _>>()?
            .into_iter()
            .collect::<Vec<_>>();
        sort_default(&mut agents);
        let id = digest(&V::Arr(vec![V::s(&target_hash(target)), V::s(&key)]));
        let spread = V::obj([
            ("sessions", V::Num(count("sessionId")? as f64)),
            ("total", V::Num(sessions.len() as f64)),
            ("days", V::Num(count("day")? as f64)),
            ("agents", V::Num(agents.len() as f64)),
            ("persons", V::Num(1.0)),
        ]);
        let V::Obj(mut pattern) = record else {
            return Err(Error::Source);
        };
        pattern.set("count", V::Num(proofs.len() as f64));
        pattern.set("affectedAgents", V::strs(&agents));
        findings.push(V::obj([
            ("id", V::s(&id)),
            ("runId", V::s(run)),
            ("target", target_value(target)?),
            ("kind", V::s("procedural")),
            ("change", V::s("add")),
            ("contentKey", V::s(&key)),
            ("text", V::s("Tool failure pattern")),
            ("evidence", V::Arr(proofs)),
            ("toolPattern", V::Obj(pattern)),
            ("prevalence", spread),
            ("verify", V::s("not-applicable")),
            ("agreement", V::s("unknown")),
            ("score", V::Num(0.0)),
            ("desiredTier", V::s("C")),
            ("effectiveTier", V::s("C")),
            ("skeptic", V::s("not-required")),
            ("models", V::Arr(Vec::new())),
            ("modelClasses", V::Arr(Vec::new())),
            ("promptVersion", V::s(super::store::PROMPT_VERSION)),
            ("status", V::s("waiting-h3")),
        ]));
    }
    Ok(Outcome {
        findings,
        session_ids: sessions,
        digest: digest(&V::Arr(chosen)),
        truncated,
        omitted_sessions,
    })
}

#[cfg(test)]
#[path = "installation_vectors.rs"]
mod vectors;
