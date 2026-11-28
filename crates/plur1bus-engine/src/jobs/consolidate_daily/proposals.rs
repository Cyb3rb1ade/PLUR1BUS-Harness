//! Owner-bound daily sidecars. Source cards remain authoritative.
mod merge;
mod resolver;
mod selection;

use super::ConsolidateDaily;
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, MemoryRow, MemoryScope, StoreError},
    jobs::{authority::JobAuthority, ledger::io, registry::JobContext},
    recall::{
        knowledge::private_key, lifecycle::is_recall_entry_live, tombstone_mask::TombstoneMask,
    },
    store::{directory::TrustedDirectory, kernel_lease, Store},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const MAX_FILE: usize = 8 * 1024 * 1024;
const LOOKBACK: i64 = 30 * 86_400_000;
const MAX_SCAN: usize = 50_000;
const PAGE: usize = 5_000;
const MAX_ACTIONS: usize = 500;
const PROPOSALS: &str = "merge-proposals.jsonl";
const STATE: &str = "run-state.json";

struct Run<'a> {
    job: &'a ConsolidateDaily,
    authority: &'a JobAuthority,
    store: &'a Store,
    context: &'a JobContext,
    cancel: &'a Cancel,
    check: &'a dyn Fn() -> Result<(), EngineError>,
    mask: TombstoneMask,
}

impl Run<'_> {
    fn request(&self) -> &RequestContext {
        self.authority.request()
    }
    fn can_use(&self, row: &MemoryRow, mask: &TombstoneMask) -> Result<bool, StoreError> {
        let now = self.job.scope.operations.host().now_ms();
        Ok(uuid::Uuid::parse_str(&row.id).is_ok()
            && !row.text.trim().is_empty()
            && matches!(row.scope.as_str(), "agent-private" | "workspace" | "user")
            && super::LanceScope::owns_agent_row(row, self.request())
            && is_recall_entry_live(row, now, None)
            && !mask.masks(row)?)
    }

    fn rows(&self, ids: &[&str]) -> Result<HashMap<String, MemoryRow>, StoreError> {
        let mut rows = HashMap::new();
        for ids in ids.chunks(200) {
            let mut filter = super::LanceScope::agent_rows(self.authority);
            filter.ids = Some(ids.iter().map(|id| (*id).into()).collect());
            for row in self.store.scan(&filter, ids.len().saturating_add(1))? {
                if rows.insert(row.id.clone(), row).is_some() {
                    return Err(StoreError::Corrupt);
                }
            }
        }
        Ok(rows)
    }

    fn current(&self, expected: &[&MemoryRow]) -> Result<(), EngineError> {
        (self.check)()?;
        let fresh = self.mask.refreshed();
        let ids: Vec<_> = expected.iter().map(|row| row.id.as_str()).collect();
        let copies = self.rows(&ids)?;
        for row in expected {
            let current = copies.get(&row.id).ok_or(StoreError::Unavailable)?;
            if !self.can_use(current, &fresh)?
                || current.vector != row.vector
                || current.created_at != row.created_at
                || current.memory_class != row.memory_class
                || current.never_forget != row.never_forget
                || selection::snapshot(current) != selection::snapshot(row)
            {
                return Err(StoreError::Unavailable.into());
            }
        }
        Ok(())
    }
}

pub(super) fn run(
    job: &ConsolidateDaily,
    authority: &JobAuthority,
    store: &Store,
    context: &JobContext,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    check()?;
    let run = Run {
        job,
        authority,
        store,
        context,
        cancel,
        check,
        mask: TombstoneMask::new(&job.base),
    };
    let count = compact(&run)?;
    context.note_count("compactionProposals", count)?;
    let resolved = resolver::run(&run)?;
    context.note_count("conflictProposals", resolved)
}

fn sink(run: &Run<'_>) -> Result<TrustedDirectory, EngineError> {
    (run.check)()?;
    let owner = private_key(run.request()).ok_or(StoreError::InvalidInput)?;
    Ok(TrustedDirectory::open(&run.job.base)?
        .create_child("_consolidation")?
        .create_child(&owner)?
        .create_child(".adaptive-learning")?)
}

fn compact(run: &Run<'_>) -> Result<usize, EngineError> {
    [
        (MemoryScope::AgentPrivate, "agent-private"),
        (MemoryScope::Workspace, "workspace"),
        (MemoryScope::User, "user"),
    ]
    .into_iter()
    .try_fold(0, |count, (scope, name)| {
        (run.check)()?;
        Ok(count + compact_scope(run, scope, name)?)
    })
}

