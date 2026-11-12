//! Original-primary knowledge publication, with consumable queue and retained audit evidence.
use super::*;
use crate::{
    capture::{knowledge_pending as queue, normal_store::StoreOutcome},
    ops::conflict_file as file,
    store::lock::{Lock, LockGuard},
};
use insert_state::{CurationReceipt, KnowledgeReceipt};
use std::{collections::HashSet, time::Duration};
const QUEUE: &str = "knowledge-pending.json";
const MAX_QUEUE: usize = 2 * 1024 * 1024;
/// Historical ordinary-store staging acknowledgement, never current queue membership or job completion.
#[derive(Debug)]
pub struct StoreKnowledgeResult {
    /// Original primary operation/memory ID.
    pub memory_id: String,
    /// Whether this operation originally published an entry retained by the capacity policy.
    pub staged: bool,
    /// Whether the retained knowledge intent was reused.
    pub replayed: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueueState {
    schema: u8,
    pending: Vec<Entry>,
    pending_count: usize,
    pending_overflow_count: usize,
    last_store_at: Option<String>,
    last_update_at: Option<String>,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    key: String,
    source_agent: String,
    memory_id: String,
    queued_at: String,
    reason: String,
    category: String,
    importance: f64,
}
pub(super) fn proposal(
    saved: &SavedInsert,
    plan: &NormalCandidatePlan,
    now: i64,
    cancel: &Cancel,
) -> Result<Option<String>, EngineError> {
    let ctx = &plan.context;
    let assessed = assess(
        &plan.params,
        StoreOwner {
            agent_id: ctx.agent_id.as_str(),
            owner_user_id: &ctx.owner_user_id,
            workspace_key: &ctx.workspace_key,
        },
        saved.assessed_at,
        cancel,
    )?;
    let cfg =
        crate::config::effective_config(&plan.config).map_err(|_| StoreError::InvalidInput)?;
    Ok(assessed
        .effects(
            StoreOutcome::Stored { id: &saved.row.id },
            now,
            cfg["schicht15"]["minImportance"].as_f64().unwrap_or(0.7),
            cancel,
        )?
        .into_external()?
        .knowledge_pending
        .map(|v| serde_json::to_string(&v).map_err(|_| StoreError::Corrupt))
        .transpose()?)
}
// Strict typed parsing rejects duplicate properties, legacy identities, and unrecognized metadata.
// The pure Node projection alone cannot authorize discarding any of those fields.
fn entries(raw: Option<&str>, cancel: &Cancel) -> Result<(Json, Vec<Entry>), EngineError> {
    let Some(raw) = raw else {
        return Ok((
            parse_json("{}").map_err(|_| StoreError::Corrupt)?,
            Vec::new(),
        ));
    };
    if raw.len() > MAX_QUEUE {
        return Err(StoreError::Unavailable.into());
    }
    let state: QueueState = serde_json::from_str(raw).map_err(|_| StoreError::Corrupt)?;
    if state.schema != 2
        || state.pending.len() > queue::CAP
        || state.pending_count != state.pending.len()
        || state.pending_overflow_count > queue::CAP
        || state.last_store_at.as_ref().is_some_and(|s| s.len() > 128)
        || state.last_update_at.as_ref().is_some_and(|s| s.len() > 128)
    {
        return Err(StoreError::Corrupt.into());
    }
    let mut keys = HashSet::new();
    for e in &state.pending {
        cancel.check()?;
        if e.source_agent.is_empty()
            || e.memory_id.is_empty()
            || e.queued_at.is_empty()
            || e.reason.is_empty()
            || e.category.is_empty()
            || !e.importance.is_finite()
            || e.key != format!("{}:{}", e.source_agent, e.memory_id)
            || !keys.insert(e.key.clone())
        {
            return Err(StoreError::Corrupt.into());
        }
    }
    let json = parse_json(raw).map_err(|_| StoreError::Corrupt)?;
    Ok((json, state.pending))
}
struct Transition {
    after: String,
    overflow: Option<String>,
    staged: bool,
    affected: Vec<Entry>,
}
fn transition(
    before: Option<&str>,
    proposal: &str,
    now: i64,
    cancel: &Cancel,
) -> Result<Transition, EngineError> {
    let (raw, old) = entries(before, cancel)?;
    let input = parse_json(proposal).map_err(|_| StoreError::Corrupt)?;
    let input_value: Value = serde_json::from_str(proposal).map_err(|_| StoreError::Corrupt)?;
    let change = queue::track(&raw, &input, now, cancel)?.ok_or(StoreError::Corrupt)?;
    let after = queue::encode(&change.state, cancel)?;
    let value: Value = serde_json::from_str(&after).map_err(|_| StoreError::Corrupt)?;
    let new = value["pending"].as_array().ok_or(StoreError::Corrupt)?;
    let normalized: Vec<Entry> =
        serde_json::from_value(value["pending"].clone()).map_err(|_| StoreError::Corrupt)?;
    let mut affected = Vec::new();
    for entry in old {
        // JSON number spelling (1 versus 1.0) is not a change in the Node queue value.
        let same = normalized
            .iter()
            .find(|v| v.key == entry.key)
            .is_some_and(|v| v == &entry);
        if !same {
            affected.push(entry);
        }
    }
    if after.len() > MAX_QUEUE {
        return Err(StoreError::Unavailable.into());
    }
    Ok(Transition {
        after,
        overflow: change.curation.map(|v| write_json(&v)),
        staged: new.iter().any(|v| v["key"] == input_value["key"]),
        affected,
    })
}
pub(in crate::ops::durable_merge) struct KnowledgeContext<'a> {
    pub workspace: &'a TrustedDirectory,
    pub store: &'a Store,
    pub context: &'a RequestContext,
}
impl<'a> From<&'a NormalCandidatePlan> for KnowledgeContext<'a> {
    fn from(plan: &'a NormalCandidatePlan) -> Self {
        Self {
            workspace: &plan.workspace,
            store: &plan.store,
            context: &plan.context,
        }
    }
}
pub(in crate::ops::durable_merge) struct Files {
    directory: Option<TrustedDirectory>,
    lock: Option<LockGuard>,
    pub(in crate::ops::durable_merge) frozen: KnowledgeReceipt,
    overflow: Option<curation::Files>,
}
impl Files {
    pub(in crate::ops::durable_merge) fn prepare(
        native: &NativeMerge,
        plan: &KnowledgeContext<'_>,
        proposal: Option<String>,
        now: i64,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        let mut frozen = KnowledgeReceipt {
            now_ms: now,
            directory: None,
            proposal,
            before: None,
            after: None,
            affected_sources: Vec::new(),
            overflow: None,
            staged: false,
            stage: 3,
        };
        if let Some(input) = &frozen.proposal {
            let directory = plan.workspace.open_child(".adaptive-learning")?;
            let lock = Self::lock(&directory)?;
            frozen.before = file::read(&directory, QUEUE, MAX_QUEUE, cancel)?
                .map(|v| String::from_utf8(v).map_err(|_| StoreError::Corrupt))
                .transpose()?;
            let change = transition(frozen.before.as_deref(), input, now, cancel)?;
            for entry in &change.affected {
                if entry.source_agent != plan.context.agent_id.as_str() {
                    return Err(StoreError::InvalidInput.into());
                }
                let row = plan
                    .store
                    .get_record(&entry.memory_id)?
                    .ok_or(StoreError::InvalidInput)?;
                native.private(&row, plan.context)?;
                state::bounded_row(&row.row, cancel)?;
                frozen.affected_sources.push(row.into());
            }
            frozen.directory = Some(directory_binding(&directory));
            frozen.after = Some(change.after);
            frozen.overflow = change.overflow;
            frozen.staged = change.staged;
            frozen.stage = 0;
            let overflow = Self::overflow(plan, &frozen)?;
            let files = Self {
                directory: Some(directory),
                lock: Some(lock),
                frozen,
                overflow,
            };
            files.validate(native, plan, cancel)?;
            return Ok(files);
        }
        Ok(Self {
            directory: None,
            lock: None,
            frozen,
            overflow: None,
        })
    }
    fn lock(dir: &TrustedDirectory) -> Result<LockGuard, EngineError> {
        Ok(Lock::try_acquire(
            &dir.path().join("knowledge-pending.lock"),
            Duration::from_secs(60),
            None,
        )?
        .ok_or(StoreError::Busy)?)
    }
    fn overflow(
        plan: &KnowledgeContext<'_>,
        frozen: &KnowledgeReceipt,
    ) -> Result<Option<curation::Files>, EngineError> {
        frozen
            .overflow
            .as_ref()
            .map(|event_json| {
                curation::Files::overflow(
                    plan.workspace,
                    CurationReceipt {
                        now_ms: frozen.now_ms,
                        directory: frozen.directory.clone().ok_or(StoreError::Corrupt)?,
                        event_json: event_json.clone(),
                        complete: frozen.stage >= 2,
                    },
                )
            })
            .transpose()
    }
    pub(in crate::ops::durable_merge) fn restore(
        native: &NativeMerge,
        plan: &KnowledgeContext<'_>,
        expected_proposal: Option<&str>,
        frozen: &KnowledgeReceipt,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        if frozen.stage > 3 || frozen.proposal.as_deref() != expected_proposal {
            return Err(StoreError::Corrupt.into());
        }
        let Some(input) = &frozen.proposal else {
            if frozen.stage != 3
                || frozen.staged
                || frozen.directory.is_some()
                || frozen.before.is_some()
                || frozen.after.is_some()
                || frozen.overflow.is_some()
                || !frozen.affected_sources.is_empty()
            {
                return Err(StoreError::Corrupt.into());
            }
            return Ok(Self {
                directory: None,
                lock: None,
                frozen: frozen.clone(),
                overflow: None,
            });
        };
        let change = transition(frozen.before.as_deref(), input, frozen.now_ms, cancel)?;
        if frozen.after.as_ref() != Some(&change.after)
            || frozen.overflow != change.overflow
            || frozen.staged != change.staged
            || frozen.affected_sources.len() != change.affected.len()
        {
            return Err(StoreError::Corrupt.into());
        }
        for (entry, source) in change.affected.iter().zip(&frozen.affected_sources) {
            if entry.memory_id != source.row.id
                || entry.source_agent != plan.context.agent_id.as_str()
            {
                return Err(StoreError::Corrupt.into());
            }
            state::bounded_row(&source.row, cancel)?;
        }
        let directory = plan.workspace.open_child(".adaptive-learning")?;
        if frozen.directory.as_ref() != Some(&directory_binding(&directory)) {
            return Err(StoreError::UntrustedPath.into());
        }
        // A completed queue may already have been consumed; never acquire or resurrect it.
        let lock = if frozen.stage < 3 {
            Some(Self::lock(&directory)?)
        } else {
            None
        };
        let files = Self {
            directory: Some(directory),
            lock,
            frozen: frozen.clone(),
            overflow: Self::overflow(plan, frozen)?,
        };
        files.validate(native, plan, cancel)?;
        Ok(files)
    }
    pub(in crate::ops::durable_merge) fn validate(
        &self,
        native: &NativeMerge,
        plan: &KnowledgeContext<'_>,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        if let Some(dir) = &self.directory {
            dir.assert_unchanged()?;
        }
        if self.frozen.stage < 3 {
            if !self.lock.as_ref().is_some_and(LockGuard::is_owned) {
                return Err(StoreError::Busy.into());
            }
            self.validate_queue(self.frozen.stage > 0, cancel)?;
            for source in &self.frozen.affected_sources {
                native.private(&source.record(), plan.context)?;
                let row = plan
                    .store
                    .get_record(&source.row.id)?
                    .ok_or(StoreError::InvalidInput)?;
                native.private(&row, plan.context)?;
                if !source.same(&row)? {
                    return Err(StoreError::InvalidInput.into());
                }
            }
        }
        if let Some(overflow) = &self.overflow {
            overflow.validate(self.frozen.stage >= 2, cancel)?;
        }
        Ok(())
    }
    fn validate_queue(&self, written: bool, cancel: &Cancel) -> Result<(), EngineError> {
        let Some(dir) = &self.directory else {
            return Ok(());
        };
        let actual = file::read(dir, QUEUE, MAX_QUEUE, cancel)?;
        let actual = actual.as_deref();
        let after = self.frozen.after.as_deref().map(str::as_bytes);
        let before = self.frozen.before.as_deref().map(str::as_bytes);
        if actual != after && (written || actual != before) {
            return Err(StoreError::Corrupt.into());
        }
        Ok(())
    }
    pub(in crate::ops::durable_merge) fn validate_written(
        &self,
        stage: u8,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        self.validate_queue(true, cancel)?;
        if stage >= 2 {
            if let Some(overflow) = &self.overflow {
                overflow.validate(true, cancel)?;
            }
        }
        Ok(())
    }
    pub(in crate::ops::durable_merge) fn publish(
        &self,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        check()?;
        let dir = self.directory.as_ref().ok_or(StoreError::Corrupt)?;
        let old = file::read(dir, QUEUE, MAX_QUEUE, cancel)?;
        let after = self
            .frozen
            .after
            .as_deref()
            .ok_or(StoreError::Corrupt)?
            .as_bytes();
        if old.as_deref() != Some(after) {
            file::replace(dir, QUEUE, old.as_deref(), after, cancel, check)?;
        }
        self.validate_queue(true, cancel)
    }
    pub(in crate::ops::durable_merge) fn publish_overflow(
        &self,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        check()?;
        if let Some(files) = &self.overflow {
            files.publish(cancel, check)?;
        }
        Ok(())
    }
}
impl NativeMerge {
    /// Stage knowledge only for the original completed ordinary primary and curation receipt.
    /// No promotion job is executed; completed retries never reinsert consumed queue entries.
    pub fn publish_store_knowledge(
        &self,
        operation_id: Uuid,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<StoreKnowledgeResult, EngineError> {
        if operation_id.is_nil() {
            return Err(StoreError::InvalidInput.into());
        }
        let saved = {
            let op = self.reader.context.enter(principal, agent)?;
            let _gate = self.reader.context.mutation()?;
            self.journal.with_normal_store_writer(
                principal,
                agent,
                &op.context,
                cancel,
                &|| self.reader.context.assert_open(),
                |dir, _, binding, check| {
                    CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                    crate::ops::durable_merge_state::guard_pending(dir, cancel)?;
                    crate::ops::conflict_application_state::guard_pending(dir, cancel)?;
                    let name = format!(
                        "native-normal-store-{}.json",
                        hash(format!("{binding}:{operation_id}").as_bytes())
                    );
                    let receipt = insert_state::receipts(dir, cancel)?
                        .into_iter()
                        .find(|(n, _, _)| n == &name)
                        .ok_or(StoreError::InvalidInput)?
                        .1;
                    if receipt.stage != 2 || !receipt.curation.as_ref().is_some_and(|c| c.complete)
                    {
                        return Err(StoreError::InvalidInput.into());
                    }
                    let (saved, _, _) = restore_insert(&receipt.plan, cancel)?;
                    check()?;
                    Ok(saved)
                },
            )?
        };
        let plan = self.restore_insert_plan(&saved, principal, agent, cancel)?;
        let result = self.insert_selected(
            &plan,
            operation_id,
            principal,
            agent,
            cancel,
            InsertMode {
                existing_only: true,
                knowledge: true,
                ..InsertMode::default()
            },
        )?;
        Ok(StoreKnowledgeResult {
            memory_id: result.primary.memory_id,
            staged: result.knowledge_staged,
            replayed: result.knowledge_replayed,
        })
    }
}

pub(in crate::ops::durable_merge) fn for_promotion(
    raw: Option<&str>,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    entries(raw, cancel).map(|(json, _)| json)
}
pub(in crate::ops::durable_merge) fn check_promotion_cleanup(
    before: Option<&str>,
    after: &str,
    agent: &str,
    ids: &[String],
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let (_, old) = entries(before, cancel)?;
    let (_, new) = entries(Some(after), cancel)?;
    for entry in &old {
        if let Some(retained) = new.iter().find(|n| n.key == entry.key) {
            if retained != entry {
                return Err(StoreError::Corrupt.into());
            }
        } else if entry.source_agent != agent || !ids.contains(&entry.memory_id) {
            return Err(StoreError::InvalidInput.into());
        }
    }
    if new.iter().any(|n| !old.iter().any(|o| o.key == n.key)) {
        return Err(StoreError::Corrupt.into());
    }
    Ok(())
}

/// A Node cleanup proposal is not authority: retain entries whose source cannot be proved visible.
pub(in crate::ops::durable_merge) fn restrict_promotion_cleanup(
    before: Option<&str>,
    after: &str,
    agent: &str,
    authorized: &[String],
    now: i64,
    cancel: &Cancel,
) -> Result<Option<String>, EngineError> {
    let (raw, old) = entries(before, cancel)?;
    let (_, new) = entries(Some(after), cancel)?;
    let removed: Vec<_> = old
        .iter()
        .filter(|entry| !new.iter().any(|next| next.key == entry.key))
        .collect();
    if removed
        .iter()
        .all(|entry| entry.source_agent == agent && authorized.contains(&entry.memory_id))
    {
        return Ok(Some(after.into()));
    }
    let permitted: Vec<_> = removed
        .into_iter()
        .filter(|entry| entry.source_agent == agent && authorized.contains(&entry.memory_id))
        .map(|entry| JsString::from(entry.key.as_str()))
        .collect();
    if permitted.is_empty() {
        return Ok(None);
    }
    let restricted = queue::encode(&queue::remove(&raw, &permitted, &[], now, cancel)?, cancel)?;
    check_promotion_cleanup(before, &restricted, agent, authorized, cancel)?;
    Ok(Some(restricted))
}
