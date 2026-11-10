//! Bounded inventory of private native pending files; filenames and stored callers confer no grant.
use super::*;
use crate::neo::{
    caller::{self, Caller},
    derived_fields::{field, validate_object},
};
use crate::text::json::parse_json;
use std::fs;
const MAX_CALLERS: usize = 512;

fn pending_kind(name: &str) -> Result<Option<&'static str>, StoreError> {
    // Atomic-write temporary siblings are uncommitted and never recovery authority.
    if !name.ends_with(".json") {
        return Ok(None);
    }
    let (suffix, prefix) = if let Some(s) = name.strip_prefix("native-capture-pending-") {
        (s, "native-capture-pending-")
    } else if let Some(s) = name.strip_prefix("native-episode-pending-") {
        (s, "native-episode-pending-")
    } else if let Some(s) = name.strip_prefix("native-embedding-pending-") {
        (s, "native-embedding-pending-")
    } else {
        return Ok(None);
    };
    let hash = suffix.strip_suffix(".json").ok_or(StoreError::Corrupt)?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(StoreError::Corrupt);
    }
    Ok(Some(prefix))
}
fn active_caller(value: &Json, episode: bool) -> Result<Option<Caller>, StoreError> {
    validate_object(value)?;
    let raw = if episode {
        let plan = field(value, "plan")?;
        if plan == &Json::Null {
            return Ok(None);
        }
        validate_object(plan)?;
        field(plan, "caller")?
    } else {
        let Json::Array(groups) = field(value, "records")? else {
            return Err(StoreError::Corrupt);
        };
        if groups.len() != FILES.len() || groups.iter().any(|v| !matches!(v, Json::Array(_))) {
            return Err(StoreError::Corrupt);
        }
        if groups
            .iter()
            .all(|v| matches!(v, Json::Array(rows) if rows.is_empty()))
        {
            return Ok(None);
        }
        field(value, "caller")?
    };
    Ok(Some(caller::decode(raw)?))
}
/// One owner binding's prepared plans in one workspace directory (RE-D159).
pub(in crate::neo) struct PendingPlans {
    /// Canonical workspace directory name under `workspaces/`.
    pub canonical: String,
    /// The binding digest shared by its capture, episode and embedding plan files.
    pub digest: String,
    /// The plan files present for this binding.
    pub files: Vec<String>,
    /// The stored caller and ownership proof, when a file holding them could be read.
    pub caller: Option<(Caller, Json)>,
    /// When the oldest plan file that holds content was written (its modification time,
    /// milliseconds since the epoch); None when no such time could be read.
    pub written_ms: Option<i64>,
}
impl PendingPlans {
    /// Keep the oldest modification time among the plan files that hold content.
    fn note_written(&mut self, at: Option<i64>) {
        self.written_ms = match (self.written_ms, at) {
            (Some(known), Some(at)) => Some(known.min(at)),
            (known, at) => known.or(at),
        };
    }
}
/// A plan file's own modification time; a link is not followed.
fn modified_ms(directory: &TrustedDirectory, name: &str) -> Option<i64> {
    let time = fs::symlink_metadata(directory.path().join(name))
        .ok()?
        .modified()
        .ok()?;
    let since = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}
