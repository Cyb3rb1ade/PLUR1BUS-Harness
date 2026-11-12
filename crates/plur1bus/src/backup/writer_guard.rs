//! Offline restore participates in the existing writer protocols, without editing holder
//! rows, nonces, pid files or tokens. OS-held fences cover the whole mutation/rollback.
use super::BackupError;
use crate::paths::Layout;
use rusqlite::{Connection, OpenFlags};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;
use std::time::Duration;

pub(super) struct WriterGuard {
    _core: Connection,
    _processes: Vec<File>,
}

fn busy() -> BackupError {
    BackupError::new("core-running", "a core, import, supervisor or engine writer holds this home's lock; stop it before restoring")
}

fn sql_error(error: rusqlite::Error) -> BackupError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => busy(),
        _ => BackupError::new("io", format!("cannot fence the core writer: {error}")),
    }
}

/// Reject links and special files before opening: these lock names must stay in this
/// home's ordinary state/run directories. Missing paths are created only after every
/// existing fence was acquired, so an already-active writer causes no metadata writes.
fn ordinary(path: &Path, directory: bool) -> Result<bool, BackupError> {
    match fs::symlink_metadata(path) {
        Ok(m) if (directory && m.is_dir()) || (!directory && m.is_file()) => Ok(true),
        Ok(_) => Err(BackupError::new(
            "io",
            "restore writer lock path is not an ordinary file or directory",
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn process_lock(path: &Path, create: bool) -> Result<File, BackupError> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(create).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = opts.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(BackupError::new("io", "invalid process writer lock"));
    }
    file.try_lock().map_err(|e| match e {
        fs::TryLockError::WouldBlock => busy(),
        fs::TryLockError::Error(e) => BackupError::from(e),
    })?;
    Ok(file)
}

fn core_lock(path: &Path, create: bool) -> Result<Connection, BackupError> {
    // SQLite NOFOLLOW rejects aliases in any component, including macOS /var ->
    // /private/var. Resolve the checked ordinary parent, never the lock leaf itself.
    let parent = path
        .parent()
        .ok_or_else(|| BackupError::new("io", "writer lock has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| BackupError::new("io", "writer lock has no name"))?;
    let path = fs::canonicalize(parent)?.join(name);
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let db = Connection::open_with_flags(&path, flags).map_err(sql_error)?;
    db.busy_timeout(Duration::ZERO).map_err(sql_error)?;
    // Same kernel byte-range locking as module-api/acquireExclusiveLock. No holder
    // table writes: even a refused second admission preserves the owner's exact bytes.
    db.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;")
        .map_err(sql_error)?;
    Ok(db)
}

fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

impl WriterGuard {
    pub(super) fn acquire(layout: &Layout) -> Result<Self, BackupError> {
        ordinary(&layout.state(), true)?;
        ordinary(&layout.run(), true)?;
        let core_path = layout.state().join("core.lock");
        let paths = [
            layout.supervisor_lock(),
            layout.run().join("engine.process.lock"),
        ];
        let core_exists = ordinary(&core_path, false)?;
        let mut present = Vec::new();
        for path in &paths {
            present.push(ordinary(path, false)?);
        }
        let mut core = if core_exists {
            Some(core_lock(&core_path, false)?)
        } else {
            None
        };
        let mut processes = Vec::new();
        for (path, exists) in paths.iter().zip(&present) {
            if *exists {
                processes.push(process_lock(path, false)?);
            }
        }
        // Existing writers have all been excluded. A racing new writer either obtains
        // the same lock first (we refuse), or waits/fails while these handles are alive.
        if core.is_none() {
            private_directory(&layout.state())?;
            core = Some(core_lock(&core_path, true)?);
        }
        for (path, exists) in paths.iter().zip(present) {
            if !exists {
                private_directory(&layout.run())?;
                processes.push(process_lock(path, true)?);
            }
        }
        Ok(Self {
            _core: core.expect("core lock acquired"),
            _processes: processes,
        })
    }
}

impl Drop for WriterGuard {
    fn drop(&mut self) {
        // Never unlink permanent lock files: a starter may already hold their inode.
        let _ = self._core.execute_batch("ROLLBACK");
    }
}

#[cfg(test)]
#[path = "writer_guard_tests.rs"]
mod tests;
