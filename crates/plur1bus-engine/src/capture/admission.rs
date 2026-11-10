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
    collections::{BTreeMap, BTreeSet},
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
/// The admission root under the store base and its lease directory.
const ROOT: &str = "_capture-admissions";
const LEASES: &str = ".leases";
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// `<hash64>.json`, the hash of agent and turn key: a record inside its owner scope's
/// directory `<scope16>/` (RE-D162).
fn record_name(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(|hash| hex(hash, 64))
}
/// A top-level file of one of the two earlier branch formats: `<hash64>.json` (RE-D156) or
/// `<scope16>-<hash64>.json` (RE-D159).
fn earlier_format(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(|stem| {
        hex(stem, 64)
            || stem
                .split_once('-')
                .is_some_and(|(scope, hash)| hex(scope, 16) && hex(hash, 64))
    })
}
/// What a top-level entry of the admission root is, from its name and kind alone. There is
/// no entry count after which this changes (the RE-D156 ceiling of 50 000 entries is gone).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum TopLevel {
    /// The lease directory.
    Leases,
    /// An owner scope's directory.
    Scope,
    /// A file of an earlier branch format: removed without migration.
    Earlier,
    /// Anything else: kept, counted and reported.
    Foreign,
}
pub(super) fn classify(name: &str, directory: bool) -> TopLevel {
    if directory && name == LEASES {
        TopLevel::Leases
    } else if directory && hex(name, 16) {
        TopLevel::Scope
    } else if !directory && earlier_format(name) {
        TopLevel::Earlier
    } else {
        TopLevel::Foreign
    }
}
/// Whether retained input is past the seven-day bound (RE-D162): the pin's pending TTL,
/// inclusive like its `fresh`.
pub(super) fn expired(at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(at_ms) > super::replay_guard::REPLAY_GUARD_TTL_MS
}
/// One owner scope's other records and the bytes they occupy, from its own directory only.
struct Usage {
    records: usize,
    bytes: u64,
}
/// The admission root classified from directory entries; nothing is opened.
pub(super) struct Inventory {
    /// Owner scopes whose directory holds at least one record file.
    pub scopes: BTreeSet<String>,
    /// Top-level entries nobody owns: kept, reported, never read.
    pub foreign: usize,
}
/// How an admission is opened.
#[derive(Clone, Copy)]
pub(super) struct Begin {
    /// The replay WAL hands this turn row IDs of an earlier, unfinished attempt.
    pub inherits_rows: bool,
    /// A recovery step: a busy scope lease defers the record instead of waiting.
    pub recovery: bool,
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
    /// A file with a record name that is not a well-formed record of its scope: never
    /// recovered, never blocking others. Its scope stays deferred and reported until the
    /// file is past the age bound and removed (RE-D162).
    Unreadable {
        name: String,
        /// The file's modification time, when it can be read.
        modified_ms: Option<i64>,
    },
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
    /// The admission root; the recorded proof names it.
    root: TrustedDirectory,
    /// The owner scope's own directory under the root.
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
/// The effective-configuration keys (JSON pointers) whose value changes what a resumed turn
/// stores or which of its steps run (RE-D162). Everything else is operational and never
/// closes a retained record: all of `runtime`, time budgets, queue and batch sizes,
/// credentials, endpoints and model names. The vector space is the record's own field.
/// `docs/engine-stores.md` (RE-D162) gives one reason per key.
pub(super) const CAPTURE_SEMANTICS: [&str; 21] = [
    "/duplicateThreshold",
    "/captureChunking",
    "/captureChunkingMode",
    "/captureMaxChars",
    "/summaryMaxWords",
    "/merging/enabled",
    "/emotion/tier",
    "/emotion/t2/enabled",
    "/emotion/t3/enabled",
    "/emotion/t3/onlyWhenProviderAvailable",
    "/emotion/t3/escalationConfidence",
    "/emotion/t3/captureMode",
    "/emotion/t3/refineImportanceMin",
    "/emotion/moodInfluence",
    "/emotion/intensityHalfLifeFactor",
    "/emotion/temperaments",
    "/memoryDynamics/flashbulbEncoding",
    "/recall/halfLifeDaysMap",
    "/reminders/autoExtract",
    "/neo/enabled",
    "/namespaces/activeWriteNamespace",
];
/// Digest of the capture-semantic projection of an effective configuration.
pub(super) fn semantic_digest(config: &serde_json::Value) -> Result<String, StoreError> {
    let projection = CAPTURE_SEMANTICS
        .iter()
        .map(|pointer| (*pointer, config.pointer(pointer)))
        .collect::<Vec<_>>();
    digest(&projection)
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
            // Only capture semantics decide `config-changed` (RE-D162); a record written
            // under the earlier whole-configuration digest is closed once.
            config: semantic_digest(config)?,
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
    /// Where a record lives: its owner scope's directory and its file name in it. Caller,
    /// workspace and physical IDs are checked in the record, not included in the name:
    /// another chat of the owner, or a restored pathname, finds the old record and refuses
    /// it rather than silently starting fresh.
    fn place(&self, record: &Record) -> Result<(String, String), StoreError> {
        Ok((
            scope_of(&record.proof.agent, &record.proof.owner)?,
            format!("{}.json", digest(&(&record.proof.agent, &record.key))?),
        ))
    }
    /// The admission root, if it exists.
    fn root(&self) -> Result<Option<TrustedDirectory>, EngineError> {
        let base = match TrustedDirectory::open(&self.base) {
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(None),
            result => result?,
        };
        Ok(optional(base.open_child(ROOT))?)
    }
    /// One owner scope's existing directory, with the root it lives in.
    fn scope_dir(
        &self,
        scope: &str,
    ) -> Result<Option<(TrustedDirectory, TrustedDirectory)>, EngineError> {
        let Some(root) = self.root()? else {
            return Ok(None);
        };
        Ok(optional(root.open_child(scope))?.map(|dir| (root, dir)))
    }
    /// The caller's own scope from its own directory's metadata. No other directory is
    /// read and no file is opened, so the cost of a turn depends on nobody else (RE-D162).
    fn usage(&self, dir: &TrustedDirectory, own: &str) -> Result<Usage, EngineError> {
        let mut usage = Usage {
            records: 0,
            bytes: 0,
        };
        for entry in std::fs::read_dir(dir.path()).map_err(StoreError::from)? {
            let entry = entry.map_err(StoreError::from)?;
            #[cfg(test)]
            io::note_listed();
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !record_name(&name) || name == own {
                continue;
            }
            let meta = entry.metadata().map_err(StoreError::from)?;
            usage.bytes = usage.bytes.saturating_add(meta.len());
            usage.records += 1;
        }
        dir.assert_unchanged()?;
        Ok(usage)
    }
    /// Whether another owner scope retains a record for the same agent and turn key. Asked
    /// only for a fresh admission that inherits rollback IDs from the replay WAL (after a
    /// kill or an abort): the Node key excludes the owner, and a new caller must not use it
    /// to remove another caller's unsettled rows.
    fn claimed_elsewhere(
        &self,
        root: &TrustedDirectory,
        scope: &str,
        name: &str,
    ) -> Result<bool, EngineError> {
        for entry in std::fs::read_dir(root.path()).map_err(StoreError::from)? {
            let Ok(other) = entry.map_err(StoreError::from)?.file_name().into_string() else {
                continue;
            };
            if other == scope || !hex(&other, 16) {
                continue;
            }
            let Ok(dir) = root.open_child(&other) else {
                continue;
            };
            if !matches!(
                dir.open_file(name),
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound
                })
            ) {
                return Ok(true);
            }
        }
        root.assert_unchanged()?;
        Ok(false)
    }
    pub fn begin(
        &self,
        turn: &TurnRecord,
        ctx: &RequestContext,
        options: &CaptureOptions,
        cancel: &Cancel,
        mode: Begin,
    ) -> Result<Admission<'_>, EngineError> {
        if self.context(turn, cancel)? != *ctx {
            return Err(StoreError::InvalidInput.into());
        }
        secure_dir(&self.base)?;
        let base = TrustedDirectory::open(&self.base)?;
        let root = base.create_child(ROOT)?;
        let proof = self.proof(turn, &root, cancel)?;
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
        let (scope, name) = self.place(&expected)?;
        let locks = root.create_child(LEASES)?;
        // One lease per owner scope: lease files stay bounded by the number of owners. A
        // recovery step never waits for it; the record is deferred instead (RE-D162).
        let lease = if mode.recovery {
            kernel_lock::try_acquire(&locks, &scope)?.ok_or(StoreError::Busy)?
        } else {
            kernel_lock::acquire(&locks, &scope, cancel, &mut || {})?
        };
        let directory = root.create_child(&scope)?;
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
            root,
            directory,
            locks,
            lease,
            name,
            record,
            closed: std::cell::Cell::new(false),
        };
        guard.check(cancel)?;
        if fresh {
            if mode.inherits_rows && self.claimed_elsewhere(&guard.root, &scope, &guard.name)? {
                return Err(StoreError::Corrupt.into());
            }
            // Only this owner's own directory counts; a full scope refuses only its owner.
            guard.save(cancel)?;
        }
        Ok(guard)
    }
    /// Classify the admission root from directory entries alone (RE-D162): which owner
    /// scopes hold a record file, and what nobody owns. No file is opened for reading and
    /// no lease is taken. Files of the two earlier branch formats are removed without
    /// migration, with one directory sync at the end.
    pub fn inventory(&self, cancel: &Cancel) -> Result<Inventory, EngineError> {
        cancel.check()?;
        let mut inventory = Inventory {
            scopes: BTreeSet::new(),
            foreign: 0,
        };
        let Some(root) = self.root()? else {
            return Ok(inventory);
        };
        let mut removed = false;
        for entry in std::fs::read_dir(root.path()).map_err(StoreError::from)? {
            cancel.check()?;
            let entry = entry.map_err(StoreError::from)?;
            let Ok(name) = entry.file_name().into_string() else {
                inventory.foreign += 1;
                continue;
            };
            let directory = entry.file_type().is_ok_and(|kind| kind.is_dir());
            match classify(&name, directory) {
                TopLevel::Leases => {}
                TopLevel::Scope => match retains(&root, &name) {
                    Ok(true) => {
                        inventory.scopes.insert(name);
                    }
                    Ok(false) => {}
                    Err(_) => inventory.foreign += 1,
                },
                // No current writer uses these names, so no lease can race the removal.
                TopLevel::Earlier if root.remove_file_unsynced(&name).is_ok() => removed = true,
                TopLevel::Earlier | TopLevel::Foreign => inventory.foreign += 1,
            }
        }
        if removed {
            root.sync_entries()?;
        }
        root.assert_unchanged()?;
        Ok(inventory)
    }
    /// Read one owner scope's record files with that scope's own budget and count. The
    /// flag reports files beyond the per-scope bound, left for a later attempt.
    pub fn entries(&self, scope: &str, cancel: &Cancel) -> Result<(Vec<Entry>, bool), EngineError> {
        let Some((_root, dir)) = self.scope_dir(scope)? else {
            return Ok((Vec::new(), false));
        };
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir.path()).map_err(StoreError::from)? {
            cancel.check()?;
            if let Ok(name) = entry.map_err(StoreError::from)?.file_name().into_string() {
                if record_name(&name) {
                    names.push(name);
                }
            }
        }
        names.sort();
        let more = names.len() > MAX_PENDING;
        names.truncate(MAX_PENDING);
        let mut budget = MAX_BYTES;
        let mut entries = Vec::new();
        for name in names {
            cancel.check()?;
            match self.structural(&dir, scope, &name, cancel, &mut budget) {
                Ok(record) => entries.push(Entry::Record(Box::new(record))),
                Err(EngineError::Cancelled(cancelled)) => {
                    return Err(EngineError::Cancelled(cancelled))
                }
                Err(_) => entries.push(Entry::Unreadable {
                    modified_ms: modified(&dir, &name),
                    name,
                }),
            }
        }
        Ok((entries, more))
    }
    /// A well-formed record of this scope under this name; anything else is an error.
    fn structural(
        &self,
        dir: &TrustedDirectory,
        scope: &str,
        name: &str,
        cancel: &Cancel,
        budget: &mut usize,
    ) -> Result<Record, EngineError> {
        // A closed envelope is never written into a scope directory: not a record.
        let record = read_with_budget(dir, name, cancel, budget)?.ok_or(StoreError::Corrupt)?;
        validate(&record)?;
        let (owner, file) = self.place(&record)?;
        if record.version != 1
            || owner != scope
            || file != name
            || record.key != turn_key_of(&record.turn)?
        {
            return Err(StoreError::Corrupt.into());
        }
        Ok(record)
    }
    /// Remove a file of this scope that is not a well-formed record, once it is past the
    /// age bound. Under the scope lease: a file that is a record by now is left alone.
    pub fn remove_unreadable(
        &self,
        scope: &str,
        name: &str,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if !record_name(name) {
            return Err(StoreError::InvalidInput.into());
        }
        let Some((root, dir)) = self.scope_dir(scope)? else {
            return Ok(());
        };
        let locks = root.create_child(LEASES)?;
        let _lease = kernel_lock::acquire(&locks, scope, cancel, &mut || {})?;
        let mut budget = MAX_BYTES;
        if self
            .structural(&dir, scope, name, cancel, &mut budget)
            .is_ok()
        {
            return Ok(());
        }
        cancel.check()?;
        match dir.remove_entry(name) {
            Ok(())
            | Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => Ok(()),
            Err(error) => Err(error.into()),
        }
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
        let root = base.open_child(ROOT)?;
        let current = self.proof(&record.turn, &root, cancel)?;
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
    /// Lease a retained record's scope and apply `change` to the record's current version.
    fn with_record<T>(
        &self,
        record: &Record,
        cancel: &Cancel,
        change: impl FnOnce(&TrustedDirectory, &str, Option<Record>) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        let (scope, name) = self.place(record)?;
        let (root, dir) = self.scope_dir(&scope)?.ok_or(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        })?;
        let locks = root.create_child(LEASES)?;
        let _lease = kernel_lock::acquire(&locks, &scope, cancel, &mut || {})?;
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
        let (scope, name) = self.place(record)?;
        let Some((_root, dir)) = self.scope_dir(&scope)? else {
            return Ok(false);
        };
        Ok(read(&dir, &name, cancel)?.is_some())
    }
}
fn optional(
    result: Result<TrustedDirectory, StoreError>,
) -> Result<Option<TrustedDirectory>, StoreError> {
    match result {
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => Ok(None),
        result => result.map(Some),
    }
}
/// Whether an owner scope's directory holds at least one record file (names only).
fn retains(root: &TrustedDirectory, scope: &str) -> Result<bool, StoreError> {
    let dir = root.open_child(scope)?;
    for entry in std::fs::read_dir(dir.path())? {
        if entry?.file_name().to_str().is_some_and(record_name) {
            return Ok(true);
        }
    }
    Ok(false)
}
/// A file's own modification time in milliseconds since the epoch; a link is not followed.
fn modified(dir: &TrustedDirectory, name: &str) -> Option<i64> {
    let time = std::fs::symlink_metadata(dir.path().join(name))
        .ok()?
        .modified()
        .ok()?;
    let since = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}
impl Admission<'_> {
    pub fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        self.directory.assert_unchanged()?;
        self.locks.assert_unchanged()?;
        self.lease.check(&self.locks)?;
        if self.owner.proof(&self.record.turn, &self.root, cancel)? != self.record.proof {
            return Err(StoreError::InvalidInput.into());
        }
        // Revocation and maintenance are typed, so the caller can close or keep the record.
        let ctx = self.owner.identity_context(&self.record.turn, cancel)?;
        self.owner.policy_allows(&ctx)
    }
    pub fn save(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.check(cancel)?;
        validate(&self.record)?;
        // The owner scope lease is held: only this owner's own directory is listed.
        let usage = self.owner.usage(&self.directory, &self.name)?;
        let value = Envelope {
            record: Some(self.record.clone()),
        };
        let current = serde_json::to_vec(&value)
            .map_err(|_| StoreError::Corrupt)?
            .len() as u64;
        if usage.records >= MAX_PENDING
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
