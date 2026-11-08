//! Principal-bound Neo capture with a frozen durable plan and idempotent replay.
//! Each record is durable independently. A batch is acknowledged only after all journals and
//! the candidate index are published. Runtime capture-hook activation is separate.
use super::{
    capture_plan,
    derived_fields::{object, text},
    journal_io::{self, FILES},
    merged::{optional, Layout},
};
use crate::{
    capture::{shared_scope::CapturePolicy, wal::kernel_lock},
    context::{is_user_principal, RequestContext},
    contract::{
        AgentContext, Cancel, EngineError, HostServices, Principal, StoreError, TurnRecord,
    },
    store::{
        atomic_write::atomic_write,
        directory::TrustedDirectory,
        lock::{Lock, LockGuard},
    },
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use chrono::{SecondsFormat, TimeZone, Utc};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

#[path = "capture_interference_recovery.rs"]
mod interference_recovery;
#[path = "capture_recovery.rs"]
mod recovery;
#[path = "capture_revision_recovery.rs"]
mod revision_recovery;
#[path = "capture_transaction.rs"]
mod transaction;

/// Numbers of newly persisted records in this call, excluding replayed existing records.
#[derive(Default, Debug)]
pub struct JournalResult {
    /// Conversation turns.
    pub turns: usize,
    /// Memory candidates.
    pub candidates: usize,
    /// User reactions.
    pub reactions: usize,
    /// Behavior cards.
    pub behavior: usize,
    /// Embedding queue entries (not generated embeddings).
    pub queued: usize,
}
impl JournalResult {
    fn total(&self) -> usize {
        self.turns + self.candidates + self.reactions + self.behavior + self.queued
    }
}
struct Binding {
    ctx: RequestContext,
    workspace: TrustedDirectory,
    proof: Json,
    file: String,
    layout: Layout,
}
/// Trusted root plus actual host/policy adapters. Opening creates no persistent state.
pub struct CaptureJournal {
    root: TrustedDirectory,
    host: Arc<dyn HostServices>,
    policy: Arc<dyn CapturePolicy>,
}
impl CaptureJournal {
    /// Hold an existing physical Neo root. No caller-supplied row grants authority.
    pub fn open(
        root: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            root: TrustedDirectory::open(root)?,
            host,
            policy,
        })
    }
    fn bind(&self, principal: &Principal, agent: &AgentContext) -> Result<Binding, EngineError> {
        self.root.assert_unchanged()?;
        let path = self
            .host
            .workspace_dir(&principal.agent_id)?
            .ok_or(StoreError::InvalidInput)?;
        let ctx = RequestContext::build(principal, agent, self.host.as_ref())?;
        if ctx.workspace_key.is_empty()
            || !is_user_principal(&ctx.owner_user_id)
            || self.host.workspace_dir(&principal.agent_id)?.as_ref() != Some(&path)
        {
            return Err(StoreError::InvalidInput.into());
        }
        if !self.policy.allowed(&ctx)? {
            return Err(StoreError::Unavailable.into());
        }
        let workspace = TrustedDirectory::open(&path)?;
        let mut proof = object(vec![
            ("version", Json::Number("1".into())),
            ("agentId", text(ctx.agent_id.as_str())),
            ("ownerUserId", text(&ctx.owner_user_id)),
            ("workspaceIdentity", text(&ctx.workspace_key)),
            (
                "workspaceDirectory",
                text(workspace.path().to_str().ok_or(StoreError::InvalidInput)?),
            ),
            (
                "neoRoot",
                text(self.root.path().to_str().ok_or(StoreError::InvalidInput)?),
            ),
        ]);
        let digest = format!("{:x}", Sha256::digest(write_json(&proof).as_bytes()));
        for (name, dir) in [
            ("workspaceFileIdentity", &workspace),
            ("neoRootFileIdentity", &self.root),
        ] {
            let (volume, inode) = dir.identity_parts();
            super::derived_fields::set(&mut proof, name, text(&format!("{volume:x}:{inode:x}")))?;
        }
        Ok(Binding {
            layout: Layout::for_key(&ctx.workspace_key),
            ctx,
            workspace,
            proof,
            file: format!("native-capture-pending-{digest}.json"),
        })
    }
    fn directory(
        &self,
        binding: &Binding,
        create: bool,
    ) -> Result<Option<TrustedDirectory>, StoreError> {
        if create {
            return Ok(Some(
                self.root
                    .create_child("workspaces")?
                    .create_child(&binding.layout.canonical)?,
            ));
        }
        let Some(parent) = optional(self.root.open_child("workspaces"))? else {
            return Ok(None);
        };
        optional(parent.open_child(&binding.layout.canonical))
    }
    fn check(
        &self,
        binding: &Binding,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        binding.workspace.assert_unchanged()?;
        let current = self.bind(principal, agent)?;
        if current.proof != binding.proof || current.ctx != binding.ctx {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
    /// Persist selected visible messages. Incognito does not acquire locks or create files.
    /// On an error after publication starts, replay retains the original timestamp and IDs.
    pub fn record(
        &self,
        turn: &TurnRecord,
        expected: &RequestContext,
        cancel: &Cancel,
    ) -> Result<JournalResult, EngineError> {
        if turn.incognito {
            return Ok(JournalResult::default());
        }
        cancel.check()?;
        turn.cancel.check()?;
        let binding = self.bind(&turn.principal, &turn.agent)?;
        if &binding.ctx != expected || turn.agent_id != binding.ctx.agent_id {
            return Err(StoreError::InvalidInput.into());
        }
        let directory = self
            .directory(&binding, true)?
            .ok_or(StoreError::Unavailable)?;
        self.with_locks(
            &binding,
            &directory,
            &turn.principal,
            &turn.agent,
            cancel,
            |check| {
                let check = || -> Result<(), EngineError> {
                    turn.cancel.check()?;
                    check()
                };
                super::revision_io::guard_pending(&directory, cancel)?;
                self.replay(&binding, &directory, cancel, &check)?;
                check()?;
                // Prepared embedding metadata must settle before a new capture can change its
                // sources. EpisodeStore/EmbeddingDrain startup recovery owns that ordering.
                let pending = binding
                    .file
                    .replace("native-capture-pending-", "native-embedding-pending-");
                if super::episode_io::read(&directory, &pending, &binding.proof, cancel)?.is_some()
                {
                    return Err(StoreError::Busy.into());
                }
                let now = Utc
                    .timestamp_millis_opt(self.host.now_ms())
                    .single()
                    .ok_or(StoreError::InvalidInput)?
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
                let plan = capture_plan::build(
                    turn,
                    &binding.ctx,
                    &directory,
                    &JsString::from(now.as_str()),
                    cancel,
                )?;
                if plan.iter().all(Vec::is_empty) {
                    return Ok(JournalResult::default());
                }
                check()?;
                preflight(&directory, &plan, &binding.ctx, cancel)?;
                journal_io::write_plan(
                    &directory,
                    &binding.file,
                    &binding.proof,
                    &plan,
                    &super::caller::encode(&turn.principal, &turn.agent)?,
                )?;
                self.replay(&binding, &directory, cancel, &check)
            },
        )
    }
    /// Resume this principal's pending plan. No ownerless or foreign pending state is adopted.
    pub fn recover(
        &self,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
    ) -> Result<usize, EngineError> {
        cancel.check()?;
        let binding = self.bind(principal, agent)?;
        let Some(directory) = self.directory(&binding, false)? else {
            return Ok(0);
        };
        if journal_io::read_plan(&directory, &binding.file, &binding.proof, cancel)?.is_none() {
            return Ok(0);
        }
        self.with_locks(&binding, &directory, principal, agent, cancel, |check| {
            super::revision_io::guard_pending(&directory, cancel)?;
            self.replay(&binding, &directory, cancel, check)
                .map(|r| r.total())
        })
    }
    /// Authorized composition under the existing native and interoperable Neo writer leases.
    pub(super) fn transaction<T>(
        &self,
        turn: &TurnRecord,
        expected: &RequestContext,
        cancel: &Cancel,
        action: impl FnOnce(
            &TrustedDirectory,
            &Json,
            &str,
            &dyn Fn() -> Result<(), EngineError>,
        ) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        turn.cancel.check()?;
        if turn.agent_id != expected.agent_id || turn.incognito {
            return Err(StoreError::InvalidInput.into());
        }
        self.with_writer(
            &turn.principal,
            &turn.agent,
            expected,
            cancel,
            &|| {
                turn.cancel.check()?;
                Ok(())
            },
            action,
        )
    }

    /// Restored metadata is only a candidate identity: current host binding/policy must prove it.
    pub(super) fn authorize_caller(
        &self,
        caller: &super::caller::Caller,
        proof: &Json,
        cancel: &Cancel,
    ) -> Result<RequestContext, EngineError> {
        cancel.check()?;
        let binding = self.bind(&caller.principal, &caller.agent)?;
        if &binding.proof != proof {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(binding.ctx)
    }
    fn with_locks<T>(
        &self,
        binding: &Binding,
        directory: &TrustedDirectory,
        principal: &Principal,
        agent: &AgentContext,
        cancel: &Cancel,
        action: impl FnOnce(&dyn Fn() -> Result<(), EngineError>) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(300));
        self.check(binding, principal, agent, &cancel)?;
        let locks = directory.create_child(".native-capture-leases")?;
        let kernel = kernel_lock::acquire(&locks, "workspace", &cancel, &mut || {})?;
        let neo: LockGuard = loop {
            self.check(binding, principal, agent, &cancel)?;
            directory.assert_unchanged()?;
            if let Some(guard) = Lock::try_acquire_neo(
                &directory.path().join(".neo-write.lock"),
                Duration::from_secs(300),
            )? {
                break guard;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let check = || -> Result<(), EngineError> {
            self.check(binding, principal, agent, &cancel)?;
            directory.assert_unchanged()?;
            locks.assert_unchanged()?;
            kernel.check(&locks)?;
            if !neo.is_neo_owned() {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        check()?;
        action(&check)
    }
    fn replay(
        &self,
        binding: &Binding,
        directory: &TrustedDirectory,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<JournalResult, EngineError> {
        let Some(plan) = journal_io::read_plan(directory, &binding.file, &binding.proof, cancel)?
        else {
            return Ok(JournalResult::default());
        };
        if plan.records.iter().all(Vec::is_empty) {
            return Ok(JournalResult::default());
        }
        let caller = super::caller::decode(&plan.caller)?;
        let original = self.authorize_caller(&caller, &binding.proof, cancel)?;
        let check = || -> Result<(), EngineError> {
            check()?;
            if self.authorize_caller(&caller, &binding.proof, cancel)? != original {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        check()?;
        let plan = plan.records;
        let existing = preflight(directory, &plan, &original, cancel)?;
        let mut counts = [0; 5];
        for (index, group) in plan.iter().enumerate() {
            if let Some(bytes) = journal_io::bytes(directory, FILES[index], cancel)? {
                let committed = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
                if committed < bytes.len() {
                    check()?;
                    directory.truncate_jsonl_tail(
                        FILES[index],
                        bytes.len() as u64,
                        committed as u64,
                    )?;
                }
            }
            let mut ids = existing[index]
                .iter()
                .map(journal_io::id)
                .collect::<Result<std::collections::HashSet<_>, _>>()?;
            for row in group {
                if ids.insert(journal_io::id(row)?) {
                    check()?;
                    directory.append_jsonl_durable(FILES[index], row, journal_io::MAX_BYTES)?;
                    counts[index] += 1;
                }
            }
            if !group.is_empty() {
                check()?;
                directory.sync_file_durable(FILES[index])?;
            }
        }
        // Rebuild from current authoritative candidates, never the stale plan's candidate snapshot.
        // The global index intentionally outlives capped journal history. Preserve its older
        // entries, then merge current source revisions by time so replay cannot resurrect a card.
        let mut candidates = journal_io::rows(directory, "candidate-index.jsonl", cancel)?;
        candidates.extend(journal_io::rows(directory, FILES[1], cancel)?);
        let candidates = journal_io::latest(candidates)?;
        let mut index = String::new();
        for candidate in candidates {
            if let Some(row) = super::candidate_index::project(&candidate)? {
                index.push_str(&write_json(&row));
                index.push('\n');
                if index.len() > journal_io::MAX_BYTES {
                    return Err(StoreError::Corrupt.into());
                }
            }
        }
        check()?;
        if journal_io::bytes(directory, "candidate-index.jsonl", cancel)?.as_deref()
            != Some(index.as_bytes())
        {
            atomic_write(
                &directory.path().join("candidate-index.jsonl"),
                index.as_bytes(),
            )
            .map_err(StoreError::from)?;
        }
        check()?;
        let compatibility = super::journal_index::project(directory, cancel)?;
        if write_json(&compatibility).len() + 1 > journal_io::MAX_BYTES {
            return Err(StoreError::Corrupt.into());
        }
        check()?;
        crate::store::state_file::StateFile::store(
            &directory.path().join("record-index.json"),
            &compatibility,
        )?;
        check()?;
        journal_io::write_plan(
            directory,
            &binding.file,
            &binding.proof,
            &vec![Vec::new(); FILES.len()],
            &Json::Null,
        )?;
        Ok(JournalResult {
            turns: counts[0],
            candidates: counts[1],
            reactions: counts[2],
            behavior: counts[3],
            queued: counts[4],
        })
    }
}

fn preflight(
    directory: &TrustedDirectory,
    plan: &[Vec<Json>],
    ctx: &RequestContext,
    cancel: &Cancel,
) -> Result<Vec<Vec<Json>>, EngineError> {
    let mut existing = Vec::new();
    // Validate the complete plan and every collision before any source journal mutation.
    for (index, group) in plan.iter().enumerate() {
        let rows = journal_io::rows(directory, FILES[index], cancel)?;
        let mut ids = std::collections::HashMap::new();
        for row in &rows {
            let owned = journal_io::owned(row, ctx);
            ids.entry(journal_io::id(row)?)
                .and_modify(|v| *v &= owned)
                .or_insert(owned);
        }
        let mut count = rows.len();
        let mut size = journal_io::bytes(directory, FILES[index], cancel)?.map_or(0, |b| b.len());
        for row in group {
            cancel.check()?;
            if !journal_io::owned(row, ctx) {
                return Err(StoreError::Corrupt.into());
            }
            let id = journal_io::id(row)?;
            match ids.insert(id, true) {
                Some(false) => return Err(StoreError::InvalidInput.into()),
                Some(true) => (),
                None => {
                    count += 1;
                    size += write_json(row).len() + 1;
                }
            }
            if count > journal_io::MAX_ROWS || size > journal_io::MAX_BYTES {
                return Err(StoreError::InvalidInput.into());
            }
        }
        existing.push(rows);
    }
    Ok(existing)
}
