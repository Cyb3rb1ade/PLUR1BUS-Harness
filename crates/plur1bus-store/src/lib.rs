//! The SQLite conventions of the TypeScript core's stores, for the Rust core (Phase 4, P4-03).
//!
//! Package ruling 4: the Rust stores read and write the *same* files as the TypeScript core, and nothing is migrated in
//! Phase 4. So a [`Store`] opens an existing file only (it never creates one), checks `PRAGMA user_version` against the
//! version this build supports, and refuses a newer and an older file alike: the TypeScript core owns migrations until
//! the package that ports a store flips it. [`migrate`] exists for that flip and for parity tests; [`Store::open`] never
//! calls it.
//!
//! Every connection is set the way the TypeScript store sets its own (`node:sqlite`):
//! - `busy_timeout = 5000` and `journal_mode = WAL`;
//! - `foreign_keys` **explicitly**, to [`StoreSpec::foreign_keys`]. The bundled SQLite of `rusqlite` is built with
//!   `SQLITE_DEFAULT_FOREIGN_KEYS=1`, `node:sqlite` with 0 (P4-01 spike §3): left unset, a store whose TypeScript code
//!   never enables foreign keys would silently start enforcing them;
//! - `synchronous` and any further pragma the store's TypeScript code runs ([`StoreSpec::pragmas`]).
//!
//! Writes go through [`Store::write`]: `BEGIN IMMEDIATE`, so the write lock is taken up front and two writers serialise
//! (within the busy timeout) instead of failing half-way; `&mut self` keeps one writer per `Store`, and the core owns one
//! `Store` per file. Do not branch on `sqlite_version()`: Node 26 and the bundled build differ (3.54.1 vs 3.53.2), and
//! math SQL functions are not compiled in.
//!
//! **Start order behind the front door** (P4-10, plan obligation F4): the TypeScript core behind the Rust front door
//! (`core-legacy`) owns the stores and migrates them while it starts. The Rust core therefore opens a store lazily, on
//! its first use after `core-legacy` is ready, never at its own start. A store that is not there yet or still at an older
//! schema ([`StoreError::Missing`], [`StoreError::OlderSchema`]) is a core that is not ready for it: `E_CORE_UNAVAILABLE`,
//! reason `store-pending` (retry); one newer than this build ([`StoreError::NewerSchema`]) is `E_STORAGE`, reason
//! `store-newer`. [`StoreError::refusal`] is that mapping (`docs/errors.md`); a method that serves a store natively uses it.
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::unwrap_used))]

/// The `rusqlite` this crate links (bundled SQLite), so callers use the same version.
pub use rusqlite;

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The busy timeout of every connection, as the TypeScript stores set it.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// `PRAGMA synchronous` of a store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Synchronous {
    /// Not set: SQLite's compiled default (the TypeScript store does not set it either).
    Default,
    /// `NORMAL`.
    Normal,
    /// `FULL` (the approvals store: a decision that was reported must survive a crash).
    Full,
}

/// How one store is opened: what its TypeScript code does on every open.
#[derive(Clone, Debug)]
pub struct StoreSpec {
    /// The store's name, for messages (`session`, `approvals`).
    pub name: &'static str,
    /// The schema version (`PRAGMA user_version`) this build reads and writes.
    pub version: u32,
    /// `PRAGMA foreign_keys`: `true` only where the TypeScript store turns it on.
    pub foreign_keys: bool,
    /// `PRAGMA synchronous`.
    pub synchronous: Synchronous,
    /// Further statements the TypeScript store runs on open (`PRAGMA secure_delete = ON`, `PRAGMA temp_store = MEMORY`),
    /// run after the standard ones.
    pub pragmas: &'static [&'static str],
}

impl StoreSpec {
    /// A spec with foreign keys off, the default `synchronous` and no further pragmas.
    pub const fn new(name: &'static str, version: u32) -> Self {
        Self {
            name,
            version,
            foreign_keys: false,
            synchronous: Synchronous::Default,
            pragmas: &[],
        }
    }
}

/// Why a store could not be opened, written or migrated.
#[derive(Debug)]
pub enum StoreError {
    /// The file does not exist; Phase 4 never creates a store.
    Missing(PathBuf),
    /// The file was written by a newer schema than this build supports (fail closed, never downgraded).
    NewerSchema {
        /// The store.
        store: &'static str,
        /// Its `user_version`.
        found: u32,
        /// The version this build supports.
        supported: u32,
    },
    /// The file is at an older schema: the TypeScript core migrates it; the Rust core never migrates on its own in Phase 4.
    OlderSchema {
        /// The store.
        store: &'static str,
        /// Its `user_version`.
        found: u32,
        /// The version this build expects.
        expected: u32,
    },
    /// A migration step failed and was rolled back; the file stays at `to - 1`.
    Migration {
        /// The store.
        store: &'static str,
        /// The version the failed step was to reach.
        to: u32,
        /// What SQLite said.
        error: rusqlite::Error,
    },
    /// SQLite failed (including a constraint the store enforces).
    Sqlite(rusqlite::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(path) => write!(f, "store not found: {}", path.display()),
            Self::NewerSchema { store, found, supported } => write!(
                f,
                "{store} store schema v{found} is newer than this core supports (v{supported})"
            ),
            Self::OlderSchema { store, found, expected } => write!(
                f,
                "{store} store schema v{found} is older than v{expected}; the TypeScript core migrates it (Phase 4)"
            ),
            Self::Migration { store, to, error } => {
                write!(f, "{store} store migration to v{to} failed: {error}")
            }
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
        }
    }
}