/// Prepared plans by owner binding. A file that cannot be read or attributed is counted,
/// kept and never fails anyone else's recovery; only cancellation and the root fail it.
pub(in crate::neo) struct PlanInventory {
    pub plans: Vec<PendingPlans>,
    pub unreadable: usize,
    /// Bindings whose plan files are all settled: no rows, no caller, nothing to recover.
    pub settled: usize,
}
/// What the current host and policy allow for one binding's prepared plans.
pub(in crate::neo) enum PlanAssessment {
    Ready,
    Revoked,
    Maintenance,
    /// The binding now resolves to another workspace, directory, proof or caller.
    Changed,
}
impl CaptureJournal {
    /// Read-only inventory by owner binding; nothing is bound or replayed here.
    pub(in crate::neo) fn recovery_plans(
        &self,
        cancel: &Cancel,
    ) -> Result<PlanInventory, EngineError> {
        self.recovery_plans_within(cancel, journal_io::MAX_ROWS)
    }
    /// [`Self::recovery_plans`] with an explicit bound of entries scanned per workspace
    /// directory. The bound belongs to each directory (RE-D162 / m2): a large workspace of
    /// one owner never cuts short the scan of another owner's directory.
    fn recovery_plans_within(
        &self,
        cancel: &Cancel,
        entries: usize,
    ) -> Result<PlanInventory, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let mut inventory = PlanInventory {
            plans: Vec::new(),
            unreadable: 0,
            settled: 0,
        };
        let Some(workspaces) = optional(self.root.open_child("workspaces"))? else {
            return Ok(inventory);
        };
        for entry in fs::read_dir(workspaces.path()).map_err(StoreError::from)? {
            cancel.check()?;
            let entry = entry.map_err(StoreError::from)?;
            let Ok(name) = entry.file_name().into_string() else {
                inventory.unreadable += 1;
                continue;
            };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => {}
                Ok(kind) if !kind.is_symlink() => continue,
                _ => {
                    inventory.unreadable += 1;
                    continue;
                }
            }
            let Ok(directory) = workspaces.open_child(&name) else {
                inventory.unreadable += 1;
                continue;
            };
            let Ok(items) = fs::read_dir(directory.path()) else {
                inventory.unreadable += 1;
                continue;
            };
            let mut found: Vec<PendingPlans> = Vec::new();
            let mut scanned = 0;
            for item in items {
                cancel.check()?;
                scanned += 1;
                if scanned > entries || found.len() >= MAX_CALLERS {
                    inventory.unreadable += 1;
                    break;
                }
                let Ok(filename) = item.map_err(StoreError::from)?.file_name().into_string() else {
                    inventory.unreadable += 1;
                    continue;
                };
                let prefix = match pending_kind(&filename) {
                    Ok(Some(prefix)) => prefix,
                    Ok(None) => continue,
                    Err(_) => {
                        inventory.unreadable += 1;
                        continue;
                    }
                };
                let digest = filename[prefix.len()..filename.len() - 5].to_owned();
                let caller = match self.plan_caller(&directory, &filename, prefix, cancel) {
                    Ok(caller) => caller,
                    Err(EngineError::Cancelled(cancelled)) => {
                        return Err(EngineError::Cancelled(cancelled))
                    }
                    Err(_) => {
                        inventory.unreadable += 1;
                        continue;
                    }
                };
                let index = match found.iter().position(|plan| plan.digest == digest) {
                    Some(index) => index,
                    None => {
                        found.push(PendingPlans {
                            canonical: name.clone(),
                            digest,
                            files: Vec::new(),
                            caller: None,
                            written_ms: None,
                        });
                        found.len() - 1
                    }
                };
                if caller.is_some() {
                    found[index].note_written(modified_ms(&directory, &filename));
                }
                found[index].files.push(filename);
                if found[index].caller.is_none() {
                    found[index].caller = caller;
                }
            }
            // A binding without a caller has only settled plan files: a capture plan
            // without rows, or an episode or embedding file whose plan is null. It holds no
            // turn content and nothing to recover; it is counted, not listed.
            let (active, settled): (Vec<_>, Vec<_>) =
                found.into_iter().partition(|plan| plan.caller.is_some());
            inventory.settled += settled.len();
            inventory.plans.extend(active);
        }
        self.root.assert_unchanged()?;
        cancel.check()?;
        Ok(inventory)
    }
    /// One binding's prepared plans as they are now, from its three plan file names; None
    /// when no file of it holds a plan any more. No directory is listed.
    pub(in crate::neo) fn binding_plans(
        &self,
        canonical: &str,
        digest: &str,
        cancel: &Cancel,
    ) -> Result<Option<PendingPlans>, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let Some(workspaces) = optional(self.root.open_child("workspaces"))? else {
            return Ok(None);
        };
        let Some(directory) = optional(workspaces.open_child(canonical))? else {
            return Ok(None);
        };
        let mut plans = PendingPlans {
            canonical: canonical.to_owned(),
            digest: digest.to_owned(),
            files: Vec::new(),
            caller: None,
            written_ms: None,
        };
        for prefix in [
            "native-capture-pending-",
            "native-episode-pending-",
            "native-embedding-pending-",
        ] {
            let filename = format!("{prefix}{digest}.json");
            if pending_kind(&filename)? != Some(prefix)
                || journal_io::bytes(&directory, &filename, cancel)?.is_none()
            {
                continue;
            }
            match self.plan_caller(&directory, &filename, prefix, cancel) {
                Ok(caller) => {
                    if caller.is_some() {
                        plans.note_written(modified_ms(&directory, &filename));
                    }
                    plans.files.push(filename);
                    if plans.caller.is_none() {
                        plans.caller = caller;
                    }
                }
                Err(EngineError::Cancelled(cancelled)) => {
                    return Err(EngineError::Cancelled(cancelled))
                }
                // Unreadable: kept and counted by the inventory, never recovery authority.
                Err(_) => {}
            }
        }
        Ok(plans.caller.is_some().then_some(plans))
    }
    /// The key of the binding a caller's own journal writes use: its workspace directory
    /// under the Neo root and its binding digest. None for a caller the journal does not
    /// bind. This asks the host.
    pub(in crate::neo) fn binding_key(
        &self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<Option<String>, EngineError> {
        let binding = match self.bind(principal, agent) {
            Ok(binding) => binding,
            Err(EngineError::Store(StoreError::InvalidInput | StoreError::Unavailable)) => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        let digest = binding
            .file
            .strip_prefix("native-capture-pending-")
            .and_then(|name| name.strip_suffix(".json"))
            .ok_or(StoreError::Corrupt)?;
        Ok(Some(format!("{}/{digest}", binding.layout.canonical)))
    }
    /// The caller and ownership stored in one plan file; None for a settled (empty) plan.
    fn plan_caller(
        &self,
        directory: &TrustedDirectory,
        filename: &str,
        prefix: &str,
        cancel: &Cancel,
    ) -> Result<Option<(Caller, Json)>, EngineError> {
        let bytes = journal_io::bytes(directory, filename, cancel)?.ok_or(StoreError::Corrupt)?;
        let value = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
            .map_err(|_| StoreError::Corrupt)?;
        let Some(caller) = active_caller(&value, prefix != "native-capture-pending-")? else {
            return Ok(None);
        };
        Ok(Some((caller, field(&value, "ownership")?.clone())))
    }
    /// Check one binding's plans against the current host, policy and binding. Host and
    /// store errors are returned for classification; refusals are assessments.
    pub(in crate::neo) fn assess_plans(
        &self,
        plans: &PendingPlans,
        cancel: &Cancel,
    ) -> Result<PlanAssessment, EngineError> {
        cancel.check()?;
        let Some((caller, ownership)) = &plans.caller else {
            return Ok(PlanAssessment::Changed);
        };
        let ctx = RequestContext::build(&caller.principal, &caller.agent, self.host.as_ref())?;
        match self.policy.decision(&ctx)? {
            crate::capture::shared_scope::PolicyDecision::Allowed => {}
            crate::capture::shared_scope::PolicyDecision::Revoked => {
                return Ok(PlanAssessment::Revoked)
            }
            crate::capture::shared_scope::PolicyDecision::Maintenance => {
                return Ok(PlanAssessment::Maintenance)
            }
        }
        let binding = match self.bind(&caller.principal, &caller.agent) {
            Ok(binding) => binding,
            // A caller that no longer binds to a user workspace is a changed binding.
            Err(EngineError::Store(StoreError::InvalidInput)) => {
                return Ok(PlanAssessment::Changed)
            }
            Err(error) => return Err(error),
        };
        let expected = format!("native-capture-pending-{}.json", plans.digest);
        if binding.proof != *ownership
            || binding.layout.canonical != plans.canonical
            || binding.file != expected
        {
            return Ok(PlanAssessment::Changed);
        }
        let Some(actual) = self.directory(&binding, false)? else {
            return Ok(PlanAssessment::Changed);
        };
        let listed = self
            .root
            .open_child("workspaces")?
            .open_child(&plans.canonical)?;
        if actual.identity_parts() != listed.identity_parts() {
            return Ok(PlanAssessment::Changed);
        }
        Ok(PlanAssessment::Ready)
    }
    /// Remove one binding's prepared plans: their turn content is discarded, journals
    /// already written stay. Needs no host or policy authority, only the workspace leases.
    pub(in crate::neo) fn discard_plans(
        &self,
        plans: &PendingPlans,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let directory = self
            .root
            .open_child("workspaces")?
            .open_child(&plans.canonical)?;
        let locks = directory.create_child(".native-capture-leases")?;
        let _kernel = kernel_lock::acquire(&locks, "workspace", cancel, &mut || {})?;
        let _neo = loop {
            cancel.check()?;
            directory.assert_unchanged()?;
            if let Some(guard) = Lock::try_acquire_neo(
                &directory.path().join(".neo-write.lock"),
                Duration::from_secs(300),
            )? {
                break guard;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        for file in &plans.files {
            match directory.remove_file(file) {
                Ok(())
                | Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
    /// Remove what interrupted atomic writes left in the workspace directories (RE-D163): a
    /// whole plan under a temporary name, older than an hour by the host's clock. Directory
    /// entries and file times only; no lease, no host callback. Returns the number removed.
    pub(in crate::neo) fn remove_stale_temporaries(
        &self,
        cancel: &Cancel,
    ) -> Result<usize, EngineError> {
        cancel.check()?;
        let Some(workspaces) = optional(self.root.open_child("workspaces"))? else {
            return Ok(0);
        };
        let now = self.host.now_ms();
        let mut removed = 0;
        for entry in fs::read_dir(workspaces.path()).map_err(StoreError::from)? {
            cancel.check()?;
            let Ok(entry) = entry else { continue };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Ok(directory) = workspaces.open_child(&name) {
                // One workspace's failure is its own; the others are still looked at.
                removed += directory.remove_stale_temporaries(now).unwrap_or(0);
            }
        }
        Ok(removed)
    }
    /// The durable recovery attempt count of a binding's plans (RE-D159): `change > 0` counts
    /// one before an attempt starts, `change < 0` gives one back (maintenance), `0` clears it.
    /// Returns the attempts made before this call.
    pub(in crate::neo) fn note_plan_attempt(
        &self,
        plans: &PendingPlans,
        change: i64,
    ) -> Result<u32, EngineError> {
        let dir = self.root.create_child(ATTEMPTS)?;
        let name = attempts_file(&plans.canonical, &plans.digest);
        let before = match journal_io::bytes(&dir, &name, &Cancel::never())? {
            None => 0,
            // A count that cannot be read allows exactly one more attempt (RE-D162 / m1):
            // it stands for the bound minus one, so this attempt runs and writes the bound.
            // Neither "exhausted at once" nor "counted from zero again".
            Some(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|value| value["attempts"].as_u64())
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(crate::capture::failure::MAX_RECOVERY_ATTEMPTS - 1),
        };
        let after = if change == 0 {
            match dir.remove_file(&name) {
                Ok(())
                | Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => return Ok(before),
                Err(error) => return Err(error.into()),
            }
        } else if change > 0 {
            before.saturating_add(1)
        } else {
            before.saturating_sub(1)
        };
        crate::store::state_file::StateFile::store(
            &dir.path().join(&name),
            &object(vec![("attempts", Json::Number(after.to_string()))]),
        )?;
        Ok(before)
    }
    /// Forget a binding's attempt count (RE-D162 / m1): after its owner's own successful
    /// live replay, and when a new plan is written for it. A count never outlives the plan
    /// it was counted for. Creates nothing; a failure leaves the count, which only brings
    /// the bound closer.
    pub(in crate::neo) fn forget_attempts(&self, canonical: &str, digest: &str) {
        let Ok(Some(dir)) = optional(self.root.open_child(ATTEMPTS)) else {
            return;
        };
        match dir.remove_file(&attempts_file(canonical, digest)) {
            Ok(())
            | Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => {}
            Err(_) => log::warn!("neo: a recovery attempt count could not be cleared"),
        }
    }
}
/// The directory under the Neo root that holds the attempt counts, one file per binding.
const ATTEMPTS: &str = ".native-recovery-attempts";
fn attempts_file(canonical: &str, digest: &str) -> String {
    format!(
        "{:x}.json",
        Sha256::digest(format!("{canonical}/{digest}").as_bytes())
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]
    use super::*;
    use crate::contract::testing::FakeHost;
    use std::sync::Arc;

    struct Allow;
    impl CapturePolicy for Allow {
        fn allowed(&self, _context: &RequestContext) -> Result<bool, EngineError> {
            Ok(true)
        }
    }

    fn journal() -> (tempfile::TempDir, CaptureJournal) {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let host = Arc::new(FakeHost::new(
            root.path().join("state"),
            serde_json::from_value(serde_json::json!({})).unwrap(),
        ));
        let journal = CaptureJournal::open(root.path(), host, Arc::new(Allow)).unwrap();
        (root, journal)
    }

    /// RE-D162 / m2: the scan bound belongs to each workspace directory. Two directories
    /// with four unreadable plan files each, bound five: every file is seen. A counter
    /// shared by both directories would stop in the second one after its first file.
    #[test]
    fn the_plan_scan_bound_is_per_workspace_directory() {
        let (root, journal) = journal();
        for workspace in ["one", "two"] {
            let directory = root.path().join("workspaces").join(workspace);
            fs::create_dir_all(&directory).unwrap();
            for index in 0..4_u32 {
                let name = format!("native-capture-pending-{index:064x}.json");
                fs::write(directory.join(name), b"not a plan").unwrap();
            }
        }
        let inventory = journal.recovery_plans_within(&Cancel::never(), 5).unwrap();
        assert!(inventory.plans.is_empty());
        assert_eq!(inventory.unreadable, 8);
        // The bound itself still holds within one directory: three files, then the stop.
        let inventory = journal.recovery_plans_within(&Cancel::never(), 3).unwrap();
        assert_eq!(inventory.unreadable, 8);
        let inventory = journal.recovery_plans_within(&Cancel::never(), 1).unwrap();
        assert_eq!(inventory.unreadable, 4);
    }

    /// RE-D162 / m1: an attempt count that cannot be read allows exactly one more attempt;
    /// a readable one counts up and down; forgetting it starts from zero.
    #[test]
    fn an_unreadable_attempt_count_allows_exactly_one_more_attempt() {
        let (root, journal) = journal();
        let plans = PendingPlans {
            canonical: "workspace".into(),
            digest: "d".repeat(64),
            files: Vec::new(),
            caller: None,
            written_ms: None,
        };
        let bound = crate::capture::failure::MAX_RECOVERY_ATTEMPTS;
        assert_eq!(journal.note_plan_attempt(&plans, 1).unwrap(), 0);
        assert_eq!(journal.note_plan_attempt(&plans, 1).unwrap(), 1);
        assert_eq!(journal.note_plan_attempt(&plans, -1).unwrap(), 2);
        assert_eq!(journal.note_plan_attempt(&plans, 1).unwrap(), 1);
        let file = root
            .path()
            .join(ATTEMPTS)
            .join(attempts_file(&plans.canonical, &plans.digest));
        fs::write(&file, b"not a count").unwrap();
        // One more attempt: fewer than the bound were made before it, the bound after it.
        assert_eq!(journal.note_plan_attempt(&plans, 1).unwrap(), bound - 1);
        assert_eq!(journal.note_plan_attempt(&plans, 1).unwrap(), bound);
        journal.forget_attempts(&plans.canonical, &plans.digest);
        assert!(!file.exists());
        assert_eq!(journal.note_plan_attempt(&plans, 1).unwrap(), 0);
        // Forgetting a count that does not exist creates nothing.
        let (other, journal) = self::journal();
        journal.forget_attempts(&plans.canonical, &plans.digest);
        assert!(!other.path().join(ATTEMPTS).exists());
    }
}
