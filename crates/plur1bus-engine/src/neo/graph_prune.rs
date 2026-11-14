//! C5 graph cleanup under the canonical Neo writer lease and Lance mutation gate.
use super::{
    acl, append_cap_io,
    append_source::SourceProof,
    capture_journal::CaptureJournal,
    derived_fields::{text, validate_object},
    graph_ownership::private_cleanup_binding,
    journal_io,
    merged_order::{date, field, truthy},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, JobName, StoreError},
    jobs::{authority::JobAuthority, lance_scope::LanceScope},
    store::{RowFilter, Store},
    text::json::{parse_json, TolerantJsonValue as Json},
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const GRAPH: &str = "memory-graph.jsonl";
const SIXTY_DAYS_MS: f64 = 60. * 86_400_000.;
const MAX_ENDPOINTS: usize = 10_000;

#[derive(Default)]
pub(crate) struct Pruned {
    pub(crate) inactive: usize,
    pub(crate) weak: usize,
}

pub(crate) fn run(
    journal: &CaptureJournal,
    authority: &JobAuthority,
    store: &Store,
    filter: &RowFilter,
    now: i64,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<Pruned, EngineError> {
    if authority.job() != JobName::ConsolidateDaily {
        return Err(crate::jobs::authority::unbound());
    }
    let ctx = authority.request();
    let (principal, agent) = authority.caller();
    journal.with_operation_cleanup(principal, agent, ctx, cancel, check, |dir, check| {
        let Some((source, before)) = SourceProof::read(dir, GRAPH, cancel)? else {
            return Ok(Pruned::default());
        };
        let mut keys = HashSet::new();
        let mut records = Vec::new();
        for (index, line) in before.split_inclusive(|byte| *byte == b'\n').enumerate() {
            cancel.check()?;
            if index >= journal_io::MAX_ROWS {
                return Err(StoreError::Corrupt.into());
            }
            if let Some((left, right, weak)) = candidate(line, ctx, now) {
                if keys.len() < MAX_ENDPOINTS {
                    keys.extend([left.clone(), right.clone()]);
                    records.push((line, Some((left, right, weak))));
                    continue;
                }
            }
            records.push((line, None));
        }
        let keys: Vec<_> = keys.into_iter().collect();
        let current = load_endpoints(store, filter, ctx, &keys, cancel)?;
        let mut judged = HashSet::new();
        let mut kept = Vec::with_capacity(before.len());
        let mut pruned = Pruned::default();
        for (line, edge) in records {
            cancel.check()?;
            if let Some((left, right, weak)) = edge {
                if let Some((a, b)) = current.get(&left).zip(current.get(&right)) {
                    let inactive = !a.active || !b.active;
                    if inactive || weak {
                        pruned.inactive += usize::from(inactive);
                        pruned.weak += usize::from(!inactive);
                        judged.extend([left, right]);
                        continue;
                    }
                }
            }
            kept.extend_from_slice(line);
        }
        if !judged.is_empty() {
            let judged: Vec<_> = judged.into_iter().collect();
            let recheck = || {
                check()?;
                let latest = load_endpoints(store, filter, ctx, &judged, cancel)?;
                if judged.iter().any(|key| latest.get(key) != current.get(key)) {
                    return Err(StoreError::Unavailable.into());
                }
                check()
            };
            source.verify(dir, GRAPH, &before)?;
            append_cap_io::replace_live(
                dir,
                GRAPH,
                source.identity,
                &before,
                &kept,
                cancel,
                &recheck,
            )?;
        }
        Ok(pruned)
    })
}

fn candidate(line: &[u8], ctx: &RequestContext, now: i64) -> Option<(String, String, bool)> {
    if !line.ends_with(b"\n") {
        return None;
    }
    let row = parse_json(std::str::from_utf8(line).ok()?).ok()?;
    validate_object(&row).ok()?;
    if !journal_io::owned(&row, ctx)
        || acl::bindings(&row, ctx).ok()?.scope != "agent_private"
        || !private_cleanup_binding(&row, ctx)
    {
        return None;
    }
    let endpoint = |name| {
        let Json::String(value) = field(&row, name)? else {
            return None;
        };
        let value = value.to_utf8_lossy();
        uuid::Uuid::parse_str(&value).ok()?;
        Some(value)
    };
    Some((
        endpoint("source")?,
        endpoint("target")?,
        old_and_weak(&row, now),
    ))
}

fn old_and_weak(row: &Json, now: i64) -> bool {
    let number = crate::capture::dynamics::number;
    let strength = number(field(row, "strength"));
    let observations = field(row, "observations").filter(|value| truthy(value));
    let created = field(row, "createdAt").map_or(f64::NAN, date);
    let reinforced = field(row, "lastReinforcedAt")
        .filter(|value| truthy(value))
        .map_or(created, date);
    strength.is_finite()
        && strength < 0.2
        && observations.map_or(1., |value| number(Some(value))) <= 1.
        && field(row, "type") != Some(&text("episode"))
        && [created, reinforced]
            .into_iter()
            .all(|time| time.is_finite() && (now as f64 - time) > SIXTY_DAYS_MS)
}

#[derive(PartialEq, Eq)]
struct Endpoint {
    active: bool,
    fingerprint: [u8; 32],
}
fn load_endpoints(
    store: &Store,
    filter: &RowFilter,
    ctx: &RequestContext,
    ids: &[String],
    cancel: &Cancel,
) -> Result<HashMap<String, Endpoint>, EngineError> {
    let mut result = HashMap::new();
    for batch in ids.chunks(100) {
        cancel.check()?;
        let mut filter = filter.clone();
        filter.ids = Some(batch.to_vec());
        for row in store.scan(&filter, batch.len() + 1)? {
            if !LanceScope::owns_agent_row(&row, ctx) {
                continue;
            }
            let fingerprint =
                Sha256::digest(serde_json::to_vec(&row).map_err(|_| StoreError::Corrupt)?).into();
            let endpoint = Endpoint {
                active: matches!(row.status.as_str(), "" | "active"),
                fingerprint,
            };
            if result.insert(row.id, endpoint).is_some() {
                return Err(StoreError::Corrupt.into());
            }
        }
    }
    Ok(result)
}
