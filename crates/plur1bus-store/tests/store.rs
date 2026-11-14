//! The connection conventions of `plur1bus-store` on files created in a temp dir.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_store::rusqlite::{self, Connection, ErrorCode};
use plur1bus_store::{migrate, Store, StoreError, StoreSpec, Synchronous};
use std::path::{Path, PathBuf};

/// A store file at `user_version = version` with a declared but not enforced foreign key, as node:sqlite leaves it.
fn file(dir: &Path, name: &str, version: u32) -> PathBuf {
    let path = dir.join(name);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE p (id INTEGER PRIMARY KEY);
         CREATE TABLE c (pid INTEGER REFERENCES p(id));
         PRAGMA user_version = {version};"
    ))
    .unwrap();
    path
}

fn pragma_i64(store: &Store, name: &str) -> i64 {
    store
        .conn()
        .pragma_query_value(None, name, |row| row.get(0))
        .unwrap()
}

/// The bundled SQLite enforces foreign keys by default, and so does node:sqlite (P4-12; the P4-01 spike had recorded the
/// opposite for Node). The store sets the pragma explicitly all the same: if a rusqlite upgrade changes the compiled
/// default, the setting below still holds.
#[test]
fn the_bundled_sqlite_enforces_foreign_keys_unless_told_otherwise() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(dir.path(), "plain.sqlite", 1);
    let plain = Connection::open(&path).unwrap();
    let on: i64 = plain
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .unwrap();
    assert_eq!(
        on, 1,
        "rusqlite bundled is built with SQLITE_DEFAULT_FOREIGN_KEYS=1"
    );
}

#[test]
fn foreign_keys_are_on_by_default_as_in_node_sqlite_and_off_only_when_the_store_asks() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(dir.path(), "s.sqlite", 1);

    let spec = StoreSpec {
        foreign_keys: false,
        ..StoreSpec::new("test", 1)
    };
    let mut off = Store::open(&path, &spec).unwrap();
    assert_eq!(pragma_i64(&off, "foreign_keys"), 0);
    // A store that turns enforcement off: the orphan row is accepted.
    off.write(|tx| tx.execute("INSERT INTO c VALUES (7)", []))
        .unwrap();
    drop(off);

    // The default: what node:sqlite does with the same file (mode B asks Node, `tests/mode_b.rs`).
    let mut on = Store::open(&path, &StoreSpec::new("test", 1)).unwrap();
    assert_eq!(pragma_i64(&on, "foreign_keys"), 1);
    let err = on
        .write(|tx| tx.execute("INSERT INTO c VALUES (8)", []))
        .unwrap_err();
    assert!(
        matches!(&err, StoreError::Sqlite(e) if e.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)),
        "{err}"
    );
}

#[test]
fn every_connection_is_wal_with_a_five_second_busy_timeout_and_the_requested_synchronous() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(dir.path(), "s.sqlite", 2);
    for (synchronous, level) in [(Synchronous::Normal, 1), (Synchronous::Full, 2)] {
        let spec = StoreSpec {
            synchronous,
            pragmas: &["PRAGMA secure_delete = ON"],
            ..StoreSpec::new("test", 2)
        };
        let store = Store::open(&path, &spec).unwrap();
        let mode: String = store
            .conn()
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(pragma_i64(&store, "busy_timeout"), 5000);
        assert_eq!(pragma_i64(&store, "synchronous"), level);
        assert_eq!(
            pragma_i64(&store, "secure_delete"),
            1,
            "the store's own pragmas run"
        );
    }
}

#[test]
fn an_equal_user_version_opens_and_a_newer_or_older_one_is_refused_without_touching_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(dir.path(), "s.sqlite", 3);
    let before = std::fs::read(&path).unwrap();

    let err = Store::open(&path, &StoreSpec::new("session", 2))
        .err()
        .unwrap();
    assert!(
        matches!(
            err,
            StoreError::NewerSchema {
                found: 3,
                supported: 2,
                ..
            }
        ),
        "{err}"
    );
    let err = Store::open(&path, &StoreSpec::new("session", 4))
        .err()
        .unwrap();
    assert!(
        matches!(
            err,
            StoreError::OlderSchema {
                found: 3,
                expected: 4,
                ..
            }
        ),
        "{err}"
    );
    // A refusal neither migrates nor switches the journal mode.
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!dir.path().join("s.sqlite-wal").exists());

    let store = Store::open(&path, &StoreSpec::new("session", 3)).unwrap();
    assert_eq!(store.user_version().unwrap(), 3);
}

#[test]
fn a_missing_file_is_refused_and_not_created() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent.sqlite");
    let err = Store::open(&path, &StoreSpec::new("test", 1))
        .err()
        .unwrap();
    assert!(
        matches!(&err, StoreError::Missing(p) if p == &path),
        "{err}"
    );
    assert!(!path.exists());
}

/// `BEGIN IMMEDIATE`: the write lock is taken when the transaction starts, so a second writer is refused at once (its
/// busy timeout is zero here) even before this one has written anything.
#[test]
fn a_write_holds_the_write_lock_from_its_start_and_rolls_back_on_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(dir.path(), "s.sqlite", 1);
    let mut store = Store::open(&path, &StoreSpec::new("test", 1)).unwrap();
    let other = Connection::open(&path).unwrap();
    other.busy_timeout(std::time::Duration::ZERO).unwrap();
    store
        .write(|tx| {
            assert!(!tx.is_autocommit());
            let err = other.execute_batch("BEGIN IMMEDIATE").unwrap_err();
            assert_eq!(err.sqlite_error_code(), Some(ErrorCode::DatabaseBusy));
            Ok::<_, StoreError>(())
        })
        .unwrap();

    let failed: Result<(), StoreError> = store.write(|tx| {
        tx.execute("INSERT INTO p VALUES (1)", [])?;
        Err(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
    });
    assert!(failed.is_err());
    let rows: i64 = store
        .conn()
        .query_row("SELECT count(*) FROM p", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0, "the failed write was rolled back");
}

/// The explicit runner (never called by `Store::open`): each step in its own IMMEDIATE transaction followed by
/// `user_version = n`, like the session store's `migrate()`; a newer file is refused.
#[test]
fn migrate_applies_the_missing_steps_one_transaction_each_and_refuses_a_newer_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("m.sqlite");
    Connection::open(&path).unwrap();
    let steps = [
        "CREATE TABLE a (x INTEGER)",
        "CREATE TABLE b (y INTEGER)",
        "CREATE TABLE c (z INTEGER)",
    ];
    let spec = StoreSpec::new("test", 3);
    assert_eq!(migrate(&path, &spec, &steps[..1]).unwrap(), 1);
    assert_eq!(migrate(&path, &spec, &steps).unwrap(), 3);
    let store = Store::open(&path, &spec).unwrap();
    let tables: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 3);
    drop(store);

    // A failing step leaves the file at the last good version.
    let bad = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE a (x INTEGER)"];
    let other = dir.path().join("bad.sqlite");
    Connection::open(&other).unwrap();
    let err = migrate(&other, &spec, &bad).unwrap_err();
    assert!(matches!(err, StoreError::Migration { to: 2, .. }), "{err}");
    let conn = Connection::open(&other).unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);

    let err = migrate(&path, &spec, &steps[..2]).unwrap_err();
    assert!(
        matches!(
            err,
            StoreError::NewerSchema {
                found: 3,
                supported: 2,
                ..
            }
        ),
        "{err}"
    );
}
