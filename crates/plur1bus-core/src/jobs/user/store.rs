//! `state/user-jobs.sqlite`: the two tables the `UserJobs` constructor creates with `CREATE TABLE IF NOT EXISTS` on every open
//! (`user_jobs` holds one job as JSON text, `user_job_runs` one run record). TypeScript has written exactly one schema since the
//! store was introduced and never reads or writes `user_version`, so there is nothing to migrate: a file a TypeScript core made
//! is the file this opens, and the schema text of a fresh file made here is the TypeScript text byte for byte.
//!
//! A file whose `user_version` is not 0 was written by a build that versions this store, which neither side does today: it is
//! refused (fail closed) before SQLite is told to change anything about it.
use crate::jobs::JobsError;
use crate::private_store;
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec};
use std::path::Path;

/// The statements of the constructor, after its two pragmas.
pub const TABLES: &str = "CREATE TABLE IF NOT EXISTS user_jobs(id TEXT PRIMARY KEY, definition TEXT NOT NULL); CREATE TABLE IF NOT EXISTS user_job_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, record TEXT NOT NULL);";

/// Opens (and creates) the store.
pub fn open(path: &Path, secure_path: Option<&dyn Fn(&Path) -> bool>) -> Result<Store, JobsError> {
    private_store::prepare_versioned(path, secure_path).map_err(|error| match error {
        private_store::PrepareError::Io(e) => {
            JobsError::Other(format!("cannot prepare the user jobs store: {e}"))
        }
        private_store::PrepareError::Permissions => {
            JobsError::Other("user jobs store permissions unavailable".into())
        }
    })?;
    let owner = OwnerSpec {
        store: StoreSpec::new("user-jobs", 0),
        journal: Journal::Wal,
        schema: Schema::Steps(&[]),
        create: true,
    };
    let store = private_store::open_versioned(path, &owner, || -> Result<(), JobsError> {
        let protected = private_store::protect_compatible(path, secure_path);
        if !protected && secure_path.is_some() {
            return Err(JobsError::Other(
                "user jobs store permissions unavailable".into(),
            ));
        }
        Ok(())
    })?;
    store.conn().execute_batch(TABLES)?;
    Ok(store)
}
