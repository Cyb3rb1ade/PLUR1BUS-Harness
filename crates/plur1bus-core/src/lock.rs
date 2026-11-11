//! The single-instance core lock on `state/core.lock` (ADR-012 §5): the same SQLite byte range the TypeScript core holds
//! with `BEGIN EXCLUSIVE` (`plur1bus_audit::lock::CoreLock`), so a Rust front door and a TypeScript core on one home
//! exclude each other. A lock another core holds is `E_LOCKED` with reason `core-lock-held` and exit code 3, which the
//! supervisor retries without counting it toward giving up (ruling H3-R13). A refused front door touches no run file.
use plur1bus_audit::lock::CoreLock;
use std::io;
use std::path::Path;

/// Why the lock was not taken.
#[derive(Debug)]
pub enum LockError {
    /// Another core holds it.
    Held,
    /// The file could not be opened or locked.
    Io(io::Error),
}

/// Takes the core lock, without waiting.
pub fn acquire(path: &Path) -> Result<CoreLock, LockError> {
    match CoreLock::try_acquire(path) {
        Ok(Some(lock)) => Ok(lock),
        Ok(None) => Err(LockError::Held),
        Err(e) => Err(LockError::Io(e)),
    }
}
