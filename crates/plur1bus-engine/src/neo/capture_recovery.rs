//! Bounded inventory of private native pending files; filenames and stored callers confer no grant.
use super::*;
use crate::neo::{
    caller::{self, Caller},
    derived_fields::{field, validate_object},
};
use crate::text::json::parse_json;
use std::{collections::HashSet, fs};
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
impl CaptureJournal {
    /// Read-only inventory. All active identities/locations are preflighted before any replay.
    pub(in crate::neo) fn recovery_callers(
        &self,
        cancel: &Cancel,
    ) -> Result<Vec<Caller>, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let Some(workspaces) = optional(self.root.open_child("workspaces"))? else {
            return Ok(vec![]);
        };
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut scanned = 0;
        for entry in fs::read_dir(workspaces.path()).map_err(StoreError::from)? {
            cancel.check()?;
            scanned += 1;
            if scanned > journal_io::MAX_ROWS {
                return Err(StoreError::Unavailable.into());
            }
            let entry = entry.map_err(StoreError::from)?;
            let kind = entry.file_type().map_err(StoreError::from)?;
            if kind.is_symlink() {
                return Err(StoreError::UntrustedPath.into());
            }
            if !kind.is_dir() {
                continue;
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| StoreError::UntrustedPath)?;
            let directory = workspaces.open_child(&name)?;
            for item in fs::read_dir(directory.path()).map_err(StoreError::from)? {
                cancel.check()?;
                scanned += 1;
                if scanned > journal_io::MAX_ROWS {
                    return Err(StoreError::Unavailable.into());
                }
                let item = item.map_err(StoreError::from)?;
                let filename = item
                    .file_name()
                    .into_string()
                    .map_err(|_| StoreError::UntrustedPath)?;
                let Some(prefix) = pending_kind(&filename)? else {
                    continue;
                };
                let bytes =
                    journal_io::bytes(&directory, &filename, cancel)?.ok_or(StoreError::Corrupt)?;
                let value =
                    parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
                        .map_err(|_| StoreError::Corrupt)?;
                let Some(caller) = active_caller(&value, prefix != "native-capture-pending-")?
                else {
                    continue;
                };
                let binding = self.bind(&caller.principal, &caller.agent)?;
                let expected = binding.file.replace("native-capture-pending-", prefix);
                if binding.proof != *field(&value, "ownership")?
                    || binding.layout.canonical != name
                    || expected != filename
                {
                    return Err(StoreError::Corrupt.into());
                }
                let actual = self
                    .directory(&binding, false)?
                    .ok_or(StoreError::Corrupt)?;
                if actual.identity_parts() != directory.identity_parts() {
                    return Err(StoreError::UntrustedPath.into());
                }
                directory.assert_unchanged()?;
                if seen.insert(binding.file) {
                    if out.len() == MAX_CALLERS {
                        return Err(StoreError::Unavailable.into());
                    }
                    out.push(caller);
                }
            }
            directory.assert_unchanged()?;
            workspaces.assert_unchanged()?;
        }
        self.root.assert_unchanged()?;
        workspaces.assert_unchanged()?;
        cancel.check()?;
        Ok(out)
    }
}
