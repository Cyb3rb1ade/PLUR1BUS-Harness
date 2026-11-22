//! `state/user-jobs.sqlite`: the two tables the `UserJobs` constructor creates with `CREATE TABLE IF NOT EXISTS` on every open
//! (`user_jobs` holds one job as JSON text, `user_job_runs` one run record). TypeScript has written exactly one schema since the
//! store was introduced and never reads or writes `user_version`, so there is nothing to migrate: a file a TypeScript core made
//! is the file this opens, and the schema text of a fresh file made here is the TypeScript text byte for byte.
//!
//! A file whose `user_version` is not 0 was written by a build that versions this store, which neither side does today: it is
//! refused (fail closed) before SQLite is told to change anything about it.
use crate::jobs::JobsError;
use crate::private_store;
use plur1bus_store::rusqlite::{Connection, OpenFlags};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec};
use std::path::Path;

/// The statements of the constructor, after its two pragmas.
pub const TABLES: &str = "CREATE TABLE IF NOT EXISTS user_jobs(id TEXT PRIMARY KEY, definition TEXT NOT NULL); CREATE TABLE IF NOT EXISTS user_job_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, record TEXT NOT NULL);";

/// The file's `user_version` without changing the file; 0 for a file that does not exist or is empty.
fn found_version(path: &Path) -> Result<i64, JobsError> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > 0 => {}
        _ => return Ok(0),
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Opens (and creates) the store.
pub fn open(path: &Path, secure_path: Option<&dyn Fn(&Path) -> bool>) -> Result<Store, JobsError> {
    #[cfg(not(unix))]
    if path != Path::new(":memory:") {
        private_store::prepare_owner_only(path, secure_path).map_err(|error| match error {
            private_store::PrepareError::Io(e) => {
                JobsError::Other(format!("cannot prepare the user jobs store: {e}"))
            }
            private_store::PrepareError::Permissions => {
                JobsError::Other("user jobs store permissions unavailable".into())
            }
        })?;
    }
    // No SQLite write, including journal configuration, precedes this version check.
    let found = found_version(path)?;
    if found != 0 {
        return Err(JobsError::Other(format!(
            "user-jobs store schema v{found} is newer than this core supports (v0)"
        )));
    }
    #[cfg(unix)]
    {
        private_store::prepare(path)
            .map_err(|e| JobsError::Other(format!("cannot prepare the user jobs store: {e}")))?;
        let _ = secure_path.unwrap_or(&private_store::default_secure)(path);
    }
    let owner = OwnerSpec {
        store: StoreSpec::new("user-jobs", 0),
        journal: Journal::Wal,
        schema: Schema::Unversioned,
        create: true,
    };
    let store = Store::open_owner(path, &owner)?;
    store.conn().execute_batch(TABLES)?;
    Ok(store)
}