impl StoreError {
    /// The RPC refusal for this error, `(code, reason)` (`docs/errors.md`, P4-10 task review L3): a store the legacy core
    /// has not created or migrated yet is `E_CORE_UNAVAILABLE` `store-pending`; a newer one `E_STORAGE` `store-newer`; a
    /// failed migration step or SQLite error `E_STORAGE` without a fixed reason.
    pub fn refusal(&self) -> (&'static str, Option<&'static str>) {
        match self {
            Self::Missing(_) | Self::OlderSchema { .. } => {
                ("E_CORE_UNAVAILABLE", Some("store-pending"))
            }
            Self::NewerSchema { .. } => ("E_STORAGE", Some("store-newer")),
            Self::Migration { .. } | Self::Sqlite(_) => ("E_STORAGE", None),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Migration { error, .. } | Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// One open store file: one connection, one writer.
pub struct Store {
    conn: Connection,
    spec: StoreSpec,
}

impl Store {
    /// Opens the existing store at `path`. The version is checked before anything is set, so a refused file is left exactly
    /// as it was (not even its journal mode changes); then WAL, the busy timeout, `foreign_keys`, `synchronous` and the
    /// store's own pragmas are set.
    pub fn open(path: &Path, spec: &StoreSpec) -> Result<Self, StoreError> {
        let conn = connect(path)?;
        let found = user_version(&conn)?;
        if found > spec.version {
            return Err(StoreError::NewerSchema {
                store: spec.name,
                found,
                supported: spec.version,
            });
        }
        if found < spec.version {
            return Err(StoreError::OlderSchema {
                store: spec.name,
                found,
                expected: spec.version,
            });
        }
        configure(&conn, spec)?;
        Ok(Self {
            conn,
            spec: spec.clone(),
        })
    }

    /// The connection, for reads. Writes go through [`Store::write`].
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// How this store was opened.
    pub fn spec(&self) -> &StoreSpec {
        &self.spec
    }

    /// `PRAGMA user_version` as it is now.
    pub fn user_version(&self) -> Result<u32, StoreError> {
        user_version(&self.conn)
    }

    /// Runs `f` in a `BEGIN IMMEDIATE` transaction: committed when `f` returns `Ok`, rolled back when it returns `Err`
    /// (or panics).
    pub fn write<T, E>(
        &mut self,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<T, StoreError>
    where
        StoreError: From<E>,
    {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}

/// Migrates the store at `path` explicitly; [`Store::open`] never calls this. `steps[v]` takes the schema from version `v`
/// to `v + 1` (the layout of the session store's `MIGRATIONS`); each missing step runs in its own `BEGIN IMMEDIATE`
/// transaction followed by `PRAGMA user_version = v + 1`, exactly like that store's `migrate()`. Returns the version
/// reached (`steps.len()`). A file newer than `steps.len()` is refused; a failed step is rolled back and reported.
pub fn migrate(path: &Path, spec: &StoreSpec, steps: &[&str]) -> Result<u32, StoreError> {
    let mut conn = connect(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let target = u32::try_from(steps.len()).unwrap_or(u32::MAX);
    let found = user_version(&conn)?;
    if found > target {
        return Err(StoreError::NewerSchema {
            store: spec.name,
            found,
            supported: target,
        });
    }
    configure(&conn, spec)?;
    apply_steps(&mut conn, spec, steps, found)
}

/// Runs `steps[from..]`, each in its own `BEGIN IMMEDIATE` transaction. `from` is the version read before the lock.
fn apply_steps(
    conn: &mut Connection,
    spec: &StoreSpec,
    steps: &[&str],
    from: u32,
) -> Result<u32, StoreError> {
    let target = u32::try_from(steps.len()).unwrap_or(u32::MAX);
    for (index, step) in steps.iter().enumerate().skip(from as usize) {
        let to = index as u32 + 1;
        let failed = |error| StoreError::Migration {
            store: spec.name,
            to,
            error,
        };
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(failed)?;
        // P4-03 review F5: the version read above predates the write lock. Another migrator (a TypeScript core, or a
        // second Rust one) may have applied this step while we waited for `BEGIN IMMEDIATE`; re-read it under the lock
        // and skip a step that is already in, so no DDL runs twice. (The TypeScript `migrate()` reads outside the
        // transaction too; recorded as P4D-1, contained because only one side migrates a store before its flip.)
        let now: u32 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(failed)?;
        // A newer migrator may have moved the file past this build's target meanwhile (P4-10 task review L2): checked
        // before the skip, or every remaining step would count as "already in" and a newer schema as migrated.
        if now > target {
            return Err(StoreError::NewerSchema {
                store: spec.name,
                found: now,
                supported: target,
            });
        }
        if now >= to {
            tx.commit().map_err(failed)?;
            continue;
        }
        tx.execute_batch(step).map_err(failed)?;
        tx.pragma_update(None, "user_version", to).map_err(failed)?;
        tx.commit().map_err(failed)?;
    }
    Ok(target)
}

/// Opens an existing file read-write, never creating it.
fn connect(path: &Path) -> Result<Connection, StoreError> {
    if !path.is_file() {
        return Err(StoreError::Missing(path.to_path_buf()));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Ok(Connection::open_with_flags(path, flags)?)
}

fn user_version(conn: &Connection) -> Result<u32, StoreError> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// The per-connection settings of [`Store::open`], in the order the TypeScript stores run them.
fn configure(conn: &Connection, spec: &StoreSpec) -> Result<(), StoreError> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String =
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
            format!("journal_mode is {mode}, not wal"),
        )));
    }
    conn.pragma_update(None, "foreign_keys", spec.foreign_keys)?;
    match spec.synchronous {
        Synchronous::Default => {}
        Synchronous::Normal => conn.pragma_update(None, "synchronous", "NORMAL")?,
        Synchronous::Full => conn.pragma_update(None, "synchronous", "FULL")?,
    }
    for statement in spec.pragmas {
        conn.execute_batch(statement)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P4-03 review F5: a step another migrator applied after our first read is skipped under the lock, never re-run.
    #[test]
    fn a_step_applied_meanwhile_is_skipped_not_run_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let other = Connection::open(&path).unwrap();
        other
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE a (x); PRAGMA user_version = 1;")
            .unwrap();
        let mut conn = connect(&path).unwrap();
        let steps = ["CREATE TABLE a (x)", "CREATE TABLE b (y)"];
        // `from` = 0 is what a migrator read before the other one applied step 1.
        let reached = apply_steps(&mut conn, &StoreSpec::new("s", 2), &steps, 0).unwrap();
        assert_eq!(reached, 2);
        assert_eq!(user_version(&conn).unwrap(), 2);
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
    }

    /// P4-10 task review L2: a newer migrator that took the file past this build's target while we waited for the lock
    /// is a newer schema, never "every step already in".
    #[test]
    fn a_file_a_newer_migrator_moved_past_the_target_is_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite");
        let other = Connection::open(&path).unwrap();
        other
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE a (x); CREATE TABLE b (y); CREATE TABLE c (z); PRAGMA user_version = 3;")
            .unwrap();
        let mut conn = connect(&path).unwrap();
        let steps = ["CREATE TABLE a (x)", "CREATE TABLE b (y)"];
        // `from` = 0 is what this migrator read before the newer one ran.
        let refused = apply_steps(&mut conn, &StoreSpec::new("s", 2), &steps, 0);
        assert!(
            matches!(
                refused,
                Err(StoreError::NewerSchema {
                    found: 3,
                    supported: 2,
                    ..
                })
            ),
            "{refused:?}"
        );
        assert_eq!(user_version(&conn).unwrap(), 3, "nothing was written");
    }

    /// P4-10 task review L3: the refusal of every error is fixed here (`docs/errors.md`), so a package that ports a store
    /// cannot pick another one.
    #[test]
    fn every_store_error_has_its_fixed_refusal() {
        let sqlite = || rusqlite::Error::InvalidQuery;
        for (error, refusal) in [
            (
                StoreError::Missing(PathBuf::from("x")),
                ("E_CORE_UNAVAILABLE", Some("store-pending")),
            ),
            (
                StoreError::OlderSchema {
                    store: "s",
                    found: 1,
                    expected: 2,
                },
                ("E_CORE_UNAVAILABLE", Some("store-pending")),
            ),
            (
                StoreError::NewerSchema {
                    store: "s",
                    found: 3,
                    supported: 2,
                },
                ("E_STORAGE", Some("store-newer")),
            ),
            (
                StoreError::Migration {
                    store: "s",
                    to: 2,
                    error: sqlite(),
                },
                ("E_STORAGE", None),
            ),
            (StoreError::Sqlite(sqlite()), ("E_STORAGE", None)),
        ] {
            assert_eq!(error.refusal(), refusal, "{error}");
        }
    }
}
