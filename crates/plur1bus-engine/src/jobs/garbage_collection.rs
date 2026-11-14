//! The scheduled GC archives a full row before changing its status.
use super::{
    lance_scope::LanceScope,
    ledger::io,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{Cancel, EngineError, JobName, JobOutcome, MemoryRow, StoreError},
    recall::acl,
    store::{directory::TrustedDirectory, Store},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::BinaryHeap,
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const PAGE_SIZE: usize = 512;
const MAX_ARCHIVES_PER_RUN: usize = 256;
const MAX_SIZE_ENTRIES: usize = 50_000;
const MAX_ARCHIVE: usize = 8 * 1024 * 1024;
const MIB: f64 = 1_048_576.;

pub(crate) struct GarbageCollection {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub config: Value,
}

impl JobBody for GarbageCollection {
    fn name(&self) -> JobName {
        JobName::GcRun
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        if self.config["enabled"] == false {
            return Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("gc_disabled".into()),
            });
        }
        let policy = Policy {
            max_size: self.config["maxDbSizeMb"].as_f64(),
            max_count: self.config["maxMemoryCount"].as_f64(),
            min_strength: self.config["minMemoryStrength"].as_f64(),
        };
        if policy.max_size.is_none() && policy.max_count.is_none() && policy.min_strength.is_none()
        {
            return Ok(JobReport::completed());
        }
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(120));
        let authority = context.authority()?;
        let request = authority.request();
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, &cancel)? {
            return Ok(skip);
        }
        let _mutation = self.scope.operations.mutation()?;
        cancel.check()?;
        let Some(store) = self.scope.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let filter = LanceScope::filter(authority);
        let size = if policy.max_size.is_some() {
            size_mib(&store, &cancel)?
        } else {
            0.
        };
        let mut candidates = Candidates::default();
        let mut offset = 0;
        loop {
            cancel.check()?;
            let page = store.gc_rows(&filter, offset, PAGE_SIZE)?;
            let read = page.len();
            for row in page {
                if acl::allowed(&row, request).is_ok() {
                    candidates.observe(row, &policy, context.now_ms);
                }
            }
            if read < PAGE_SIZE {
                break;
            }
            offset = offset.checked_add(read).ok_or(StoreError::Unavailable)?;
        }
        let (rows, remaining) = candidates.select(&policy, size);
        if rows.is_empty() {
            return Ok(JobReport::completed());
        }
        let archive = self.archive_directory(request.agent_id.as_str())?;
        let mut archived = 0;
        for row in rows {
            if let Some(skip) = self.scope.check(authority, &cancel)? {
                return Ok(skip);
            }
            let Some(current) = store.get(&row.id)? else {
                continue;
            };
            let bytes = serde_json::to_vec_pretty(&row).map_err(|_| StoreError::Corrupt)?;
            if serde_json::to_vec_pretty(&current).map_err(|_| StoreError::Corrupt)? != bytes {
                continue;
            }
            backup(&archive, &row.id, &bytes, &cancel)?;
            if let Some(skip) = self.scope.check(authority, &cancel)? {
                return Ok(skip);
            }
            archived += store.archive_gc_row(&filter, &row)?;
        }
        context.note_count("archived", archived)?;
        Ok(if remaining {
            JobReport {
                outcome: JobOutcome::Incomplete,
                reason: Some("archive_batch_limit".into()),
            }
        } else {
            JobReport::completed()
        })
    }
}

impl GarbageCollection {
    fn archive_directory(&self, agent: &str) -> Result<TrustedDirectory, StoreError> {
        let parent = TrustedDirectory::open(self.base.parent().ok_or(StoreError::InvalidInput)?)?;
        let directory = parent.create_child("archive")?.create_child(agent)?;
        directory.restrict_private()?;
        Ok(directory)
    }
}

struct Policy {
    max_size: Option<f64>,
    max_count: Option<f64>,
    min_strength: Option<f64>,
}

fn strength(row: &MemoryRow) -> f64 {
    row.memory_strength.as_f64().unwrap_or(1.)
}

struct Candidate {
    strength: f64,
    created: f64,
    row: MemoryRow,
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.strength
            .total_cmp(&other.strength)
            .then_with(|| self.created.total_cmp(&other.created))
            .then_with(|| self.row.id.cmp(&other.row.id))
    }
}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Candidate {}

#[derive(Default)]
struct Candidates {
    count: usize,
    below_threshold: usize,
    weakest: BinaryHeap<Candidate>,
}

