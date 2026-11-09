//! Caller-bound A1 publication. The atomic source marker is the commit receipt, as in Node.
use super::{
    conflict_file as io,
    context::error,
    durable_merge::{check_promotion_cleanup, knowledge_queue_for_promotion},
    interference_state::Record,
    memory::{MemoryReader, ReadSource, SourceKind},
    promotion_plan::{self, PromotionInput},
};
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, Cancel, EngineError, MemoryOpErrorCode, MemoryPromotionResult, Principal,
        StoreError,
    },
    neo::capture_journal::CaptureJournal,
    recall::acl::AclSubject,
    store::{directory::TrustedDirectory, lock::Lock, shared_row::MemoryRecord},
    text::json::parse_json,
};
use std::{path::PathBuf, sync::Arc, time::Duration};
#[cfg(feature = "testkit")]
type Observer = Arc<dyn Fn(&str) -> Result<(), EngineError> + Send + Sync>;
/// Deterministic publisher sharing the actual foreground/capture writer fence.
pub struct NativePromotion {
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
    #[cfg(feature = "testkit")]
    observer: Option<Observer>,
}
impl NativePromotion {
    /// Retain native ownership/lifecycle and policy-bound writer services; no I/O at construction.
    pub fn new(reader: Arc<MemoryReader>, journal: Arc<CaptureJournal>) -> Self {
        Self {
            reader,
            journal,
            #[cfg(feature = "testkit")]
            observer: None,
        }
    }
    /// Test-only observation boundary; never a production approval or bypass.
    #[cfg(feature = "testkit")]
    #[must_use]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    fn observe(&self, phase: &str) -> Result<(), EngineError> {
        #[cfg(feature = "testkit")]
        if let Some(observer) = &self.observer {
            observer(phase)?;
        }
        let _ = phase;
        Ok(())
    }
    /// Publish explicit IDs from a foreground human/system caller. No provider is consulted.
    /// Retries consult committed source markers; queue cleanup never duplicates the Markdown.
    pub fn run(
        &self,
        ids: &[String],
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<MemoryPromotionResult, EngineError> {
        cancel.check()?;
        let operation = self.reader.context.enter(principal, agent)?;
        let ctx = &operation.context;
        if ctx.background() || !matches!(ctx.origin_wire(), "user" | "system") {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        let raw = serde_json::to_value(self.reader.context.host().config())
            .map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let now = self.reader.context.host().now_ms();
        let subject = AclSubject::from_context(ctx);
        let empty = parse_json("{}").map_err(|_| StoreError::Corrupt)?;
        // Preflight the exact A1 bounds without opening or leasing a source or creating publication files.
        let preflight = promotion_plan::plan(
            &PromotionInput {
                context: &subject,
                config: &config,
                ids: Some(ids),
                pending: &empty,
                content: None,
                now,
                lock_busy: true,
            },
            cancel,
            |_| Err(StoreError::Corrupt.into()),
            || Ok(()),
        )?;
        let path = self
            .reader
            .context
            .host()
            .workspace_dir(&ctx.agent_id)?
            .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))?;
        let workspace = TrustedDirectory::open(&path)?;
        let base = TrustedDirectory::open(&self.reader.base)?;
        let _gate = self.reader.context.mutation()?;
        let extra = || {
            cancel.check()?;
            self.reader.context.assert_open()?;
            workspace.assert_unchanged()?;
            base.assert_unchanged()?;
            if RequestContext::build(principal, agent, self.reader.context.host())? != *ctx
                || self
                    .reader
                    .context
                    .host()
                    .workspace_dir(&ctx.agent_id)?
                    .as_deref()
                    != Some(workspace.path())
                || serde_json::to_value(self.reader.context.host().config())
                    .map_err(|_| StoreError::Corrupt)?
                    != raw
            {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        self.journal.with_operation_writer(
            principal,
            agent,
            ctx,
            cancel,
            &extra,
            |dir, _, _, check| {
                CaptureJournal::guard_non_merge_pending(dir, cancel)?;
                check()?;
                if config["schicht15"]["enabled"] == false {
                    return Ok(preflight.result);
                }
                let adaptive = workspace.create_child(".adaptive-learning")?;
                let Some(update_lock) = Lock::try_acquire(
                    &adaptive.path().join("knowledge-update.lock"),
                    Duration::from_secs(300),
                    None,
                )?
                else {
                    return Ok(preflight.result);
                };
                let pending_lock = Lock::try_acquire(
                    &adaptive.path().join("knowledge-pending.lock"),
                    Duration::from_secs(60),
                    None,
                )?
                .ok_or(StoreError::Busy)?;
                let guarded = || {
                    check()?;
                    adaptive.assert_unchanged()?;
                    if !update_lock.is_owned() || !pending_lock.is_owned() {
                        return Err(StoreError::Busy.into());
                    }
                    Ok(())
                };
                guarded()?;
                let queue_before =
                    io::read(&adaptive, "knowledge-pending.json", 2 * 1024 * 1024, cancel)?;
                let queue_text = queue_before
                    .as_deref()
                    .map(std::str::from_utf8)
                    .transpose()
                    .map_err(|_| StoreError::Corrupt)?;
                let pending = knowledge_queue_for_promotion(queue_text, cancel)?;
                let memory = workspace.create_child("memory")?;
                let before = io::read(&memory, "KNOWLEDGE.md", io::MAX_BYTES, cancel)?;
                let text = before
                    .as_deref()
                    .map(std::str::from_utf8)
                    .transpose()
                    .map_err(|_| StoreError::Corrupt)?;
                let sources = self.sources(ctx)?;
                let source_bindings = bindings(&sources)?;
                let mut snapshots = Vec::new();
                let planned = promotion_plan::plan(
                    &PromotionInput {
                        context: &subject,
                        config: &config,
                        ids: Some(ids),
                        pending: &pending,
                        content: text,
                        now,
                        lock_busy: false,
                    },
                    cancel,
                    |id| {
                        let snapshot = self.snapshot(&sources, id, ctx)?;
                        let row = snapshot
                            .raw
                            .as_ref()
                            .filter(|_| snapshot.visible)
                            .map(|(_, r)| r.row.clone());
                        snapshots.push(snapshot);
                        Ok(row)
                    },
                    &guarded,
                )?;
                if let Some(queue) = &planned.queue {
                    check_promotion_cleanup(queue_text, queue, ctx.agent_id.as_str(), ids, cancel)?;
                }
                let outcomes =
                    serde_json::to_value(&planned.result).map_err(|_| StoreError::Corrupt)?;
                let promoted = outcomes["items"]
                    .as_array()
                    .ok_or(StoreError::Corrupt)?
                    .iter()
                    .filter(|item| item["outcome"] == "promoted")
                    .filter_map(|item| item["id"].as_str())
                    .collect::<std::collections::HashSet<_>>();
                let current = || {
                    guarded()?;
                    memory.assert_unchanged()?;
                    let sources = self.sources(ctx)?;
                    if bindings(&sources)? != source_bindings {
                        return Err(StoreError::UntrustedPath.into());
                    }
                    for old in &snapshots {
                        let new = self.snapshot(&sources, &old.id, ctx)?;
                        if promoted.contains(old.id.as_str())
                            && new.raw.as_ref().is_none_or(|(_, r)| {
                                !crate::recall::lifecycle::is_recall_entry_live(
                                    &r.row,
                                    self.reader.context.host().now_ms(),
                                    None,
                                )
                            })
                        {
                            return Err(StoreError::Unavailable.into());
                        }
                        if !old.same(&new)? {
                            return Err(StoreError::Corrupt.into());
                        }
                    }
                    Ok(())
                };
                current()?;
                if let Some(markdown) = planned.markdown.as_ref() {
                    self.observe("promotion-before-document")?;
                    io::replace(
                        &memory,
                        "KNOWLEDGE.md",
                        before.as_deref(),
                        markdown.as_bytes(),
                        cancel,
                        &current,
                    )?;
                    self.observe("promotion-document-committed")?;
                    current()?;
                    if io::read(&memory, "KNOWLEDGE.md", io::MAX_BYTES, cancel)?.as_deref()
                        != Some(markdown.as_bytes())
                    {
                        return Err(StoreError::Corrupt.into());
                    }
                }
                if let Some(queue) = planned.queue.as_ref() {
                    self.observe("promotion-before-queue")?;
                    current()?;
                    // A removed/edited marker is never an acknowledgement authorizing queue cleanup.
                    let expected = planned
                        .markdown
                        .as_ref()
                        .map(String::as_bytes)
                        .or(before.as_deref());
                    if io::read(&memory, "KNOWLEDGE.md", io::MAX_BYTES, cancel)?.as_deref()
                        != expected
                    {
                        return Err(StoreError::Corrupt.into());
                    }
                    io::replace(
                        &adaptive,
                        "knowledge-pending.json",
                        queue_before.as_deref(),
                        queue.as_bytes(),
                        cancel,
                        &current,
                    )?;
                    self.observe("promotion-queue-committed")?;
                    if io::read(&adaptive, "knowledge-pending.json", 2 * 1024 * 1024, cancel)?
                        .as_deref()
                        != Some(queue.as_bytes())
                        || io::read(&memory, "KNOWLEDGE.md", io::MAX_BYTES, cancel)?.as_deref()
                            != expected
                    {
                        return Err(StoreError::Corrupt.into());
                    }
                }
                current()?;
                Ok(planned.result)
            },
        )
    }
    fn sources(&self, ctx: &RequestContext) -> Result<Vec<ReadSource>, EngineError> {
        let sources = self
            .reader
            .stores
            .sources(ctx)?
            .into_iter()
            .filter(|s| s.kind == SourceKind::Private)
            .collect::<Vec<_>>();
        if sources.is_empty() || sources.len() > 64 || sources.iter().any(|s| s.optional) {
            return Err(StoreError::Unavailable.into());
        }
        Ok(sources)
    }
    fn snapshot(
        &self,
        sources: &[ReadSource],
        id: &str,
        ctx: &RequestContext,
    ) -> Result<Snapshot, EngineError> {
        for (index, source) in sources.iter().enumerate() {
            if let Some(record) = source.store.get_record(id)? {
                if record.row.id != id
                    || record.sharing.is_some() && record.row.scope == "agent-private"
                {
                    return Err(StoreError::Corrupt.into());
                }
                let visible = self.reader.source_visible(&record, ctx)?;
                return Ok(Snapshot {
                    id: id.to_owned(),
                    raw: Some((index, record.into())),
                    visible,
                });
            }
        }
        Ok(Snapshot {
            id: id.to_owned(),
            raw: None,
            visible: false,
        })
    }
}
type Binding = (PathBuf, (u64, u64));
fn bindings(sources: &[ReadSource]) -> Result<Vec<Binding>, EngineError> {
    sources
        .iter()
        .map(|s| s.store.physical_binding().map_err(Into::into))
        .collect()
}
struct Snapshot {
    id: String,
    raw: Option<(usize, Record)>,
    visible: bool,
}
impl Snapshot {
    fn same(&self, other: &Self) -> Result<bool, EngineError> {
        if self.visible != other.visible {
            return Ok(false);
        }
        match (&self.raw, &other.raw) {
            (None, None) => Ok(true),
            (Some((i, a)), Some((j, b))) => Ok(i == j
                && a.same(&MemoryRecord {
                    row: b.row.clone(),
                    sharing: b.sharing.clone(),
                })?),
            _ => Ok(false),
        }
    }
}
