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
}
/// Prepared plans by owner binding. A file that cannot be read or attributed is counted,
/// kept and never fails anyone else's recovery; only cancellation and the root fail it.
pub(in crate::neo) struct PlanInventory {
    pub plans: Vec<PendingPlans>,
    pub unreadable: usize,
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
        cancel.check()?;
        self.root.assert_unchanged()?;
        let mut inventory = PlanInventory {
            plans: Vec::new(),
            unreadable: 0,
        };
        let Some(workspaces) = optional(self.root.open_child("workspaces"))? else {
            return Ok(inventory);
        };
        let mut scanned = 0;
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
            for item in items {
                cancel.check()?;
                scanned += 1;
                if scanned > journal_io::MAX_ROWS || found.len() >= MAX_CALLERS {
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
                        });
                        found.len() - 1
                    }
                };
                found[index].files.push(filename);
                if found[index].caller.is_none() {
                    found[index].caller = caller;
                }
            }
            inventory
                .plans
                .extend(found.into_iter().filter(|plan| plan.caller.is_some()));
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
    /// The durable recovery attempt count of a binding's plans (RE-D159): `change > 0` counts
    /// one before an attempt starts, `change < 0` gives one back (maintenance), `0` clears it.
    /// Returns the attempts made before this call.
    pub(in crate::neo) fn note_plan_attempt(
        &self,
        plans: &PendingPlans,
        change: i64,
    ) -> Result<u32, EngineError> {
        let dir = self.root.create_child(".native-recovery-attempts")?;
        let name = format!(
            "{:x}.json",
            Sha256::digest(format!("{}/{}", plans.canonical, plans.digest).as_bytes())
        );
        let before = match journal_io::bytes(&dir, &name, &Cancel::never())? {
            None => 0,
            Some(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|value| value["attempts"].as_u64())
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(crate::capture::failure::MAX_RECOVERY_ATTEMPTS),
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
}