impl Candidates {
    fn observe(&mut self, row: MemoryRow, policy: &Policy, now: i64) {
        if !matches!(row.status.as_str(), "" | "active" | "superseded")
            || row.memory_class == "core"
            || row.never_forget.as_f64() == Some(1.)
        {
            return;
        }
        self.count += 1;
        let strength = strength(&row);
        if policy.min_strength.is_some_and(|min| strength < min) {
            self.below_threshold += 1;
        }
        let candidate = Candidate {
            strength,
            created: row.created_at.as_f64().unwrap_or(now as f64),
            row,
        };
        if self.weakest.len() < MAX_ARCHIVES_PER_RUN {
            self.weakest.push(candidate);
        } else if self
            .weakest
            .peek()
            .is_some_and(|current| &candidate < current)
        {
            self.weakest.pop();
            self.weakest.push(candidate);
        }
    }

    fn select(self, policy: &Policy, size: f64) -> (Vec<MemoryRow>, bool) {
        if self.count == 0 {
            return (vec![], false);
        }
        let count = self.count as f64;
        let from_size = policy
            .max_size
            .filter(|max| size > *max)
            .map_or(0., |max| ((size - max) / (size / count).max(0.0001)).ceil());
        let from_count = policy.max_count.map_or(0., |max| (count - max).ceil());
        let target =
            (from_size.max(from_count).clamp(0., count) as usize).max(self.below_threshold);
        let rows = self
            .weakest
            .into_sorted_vec()
            .into_iter()
            .take(target)
            .map(|candidate| candidate.row)
            .collect();
        (rows, target > MAX_ARCHIVES_PER_RUN)
    }
}

fn size_mib(store: &Store, cancel: &Cancel) -> Result<f64, EngineError> {
    let (path, expected) = store.physical_binding()?;
    let dir = TrustedDirectory::open(&path)?;
    if dir.identity_parts() != expected {
        return Err(StoreError::UntrustedPath.into());
    }
    let mut bytes = 0_u64;
    for (index, entry) in std::fs::read_dir(dir.path())
        .map_err(StoreError::from)?
        .enumerate()
    {
        cancel.check()?;
        if index >= MAX_SIZE_ENTRIES {
            return Err(StoreError::Unavailable.into());
        }
        let entry = entry.map_err(StoreError::from)?;
        if entry.file_type().map_err(StoreError::from)?.is_file() {
            bytes = bytes.saturating_add(entry.metadata().map_err(StoreError::from)?.len());
        }
    }
    dir.assert_unchanged()?;
    Ok((bytes as f64 / MIB * 100.).round() / 100.)
}

fn backup(
    dir: &TrustedDirectory,
    id: &str,
    bytes: &[u8],
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| StoreError::InvalidInput)?;
    if bytes.len() > MAX_ARCHIVE {
        return Err(StoreError::InvalidInput.into());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    let name = format!("memory-{id}-{}.json", &digest[..24]);
    if let Some(existing) = io::read(dir, &name, MAX_ARCHIVE, cancel)? {
        return if existing == bytes {
            Ok(())
        } else {
            Err(StoreError::Corrupt.into())
        };
    }
    // A retry reuses the exact archive. Stage and fsync before exposing the file.
    let staged = format!(
        ".{name}.{}.{:012x}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().as_u128() & 0xffff_ffff_ffff
    );
    let mut file = dir.create_file(&staged)?;
    let identity = crate::store::directory::regular_file_identity(&file)?;
    let result = (|| {
        for chunk in bytes.chunks(65_536) {
            cancel.check()?;
            file.write_all(chunk).map_err(StoreError::from)?;
        }
        file.sync_all().map_err(StoreError::from)?;
        drop(file);
        cancel.check()?;
        dir.replace_staged(&staged, &name, identity, None)?;
        Ok(())
    })();
    if result.is_err() && io::identity(dir, &staged).ok().flatten() == Some(identity) {
        let _ = dir.remove_file(&staged);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_weakest_rows_past_the_old_scan_limit() {
        let policy = Policy {
            max_size: None,
            max_count: Some(50_000.),
            min_strength: None,
        };
        let mut candidates = Candidates::default();
        for index in 0..50_002 {
            let mut row = crate::capture::row_defaults::schema_defaults(vec![]);
            row.id = format!("row-{index}");
            row.memory_strength = (50_002 - index).into();
            candidates.observe(row, &policy, 0);
        }
        let (selected, remaining) = candidates.select(&policy, 0.);
        assert!(!remaining);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].id, "row-50001");
        assert_eq!(selected[1].id, "row-50000");
    }
}
