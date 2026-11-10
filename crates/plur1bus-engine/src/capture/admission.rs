//! Original capture input retained independently of the Node-compatible row-ID WAL.
//! A source record is private recovery material, never a grant or an inferred new message.
use super::pipeline::{CapturePostStore, ReminderEffect};
use super::{
    replay_guard::turn_key_of,
    shared_scope::{CapturePolicy, PolicyDecision},
    wal::kernel_lock,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, CaptureOptions, EngineError, HostServices, StoreError, TurnRecord},
    store::{directory::TrustedDirectory, paths::secure_dir},
};
use serde::{Deserialize, Serialize};
#[path = "admission_io.rs"]
mod io;
pub(super) use io::row_digest;
use io::{read, read_with_budget, validate, write};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
pub(super) const MAX_BYTES: usize = 64 * 1024 * 1024;
/// Open records per owner scope (agent and owner); other owners never count (RE-D159).
const MAX_PENDING: usize = 512;

/// The owner scope of a retained record: a digest of agent and owner, never content.
pub(super) fn scope_of(agent: &str, owner: &str) -> Result<String, StoreError> {
    Ok(digest(&(agent, owner))?[..16].to_owned())
}
/// `<scope16>-<hash64>.json`: the owner scope and the hash of agent and turn key.
fn name_parts(name: &str) -> Option<(&str, &str)> {
    let (scope, hash) = name.strip_suffix(".json")?.split_once('-')?;
    let hex = |value: &str, len: usize| {
        value.len() == len
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    (hex(scope, 16) && hex(hash, 64)).then_some((scope, hash))
}
/// A file name written before RE-D159 (`<hash64>.json`).
fn legacy_name(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
/// Names of one owner scope's files and the bytes they occupy, from directory metadata only.
struct Usage {
    names: Vec<String>,
    bytes: u64,
    /// Another owner retains a record for the same agent and turn key.
    collision: bool,
}
/// The admission directory's files grouped by owner scope; nothing is opened.
pub(super) struct Inventory {
    pub scopes: BTreeMap<String, Vec<String>>,
    /// Files no scope can be attributed to: kept, reported, never read again.
    pub unattributable: usize,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Proof {
    agent: String,
    owner: String,
    caller: String,
    workspace: String,
    workspace_path: Option<PathBuf>,
    workspace_identity: Option<String>,
    root_path: PathBuf,
    root_identity: String,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Phase {
    Primary,
    PostStore,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Record {
    version: u32,
    proof: Proof,
    config: String,
    space: String,
    key: String,
    pub turn: TurnRecord,
    pub options: CaptureOptions,
    pub at_ms: i64,
    pub phase: Phase,
    pub post_at_ms: Option<i64>,
    /// Exact successfully built native rows, before their first upsert. Never authorize by ID alone.
    pub rows: BTreeMap<String, String>,
    pub row_order: Vec<String>,
    pub result: Option<crate::contract::CaptureResult>,
    pub classifier_started: bool,
    pub classifier_done: bool,
    pub neo_started: bool,
    pub neo_done: bool,
    pub reminders: BTreeMap<usize, ReminderEffect>,
    /// Post-store steps closed by a terminal refusal (RE-D155): fixed reasons only, no content.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub post_skipped: Vec<String>,
    /// Recovery attempts so far, counted before each attempt (RE-D156); bounded.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub recovery_attempts: u32,
}
#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde skip predicate signature"
)]
fn is_zero(value: &u32) -> bool {
    *value == 0
}
/// One structurally read admission file; semantic checks are per record (RE-D156).
pub(super) enum Entry {
    /// A well-formed record, not yet checked against the current host, policy or config.
    Record(Box<Record>),
    /// A file that is not a well-formed record: never recovered, never blocking others.
    Unreadable,
}
/// What the current host, policy and configuration allow for one retained record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Assessment {
    /// Recoverable under the current state.
    Ready,
    /// The workspace owner switched capture off: close and discard the retained input.
    Revoked,
    /// Temporary maintenance: keep pending without affecting anyone else.
    Maintenance,
    /// Recorded under another effective configuration or vector space.
    ConfigChanged,
    /// The workspace or root directory is not the recorded one.
    WorkspaceChanged,
    /// The caller now resolves to another agent, owner or principal.
    CallerChanged,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    record: Option<Record>,
}

pub(super) struct Admissions {
    base: PathBuf,
    host: Arc<dyn HostServices>,
    policy: Arc<dyn CapturePolicy>,
    config: String,
    space: String,
}
pub(super) struct Admission<'a> {
    owner: &'a Admissions,
    directory: TrustedDirectory,
    locks: TrustedDirectory,
    lease: kernel_lock::KernelLease,
    name: String,
    pub record: Record,
    closed: std::cell::Cell<bool>,
}
fn identity(dir: &TrustedDirectory) -> String {
    let (device, inode) = dir.identity_parts();
    format!("{device:x}:{inode:x}")
}
fn digest(value: &impl Serialize) -> Result<String, StoreError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|_| StoreError::InvalidInput)?)
    ))
}
impl Admissions {
    pub fn new(
        base: &Path,
        host: Arc<dyn HostServices>,
        policy: Arc<dyn CapturePolicy>,
        config: &serde_json::Value,
        space: String,
    ) -> Result<Self, StoreError> {
        Ok(Self {
            base: base.to_owned(),
            host,
            policy,
            config: digest(config)?,
            space,
        })
    }
    /// The caller's identity, without the workspace policy.
    fn identity_context(
        &self,
        turn: &TurnRecord,
        cancel: &Cancel,
    ) -> Result<RequestContext, EngineError> {
        cancel.check()?;
        if turn.incognito || turn.agent_id != turn.principal.agent_id {
            return Err(StoreError::InvalidInput.into());
        }
        let ctx = RequestContext::build(&turn.principal, &turn.agent, self.host.as_ref())?;
        if ctx.origin_wire() != "user" {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(ctx)
    }
    /// The workspace policy as a typed refusal: revocation and maintenance stay distinct.
    fn policy_allows(&self, ctx: &RequestContext) -> Result<(), EngineError> {
        match self.policy.decision(ctx)? {
            PolicyDecision::Allowed => Ok(()),
            PolicyDecision::Revoked => Err(EngineError::NotAvailable {
                reason: "workspace-policy-disabled".into(),
            }),
            PolicyDecision::Maintenance => Err(EngineError::NotAvailable {
                reason: "workspace-maintenance".into(),
            }),
        }
    }
    fn context(&self, turn: &TurnRecord, cancel: &Cancel) -> Result<RequestContext, EngineError> {
        let ctx = self.identity_context(turn, cancel)?;
        self.policy_allows(&ctx)?;
        Ok(ctx)
    }
    fn proof(
        &self,
        turn: &TurnRecord,
        dir: &TrustedDirectory,
        cancel: &Cancel,
    ) -> Result<Proof, EngineError> {
        let ctx = self.identity_context(turn, cancel)?;
        let path = self.host.workspace_dir(&turn.principal.agent_id)?;
        let workspace = path
            .as_ref()
            .map(|p| TrustedDirectory::open(p))
            .transpose()?;
        if path != self.host.workspace_dir(&turn.principal.agent_id)? {
            return Err(StoreError::InvalidInput.into());
        }
        dir.assert_unchanged()?;
        Ok(Proof {
            agent: ctx.agent_id.to_string(),
            owner: ctx.owner_user_id,
            caller: digest(&(&turn.principal, &turn.agent))?,
            workspace: ctx.workspace_key,
            workspace_path: workspace.as_ref().map(|d| d.path().to_owned()),
            workspace_identity: workspace.as_ref().map(identity),
            root_path: dir.path().to_owned(),
            root_identity: identity(dir),
        })
    }
    fn filename(&self, record: &Record) -> Result<String, StoreError> {
        // Caller, workspace and physical IDs are checked in the record, not included in the
        // name: another chat of the owner, or a restored pathname, finds the old record and
        // refuses it rather than silently starting fresh.
        Ok(format!(
            "{}-{}.json",
            scope_of(&record.proof.agent, &record.proof.owner)?,
            digest(&(&record.proof.agent, &record.key))?
        ))
    }
    /// The owner scope a turn's caller resolves to (a host lookup, no policy).
    pub fn scope_for(&self, turn: &TurnRecord, cancel: &Cancel) -> Result<String, EngineError> {
        let ctx = self.identity_context(turn, cancel)?;
        Ok(scope_of(ctx.agent_id.as_str(), &ctx.owner_user_id)?)
    }
    /// One scope's files from directory metadata; other owners' files are never opened.
    fn usage(&self, dir: &TrustedDirectory, scope: &str, own: &str) -> Result<Usage, EngineError> {
        let suffix = &own[scope.len()..];
        let mut usage = Usage {
            names: Vec::new(),
            bytes: 0,
            collision: false,
        };
        for entry in std::fs::read_dir(dir.path()).map_err(StoreError::from)? {
            let entry = entry.map_err(StoreError::from)?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let Some((owner, _)) = name_parts(&name) else {
                continue;
            };
            if owner != scope {
                usage.collision |= name.ends_with(suffix);
                continue;
            }
            if name != own {
                let meta = entry.metadata().map_err(StoreError::from)?;
                usage.bytes = usage.bytes.saturating_add(meta.len());
                usage.names.push(name);
            }
        }
        dir.assert_unchanged()?;
        Ok(usage)
    }
    pub fn begin(
        &self,
        turn: &TurnRecord,
        ctx: &RequestContext,
        options: &CaptureOptions,
        cancel: &Cancel,
    ) -> Result<Admission<'_>, EngineError> {
        if self.context(turn, cancel)? != *ctx {
            return Err(StoreError::InvalidInput.into());
        }
        secure_dir(&self.base)?;
        let base = TrustedDirectory::open(&self.base)?;
        let directory = base.create_child("_capture-admissions")?;
        let proof = self.proof(turn, &directory, cancel)?;
        let expected = Record {
            version: 1,
            proof,
            config: self.config.clone(),
            space: self.space.clone(),
            key: turn_key_of(turn)?,
            turn: turn.clone(),
            options: options.clone(),
            at_ms: self.host.now_ms(),
            phase: Phase::Primary,
            post_at_ms: None,
            rows: BTreeMap::new(),
            row_order: Vec::new(),
            result: None,
            classifier_started: false,
            classifier_done: false,
            neo_started: false,
            neo_done: false,
            reminders: BTreeMap::new(),
            post_skipped: Vec::new(),
            recovery_attempts: 0,
        };
        let name = self.filename(&expected)?;
        let scope = name_parts(&name)
            .ok_or(StoreError::InvalidInput)?
            .0
            .to_owned();
        let locks = directory.create_child(".leases")?;
        // One lease per owner scope: lease files stay bounded by the number of owners.
        let lease = kernel_lock::acquire(&locks, &scope, cancel, &mut || {})?;
        let previous = read(&directory, &name, cancel)?;
        let fresh = previous.is_none();
        let record = previous.unwrap_or(expected.clone());
        if record.proof != expected.proof
            || record.config != expected.config
            || record.space != expected.space
            || record.key != expected.key
            || digest(&record.turn)? != digest(turn)?
            || digest(&record.options)? != digest(options)?
        {
            return Err(StoreError::Corrupt.into());
        }
        validate(&record)?;
        let guard = Admission {
            owner: self,
            directory,
            locks,
            lease,
            name,
            record,
            closed: std::cell::Cell::new(false),
        };
        guard.check(cancel)?;
        if fresh {
            // Only this owner's files count, by name and size; nobody else's file is opened,
            // and their policy, configuration or workspace never decide this admission.
            let usage = self.usage(&guard.directory, &scope, &guard.name)?;
            // The Node key deliberately excludes the chat/owner. A new caller cannot
            // use that key to claim another caller's retained input or rollback IDs.
            if usage.collision {
                return Err(StoreError::Corrupt.into());
            }
            if usage.names.len() >= MAX_PENDING {
                return Err(StoreError::Unavailable.into());
            }
            guard.save(cancel)?;
        }
        Ok(guard)
    }
    /// Group the directory by owner scope from names alone (RE-D159). Closed files written
    /// before RE-D159 are removed; nothing is read for another purpose.
    fn group(&self, dir: &TrustedDirectory, cancel: &Cancel) -> Result<Inventory, EngineError> {
        let mut inventory = Inventory {
            scopes: BTreeMap::new(),
            unattributable: 0,
        };
        for entry in std::fs::read_dir(dir.path()).map_err(StoreError::from)? {
            cancel.check()?;
            let Ok(name) = entry.map_err(StoreError::from)?.file_name().into_string() else {
                inventory.unattributable += 1;
                continue;
            };
            if !name.ends_with(".json") {
                continue;
            }
            if let Some((scope, _)) = name_parts(&name) {
                inventory
                    .scopes
                    .entry(scope.to_owned())
                    .or_default()
                    .push(name);
            } else if legacy_name(&name) && matches!(read(dir, &name, cancel), Ok(None)) {
                // No current writer uses this name, so no lease can race the removal.
                dir.remove_file(&name)?;
            } else {
                inventory.unattributable += 1;
            }
        }
        dir.assert_unchanged()?;
        Ok(inventory)
    }
    /// Read one owner scope's files with that scope's own budget and count.
    pub fn entries(&self, names: &[String], cancel: &Cancel) -> Result<Vec<Entry>, EngineError> {
        let Some(dir) = self.directory()? else {
            return Ok(vec![]);
        };
        let mut budget = MAX_BYTES;
        let mut entries = Vec::new();
        for name in names {
            cancel.check()?;
            if entries.len() >= MAX_PENDING {
                entries.push(Entry::Unreadable);
                continue;
            }
            match self.structural(&dir, name, cancel, &mut budget) {
                Ok(Some(record)) => entries.push(Entry::Record(Box::new(record))),
                Ok(None) => {}
                Err(EngineError::Cancelled(cancelled)) => {
                    return Err(EngineError::Cancelled(cancelled))
                }
                Err(_) => entries.push(Entry::Unreadable),
            }
        }
        Ok(entries)
    }
    /// The files of one owner scope, for a retry before that owner's next turn.
    pub fn scope_names(&self, scope: &str, cancel: &Cancel) -> Result<Vec<String>, EngineError> {
        Ok(self
            .inventory(cancel)?
            .scopes
            .remove(scope)
            .unwrap_or_default())
    }
    fn directory(&self) -> Result<Option<TrustedDirectory>, EngineError> {
        let base = match TrustedDirectory::open(&self.base) {
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(None),
            result => result?,
        };
        match base.open_child("_capture-admissions") {
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => Ok(None),
            result => Ok(Some(result?)),
        }
    }
    fn structural(
        &self,
        dir: &TrustedDirectory,
        name: &str,
        cancel: &Cancel,
        budget: &mut usize,
    ) -> Result<Option<Record>, EngineError> {
        if name_parts(name).is_none() {
            return Err(StoreError::Corrupt.into());
        }
        let Some(record) = read_with_budget(dir, name, cancel, budget)? else {
            return Ok(None);
        };
        validate(&record)?;
        if record.version != 1
            || self.filename(&record)? != name
            || record.key != turn_key_of(&record.turn)?
        {
            return Err(StoreError::Corrupt.into());
        }
        Ok(Some(record))
    }
    /// Check one retained record against the current configuration, caller identity,
    /// workspace and policy. Errors are the host's or store's; refusals are assessments.
    pub fn assess(&self, record: &Record, cancel: &Cancel) -> Result<Assessment, EngineError> {
        if record.config != self.config || record.space != self.space {
            return Ok(Assessment::ConfigChanged);
        }
        let ctx = self.identity_context(&record.turn, cancel)?;
        match self.policy.decision(&ctx)? {
            PolicyDecision::Allowed => {}
            PolicyDecision::Revoked => return Ok(Assessment::Revoked),
            PolicyDecision::Maintenance => return Ok(Assessment::Maintenance),
        }
        let base = TrustedDirectory::open(&self.base)?;
        let dir = base.open_child("_capture-admissions")?;
        let current = self.proof(&record.turn, &dir, cancel)?;
        let recorded = &record.proof;
        Ok(
            if current.agent != recorded.agent
                || current.owner != recorded.owner
                || current.caller != recorded.caller
                || current.workspace != recorded.workspace
            {
                Assessment::CallerChanged
            } else if current != *recorded {
                Assessment::WorkspaceChanged
            } else {
                Assessment::Ready
            },
        )
    }
    /// Lease a retained record by name and apply `change` to its current version.
    fn with_record<T>(
        &self,
        record: &Record,
        cancel: &Cancel,
        change: impl FnOnce(&TrustedDirectory, &str, Option<Record>) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        let base = TrustedDirectory::open(&self.base)?;
        let dir = base.open_child("_capture-admissions")?;
        let locks = dir.create_child(".leases")?;
        let name = self.filename(record)?;
        let scope = name_parts(&name).ok_or(StoreError::InvalidInput)?.0;
        let _lease = kernel_lock::acquire(&locks, scope, cancel, &mut || {})?;
        let current = read(&dir, &name, cancel)?;
        if let Some(current) = &current {
            if digest(&current.turn)? != digest(&record.turn)? {
                return Err(StoreError::Corrupt.into());
            }
        }
        change(&dir, &name, current)
    }
    /// Close a retained record terminally: its stored turn content is discarded, rows
    /// already written stay. No host, policy or store authority is needed for this.
    pub fn abandon_record(&self, record: &Record, cancel: &Cancel) -> Result<(), EngineError> {
        self.with_record(record, cancel, |dir, name, current| match current {
            Some(_) => Ok(dir.remove_file(name)?),
            None => Ok(()),
        })
    }
    /// Take back an attempt counted for an attempt that maintenance prevented.
    pub fn revert_attempt(&self, record: &Record, cancel: &Cancel) -> Result<(), EngineError> {
        self.with_record(record, cancel, |dir, name, current| {
            let Some(mut current) = current else {
                return Ok(());
            };
            if current.recovery_attempts == 0 {
                return Ok(());
            }
            current.recovery_attempts -= 1;
            write(
                dir,
                name,
                &Envelope {
                    record: Some(current),
                },
            )
        })
    }
    /// Count one recovery attempt durably before it starts. Returns the attempts made
    /// before this one, or None when the record is no longer pending.
    pub fn note_attempt(
        &self,
        record: &Record,
        cancel: &Cancel,
    ) -> Result<Option<u32>, EngineError> {
        self.with_record(record, cancel, |dir, name, current| {
            let Some(mut current) = current else {
                return Ok(None);
            };
            let before = current.recovery_attempts;
            if before < super::failure::MAX_RECOVERY_ATTEMPTS {
                current.recovery_attempts = before + 1;
                validate(&current)?;
                write(
                    dir,
                    name,
                    &Envelope {
                        record: Some(current),
                    },
                )?;
            }
            Ok(Some(before))
        })
    }
    pub fn pending(&self, record: &Record, cancel: &Cancel) -> Result<bool, EngineError> {
        let base = TrustedDirectory::open(&self.base)?;
        let dir = base.open_child("_capture-admissions")?;
        let name = self.filename(record)?;
        Ok(read(&dir, &name, cancel)?.is_some())
    }
    /// The admission files by owner scope, from names alone.
    pub fn inventory(&self, cancel: &Cancel) -> Result<Inventory, EngineError> {
        cancel.check()?;
        match self.directory()? {
            Some(directory) => self.group(&directory, cancel),
            None => Ok(Inventory {
                scopes: BTreeMap::new(),
                unattributable: 0,
            }),
        }
    }
}
impl Admission<'_> {
    pub fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        self.directory.assert_unchanged()?;
        self.locks.assert_unchanged()?;
        self.lease.check(&self.locks)?;
        if self
            .owner
            .proof(&self.record.turn, &self.directory, cancel)?
            != self.record.proof
        {
            return Err(StoreError::InvalidInput.into());
        }
        // Revocation and maintenance are typed, so the caller can close or keep the record.
        let ctx = self.owner.identity_context(&self.record.turn, cancel)?;
        self.owner.policy_allows(&ctx)
    }
    pub fn save(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.check(cancel)?;
        validate(&self.record)?;
        // The owner scope lease is held: only this owner's sizes count, from metadata.
        let scope = name_parts(&self.name).ok_or(StoreError::Corrupt)?.0;
        let usage = self.owner.usage(&self.directory, scope, &self.name)?;
        let value = Envelope {
            record: Some(self.record.clone()),
        };
        let current = serde_json::to_vec(&value)
            .map_err(|_| StoreError::Corrupt)?
            .len() as u64;
        if usage.names.len() >= MAX_PENDING
            || usage
                .bytes
                .checked_add(current)
                .is_none_or(|size| size > MAX_BYTES as u64)
        {
            return Err(StoreError::Unavailable.into());
        }
        write(&self.directory, &self.name, &value)?;
        self.check(cancel)
    }
    /// Revoke only this held admission's future recovery. No host/store/effect work is
    /// authorized by this cleanup, so policy revocation or caller abort cannot prevent it.
    /// The file is removed (RE-D159): idempotency rests on the replay WAL, not on it.
    pub fn abandon(&self) -> Result<(), EngineError> {
        if self.closed.get() {
            return Ok(());
        }
        self.directory.assert_unchanged()?;
        self.locks.assert_unchanged()?;
        self.lease.check(&self.locks)?;
        self.remove()
    }
    fn remove(&self) -> Result<(), EngineError> {
        match self.directory.remove_file(&self.name) {
            Ok(())
            | Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => {}
            Err(error) => return Err(error.into()),
        }
        self.closed.set(true);
        Ok(())
    }
    /// Whether this admission was completed or abandoned (its input is no longer retained).
    pub fn is_closed(&self) -> bool {
        self.closed.get()
    }
    pub fn complete(&self, cancel: &Cancel) -> Result<(), EngineError> {
        if self.closed.get() {
            return Ok(());
        }
        self.check(cancel)?;
        self.remove()?;
        self.directory.assert_unchanged()?;
        Ok(())
    }
}
impl CapturePostStore for Admission<'_> {
    fn reference_time(&self) -> i64 {
        self.record.post_at_ms.unwrap_or(self.record.at_ms)
    }
    fn reminder(&self, position: usize) -> Option<ReminderEffect> {
        self.record.reminders.get(&position).cloned()
    }
    fn plan_reminder(
        &mut self,
        position: usize,
        effect: ReminderEffect,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if self.record.phase != Phase::PostStore
            || position >= 8
            || self.record.reminders.contains_key(&position)
        {
            return Err(StoreError::InvalidInput.into());
        }
        self.record.reminders.insert(position, effect);
        self.save(cancel)
    }
    fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        Admission::check(self, cancel)
    }
}