fn compact_scope(
    run: &Run<'_>,
    scope: MemoryScope,
    scope_name: &str,
) -> Result<usize, EngineError> {
    let now = run.context.now_ms;
    let mut filter = super::LanceScope::agent_rows(run.authority);
    filter.status = Some("active".into());
    filter.scope = Some(scope);
    filter.since = Some(now.saturating_sub(LOOKBACK));
    filter.until = Some(now);
    let rows = run.store.scan(&filter, MAX_SCAN + 1)?;
    if rows.len() > MAX_SCAN {
        return Err(StoreError::Unavailable.into());
    }
    let mut candidates = Vec::new();
    let mut unique = HashSet::new();
    for row in rows {
        run.cancel.check()?;
        if row.memory_class == "core" || row.never_forget.as_f64() == Some(1.0) {
            continue;
        }
        if run.can_use(&row, &run.mask)? {
            if !unique.insert(row.id.clone()) {
                return Err(StoreError::Corrupt.into());
            }
            candidates.push(row);
        }
    }
    if candidates.len() < 2 {
        return Ok(0);
    }
    let dir = sink(run)?;
    let lease = kernel_lease::acquire(&dir, "consolidation", run.cancel, &mut || {})?;
    let old = io::read(&dir, STATE, MAX_FILE, run.cancel)?;
    let mut state: Value = if let Some(bytes) = &old {
        serde_json::from_slice(bytes).map_err(|_| StoreError::Corrupt)?
    } else {
        json!({})
    };
    if !state.is_object() {
        return Err(StoreError::Corrupt.into());
    }
    candidates.sort_by(|a, b| {
        b.created_at
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&a.created_at.as_f64().unwrap_or_default())
            .then(a.id.cmp(&b.id))
    });
    let request = run.request();
    let acl = json!({"scope":scope_name,"agentId":request.agent_id.as_str(),
        "workspaceIdentity":request.workspace_key,"ownerUserId":request.owner_user_id});
    // The pin hashes these four keys in this order.
    let encoded = format!(
        r#"{{"scope":{},"agentId":{},"workspaceIdentity":{},"ownerUserId":{}}}"#,
        acl["scope"], acl["agentId"], acl["workspaceIdentity"], acl["ownerUserId"]
    );
    let scan_id = &selection::hash(&encoded)[..32];
    let saved = &state["memoryCompactionScan"][scan_id];
    let previous = if saved["aclBindings"] == acl {
        saved.clone()
    } else {
        Value::Null
    };
    let cursor = previous["cursor"]
        .as_object()
        .and_then(|c| Some((c.get("createdAt")?.as_f64()?, c.get("id")?.as_str()?)));
    let start = cursor.map_or(0, |(t, id)| {
        candidates.partition_point(|row| {
            let created = row.created_at.as_f64().unwrap_or_default();
            created > t || (created == t && row.id.as_str() <= id)
        })
    });
    let end = (start + PAGE).min(candidates.len());
    let current = &candidates[start..end];
    let scope_hashes: HashSet<_> = current
        .iter()
        .map(|row| {
            (
                row.scope.as_str(),
                selection::hash(&crate::text::js::js_trim(&row.text).to_lowercase()),
            )
        })
        .collect();
    let mut page = current.to_vec();
    if start != 0 {
        let prior: HashMap<_, _> = previous["exactCandidates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v["id"].as_str()?, v)))
            .collect();
        for row in &candidates[..start] {
            let fingerprint = selection::hash(&crate::text::js::js_trim(&row.text).to_lowercase());
            if prior.get(row.id.as_str()).is_some_and(|v| {
                v["textHash"] == fingerprint && v["aclBindings"] == selection::bindings(row)
            }) && scope_hashes.contains(&(row.scope.as_str(), fingerprint))
            {
                page.push(row.clone());
            }
        }
    }
    let actions = selection::actions(
        &page,
        matches!(
            run.store.identity_status(),
            crate::store::IdentityStatus::Verified
        ),
        run.cancel,
    )?;
    let bytes = io::read(&dir, PROPOSALS, MAX_FILE, run.cancel)?;
    let existing = lines(bytes.as_deref())?;
    let mut seen = HashSet::new();
    for action in existing
        .iter()
        .filter_map(|row| row["actions"].as_array())
        .flatten()
    {
        seen.insert(merge::fingerprint(action));
    }
    let mut actions = actions
        .into_iter()
        .filter(|action| seen.insert(merge::fingerprint(action)));
    let mut new: Vec<_> = actions.by_ref().take(MAX_ACTIONS).collect();
    let more = actions.next().is_some();
    let snapshots: HashMap<_, _> = page.iter().map(|row| (row.id.as_str(), row)).collect();
    merge::enrich(run, &snapshots, &mut new)?;
    let _mutation = run.job.scope.operations.mutation()?;
    let mut partitions = Vec::new();
    let mut ids = HashSet::new();
    for action in &new {
        let acl = action["aclBindings"].clone();
        if !partitions.contains(&acl) {
            partitions.push(acl);
        }
        for row in action["expectedRows"].as_array().into_iter().flatten() {
            ids.insert(row["id"].as_str().ok_or(StoreError::Corrupt)?);
        }
    }
    let expected = ids
        .into_iter()
        .map(|id| snapshots.get(id).copied().ok_or(StoreError::Corrupt))
        .collect::<Result<Vec<_>, _>>()?;
    if !new.is_empty() {
        let single = (partitions.len() == 1).then(|| partitions[0].clone());
        let envelope = json!({"proposedAt":now,"actions":new,"aclBindings":single,"aclPartitions":partitions,"status":"pending"});
        publish(
            &dir,
            PROPOSALS,
            bytes.as_deref(),
            &envelope,
            run.cancel,
            &|| {
                lease.check(&dir)?;
                run.current(&expected)
            },
        )?;
    }
    if !more && (start != 0 || end != candidates.len()) {
        let cursor = if end < candidates.len() {
            current
                .last()
                .map(|r| json!({"createdAt":r.created_at,"id":r.id}))
        } else {
            None
        };
        let known = if cursor.is_some() {
            let mut known = previous["exactCandidates"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let new = current.iter().map(|r|json!({"id":r.id,"createdAt":r.created_at,
                "textHash":selection::hash(&crate::text::js::js_trim(&r.text).to_lowercase()),"aclBindings":selection::bindings(r)}));
            known.extend(new);
            let keep = known.len().saturating_sub(PAGE);
            known.drain(..keep);
            known
        } else {
            Vec::new()
        };
        if state["memoryCompactionScan"].is_null() {
            state["memoryCompactionScan"] = json!({});
        }
        let scans = state["memoryCompactionScan"]
            .as_object_mut()
            .ok_or(StoreError::Corrupt)?;
        scans.insert(
            scan_id.into(),
            json!({"cursor":cursor,"complete":cursor.is_none(),"updatedAt":now,
            "aclBindings":acl,"exactCandidates":known}),
        );
        let next = serde_json::to_vec(&state).map_err(|_| StoreError::Corrupt)?;
        io::replace(
            &dir,
            STATE,
            old.as_deref(),
            &next,
            MAX_FILE,
            run.cancel,
            &|| {
                lease.check(&dir)?;
                (run.check)()
            },
        )?;
    }
    Ok(new.len())
}

fn lines(bytes: Option<&[u8]>) -> Result<Vec<Value>, StoreError> {
    bytes
        .unwrap_or_default()
        .split(|byte| *byte == b'\n')
        .filter(|row| !row.is_empty())
        .map(|row| serde_json::from_slice(row).map_err(|_| StoreError::Corrupt))
        .collect()
}

fn publish(
    dir: &TrustedDirectory,
    name: &str,
    original: Option<&[u8]>,
    entry: &Value,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    let mut bytes = original.unwrap_or_default().to_vec();
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        bytes.push(b'\n');
    }
    serde_json::to_writer(&mut bytes, entry).map_err(|_| StoreError::Corrupt)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FILE {
        return Err(StoreError::Unavailable.into());
    }
    io::replace(dir, name, original, &bytes, MAX_FILE, cancel, check)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "synthetic fixture setup and custody assertions"
)]
mod tests {
    use super::*;

    #[test]
    fn aborted_publication_preserves_previous_bytes() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = TrustedDirectory::open(root.path()).unwrap();
        let seed = b"{\"unrelated\":true}\n";
        std::fs::write(root.path().join(PROPOSALS), seed).unwrap();
        let cancel = Cancel::never();
        assert!(publish(
            &dir,
            PROPOSALS,
            Some(seed),
            &json!({"proposal":true}),
            &cancel,
            &|| Err(StoreError::Unavailable.into())
        )
        .is_err());
        assert_eq!(
            io::read(&dir, PROPOSALS, MAX_FILE, &cancel)
                .unwrap()
                .as_deref(),
            Some(seed.as_slice())
        );
        publish(
            &dir,
            PROPOSALS,
            Some(seed),
            &json!({"proposal":true}),
            &cancel,
            &|| Ok(()),
        )
        .unwrap();
        let after = io::read(&dir, PROPOSALS, MAX_FILE, &cancel)
            .unwrap()
            .unwrap();
        assert_eq!(after, b"{\"unrelated\":true}\n{\"proposal\":true}\n");
    }
}
