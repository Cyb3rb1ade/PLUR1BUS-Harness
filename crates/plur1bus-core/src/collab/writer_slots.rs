//! Writer admission for a shared CollabStore. The caller holds its SQLite write transaction
//! while counting and publishing leases. An OS lock makes released and abandoned leases reclaimable.

use super::errors::{CollabError, CollabErrorCode};
use super::store::R;
use crate::private_store::AdvisoryLease;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::Path;

pub(super) fn reserve(
    dir: &Path,
    project: &str,
    local: bool,
    project_limit: i64,
    local_limit: Option<f64>,
) -> R<Option<AdvisoryLease>> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(unavailable)?;
    if !fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && !is_redirect(&m)) {
        return Err(invalid_lease_dir());
    }

    let project = format!("{:x}", Sha256::digest(project.as_bytes()));
    let mut project_count = 0;
    let mut local_count = 0;
    let entries = fs::read_dir(dir)
        .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>())
        .map_err(unavailable)?;
    for entry in entries {
        let name = entry.file_name();
        let (project_key, tail) = name
            .to_str()
            .and_then(|name| name.split_once('.'))
            .ok_or_else(invalid_lease_dir)?;
        let (target, _) = tail.split_once('.').ok_or_else(invalid_lease_dir)?;
        let entry_local = match target {
            "local" => true,
            "remote" => false,
            _ => return Err(invalid_lease_dir()),
        };
        let lease = open_lease(&entry.path(), false)?;
        match lease.try_lock() {
            Ok(()) => {
                // No contender opens this path outside the admission transaction.
                drop(AdvisoryLease(lease));
                fs::remove_file(entry.path()).map_err(unavailable)?;
            }
            Err(TryLockError::WouldBlock) => {
                project_count += i64::from(project_key == project);
                local_count += i64::from(entry_local);
            }
            Err(TryLockError::Error(error)) => return Err(unavailable(error)),
        }
    }
    if project_count >= project_limit
        || local_limit.is_some_and(|limit| local_count as f64 >= limit)
    {
        return Ok(None);
    }
    let target = if local { "local" } else { "remote" };
    let path = dir.join(format!("{project}.{target}.{}", uuid::Uuid::new_v4()));
    let lease = open_lease(&path, true)?;
    lease.try_lock().map_err(unavailable)?;
    Ok(Some(AdvisoryLease(lease)))
}

fn open_lease(path: &Path, create: bool) -> R<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3).custom_flags(0x0020_0000);
    }
    let lease = options.open(path).map_err(unavailable)?;
    let metadata = lease.metadata().map_err(unavailable)?;
    if !metadata.is_file() || is_redirect(&metadata) {
        return Err(invalid_lease_dir());
    }
    Ok(lease)
}

fn is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn unavailable(_error: impl std::fmt::Display) -> CollabError {
    CollabError::new(
        CollabErrorCode::Storage,
        "writer slot storage is unavailable",
    )
}

fn invalid_lease_dir() -> CollabError {
    CollabError::new(CollabErrorCode::Storage, "writer slot directory is invalid")
}
