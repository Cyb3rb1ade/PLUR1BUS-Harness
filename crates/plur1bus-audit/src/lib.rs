//! The audit chain writer (`logs/audit-chain.jsonl` and its anchor), shared by the CLI and the Rust core (Phase 4, P4-03).
//!
//! Moved out of `crates/plur1bus/src/audit_chain.rs` (with `create_private` and `now_ms` from `audit.rs`) so that the CLI and
//! `plur1bus-core` write one chain with one implementation and one process-wide writer lock. The file formats, the SQLite
//! byte-range lock that conflicts with the TypeScript core's `BEGIN EXCLUSIVE`, and every refusal are unchanged; see
//! `docs/audit-chain.md`.
//!
//! [`lock::CoreLock`] (P4-10) takes the core's single-instance lock on `state/core.lock` with the same byte-range primitive, so
//! the Rust front door and a TypeScript core exclude each other.
//!
//! This crate is not `forbid(unsafe_code)`: the byte-range lock is `fcntl(F_SETLK)` on Unix and `LockFileEx` on Windows.
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod chain;
pub mod lock;

use std::fs;
use std::io;
use std::path::Path;

/// Opens `path` for writing, creating it private to the user: mode 0600 on unix (also applied to an existing file),
/// a protected DACL for the user and SYSTEM on Windows, set before any content is written. `truncate` empties an
/// existing file; without it, a new file is created and an existing one is left as it is (`create_new` semantics are
/// not needed by the callers).
pub fn create_private(path: &Path, truncate: bool) -> io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::GENERIC_WRITE;
        use windows_sys::Win32::Storage::FileSystem::WRITE_DAC;
        o.access_mode(GENERIC_WRITE | WRITE_DAC);
    }
    let f = o.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        plur1bus_rpc::win::restrict_to_user(f.as_raw_handle())?;
    }
    Ok(f)
}

/// Milliseconds since the Unix epoch; 0 when the clock is before it.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
