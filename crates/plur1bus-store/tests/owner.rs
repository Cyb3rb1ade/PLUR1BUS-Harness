//! Owner mode (`Store::open_owner`, P4-12 ruling R4): the open of a store the Rust core owns, on files in a temp dir.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_store::rusqlite::{self, Connection};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec};
use std::path::Path;

/// Two steps shaped like a TypeScript store's `MIGRATIONS`: several statements, `STRICT`, a partial unique index, and a
/// second step that drops a table of the first.
const STEPS: &[&str] = &[
    "CREATE TABLE humans (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
     CREATE TABLE links (id TEXT PRIMARY KEY, human_id TEXT NOT NULL REFERENCES humans(id), revoked_at INTEGER) STRICT;
     CREATE UNIQUE INDEX links_active ON links(human_id) WHERE revoked_at IS NULL;
     CREATE TABLE scratch (id TEXT PRIMARY KEY) STRICT;",
    "DROP TABLE scratch;
     CREATE TABLE notes (link_id TEXT PRIMARY KEY REFERENCES links(id), body TEXT) STRICT;",
];

fn versioned() -> OwnerSpec {
    OwnerSpec {
        store: StoreSpec {
            foreign_keys: true,
            pragmas: &["PRAGMA temp_store = MEMORY", "PRAGMA secure_delete = ON"],
            ..StoreSpec::new("owned", 2)
        },
        journal: Journal::Wal,
        schema: Schema::Steps(STEPS),
        create: false,
    }
}

fn unversioned() -> OwnerSpec {
    OwnerSpec {
        store: StoreSpec::new("plain", 0),
        journal: Journal::Unchanged,
        schema: Schema::Unversioned,
        create: false,
    }
}

fn touch(path: &Path) {
    std::fs::File::create(path).unwrap();
}

fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.pragma_query_value(None, name, |row| row.get(0))
        .unwrap()
}

fn journal_mode(conn: &Connection) -> String {
    conn.pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap()
}

fn tables(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    let names = stmt.query_map([], |row| row.get(0)).unwrap();
    names.map(Result::unwrap).collect()
}

#[test]
fn an_empty_file_is_migrated_to_the_target_and_set_up_as_the_typescript_store_does() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    touch(&path);
    let store = Store::open_owner(&path, &versioned()).unwrap();
    assert_eq!(store.user_version().unwrap(), 2);
    assert_eq!(tables(store.conn()), ["humans", "links", "notes"]);
    assert_eq!(journal_mode(store.conn()), "wal");
    assert_eq!(pragma_i64(store.conn(), "foreign_keys"), 1);
    assert_eq!(pragma_i64(store.conn(), "busy_timeout"), 5000);
    assert_eq!(pragma_i64(store.conn(), "temp_store"), 2);
    assert_eq!(pragma_i64(store.conn(), "secure_delete"), 1);
}

#[test]
fn a_second_open_runs_no_step_again_and_a_half_migrated_file_gets_only_the_missing_step() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    touch(&path);
    let mut first = Store::open_owner(&path, &versioned()).unwrap();
    first
        .write(|tx| tx.execute("INSERT INTO humans VALUES ('h', 'n')", []))
        .unwrap();
    drop(first);
    // Step 1 again would fail on `CREATE TABLE humans`; step 2 again on `DROP TABLE scratch`.
    let again = Store::open_owner(&path, &versioned()).unwrap();
    let rows: i64 = again
        .conn()
        .query_row("SELECT count(*) FROM humans", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);
    drop(again);

    let half = dir.path().join("half.sqlite");
    let conn = Connection::open(&half).unwrap();
    conn.execute_batch(STEPS[0]).unwrap();
    conn.execute_batch("PRAGMA user_version = 1").unwrap();
    drop(conn);
    let store = Store::open_owner(&half, &versioned()).unwrap();
    assert_eq!(store.user_version().unwrap(), 2);
    assert_eq!(tables(store.conn()), ["humans", "links", "notes"]);
}

#[test]
fn a_newer_file_is_refused_before_anything_about_it_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("newer.sqlite");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE future (x); PRAGMA user_version = 3;")
        .unwrap();
    drop(conn);
    let refused = Store::open_owner(&path, &versioned());
    assert!(
        matches!(
            refused,
            Err(StoreError::NewerSchema {
                store: "owned",
                found: 3,
                supported: 2
            })
        ),
        "{:?}",
        refused.err()
    );
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        journal_mode(&conn),
        "delete",
        "not even the journal mode changed"
    );
    assert_eq!(pragma_i64(&conn, "user_version"), 3);
    assert_eq!(tables(&conn), ["future"]);
}

#[test]
fn a_failing_step_is_rolled_back_and_the_file_stays_at_the_version_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bad.sqlite");
    touch(&path);
    const BAD: &[&str] = &["CREATE TABLE a (x) STRICT_TYPO;", "CREATE TABLE b (y);"];
    const GOOD_THEN_BAD: &[&str] = &[
        "CREATE TABLE a (x);",
        "CREATE TABLE b (y); CREATE TABLE a (x);",
    ];
    let spec = |steps| OwnerSpec {
        schema: Schema::Steps(steps),
        ..versioned()
    };
    let first = Store::open_owner(&path, &spec(BAD));
    assert!(
        matches!(first, Err(StoreError::Migration { to: 1, .. })),
        "{:?}",
        first.err()
    );
    let second = Store::open_owner(&path, &spec(GOOD_THEN_BAD));
    assert!(
        matches!(second, Err(StoreError::Migration { to: 2, .. })),
        "{:?}",
        second.err()
    );
    let conn = Connection::open(&path).unwrap();
    assert_eq!(pragma_i64(&conn, "user_version"), 1);
    assert_eq!(tables(&conn), ["a"], "table b of the failed step is gone");
}

#[test]
fn a_step_count_that_is_not_the_spec_version_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    touch(&path);
    let spec = OwnerSpec {
        store: StoreSpec::new("owned", 3),
        ..versioned()
    };
    assert!(matches!(
        Store::open_owner(&path, &spec),
        Err(StoreError::Sqlite(_))
    ));
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        0,
        "nothing written"
    );
}

#[test]
fn a_missing_file_is_created_only_when_the_spec_says_so_and_a_missing_directory_never() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent.sqlite");
    assert!(matches!(
        Store::open_owner(&path, &versioned()),
        Err(StoreError::Missing(_))
    ));
    assert!(!path.exists());
    let creating = OwnerSpec {
        create: true,
        ..versioned()
    };
    let store = Store::open_owner(&path, &creating).unwrap();
    assert_eq!(store.user_version().unwrap(), 2);
    drop(store);
    let nowhere = dir.path().join("no-such-dir").join("x.sqlite");
    assert!(matches!(
        Store::open_owner(&nowhere, &creating),
        Err(StoreError::Sqlite(_))
    ));
    assert!(!nowhere.parent().unwrap().exists());
}

#[test]
fn an_unversioned_store_keeps_its_journal_mode_and_its_user_version_is_not_looked_at() {
    let dir = tempfile::tempdir().unwrap();
    // A fresh file keeps SQLite's rollback journal, as a TypeScript store that never sets WAL leaves it.
    let fresh = dir.path().join("fresh.sqlite");
    touch(&fresh);
    let store = Store::open_owner(&fresh, &unversioned()).unwrap();
    store
        .conn()
        .execute_batch("CREATE TABLE IF NOT EXISTS t (x TEXT) STRICT")
        .unwrap();
    assert_eq!(journal_mode(store.conn()), "delete");
    assert_eq!(
        pragma_i64(store.conn(), "foreign_keys"),
        0,
        "explicitly off"
    );
    assert_eq!(pragma_i64(store.conn(), "busy_timeout"), 5000);
    assert_eq!(store.user_version().unwrap(), 0, "never written");
    drop(store);
    assert!(!dir.path().join("fresh.sqlite-wal").exists());

    // A file another opener put into WAL stays in WAL; a user_version this build does not know is not a refusal.
    let other = dir.path().join("other.sqlite");
    let conn = Connection::open(&other).unwrap();
    conn.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE t (x); PRAGMA user_version = 7;")
        .unwrap();
    drop(conn);
    let with_fk = OwnerSpec {
        store: StoreSpec {
            foreign_keys: true,
            ..StoreSpec::new("plain", 0)
        },
        ..unversioned()
    };
    let store = Store::open_owner(&other, &with_fk).unwrap();
    assert_eq!(journal_mode(store.conn()), "wal");
    assert_eq!(store.user_version().unwrap(), 7);
    assert_eq!(pragma_i64(store.conn(), "foreign_keys"), 1);
}

/// A service's own error: a refusal that is not a storage error, and a storage error carried through.
#[derive(Debug)]
enum ServiceError {
    Refused(&'static str),
    Storage(String),
}
impl From<StoreError> for ServiceError {
    fn from(error: StoreError) -> Self {
        Self::Storage(error.to_string())
    }
}
impl From<rusqlite::Error> for ServiceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

#[test]
fn write_with_commits_on_ok_rolls_back_on_the_callers_error_and_holds_the_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    touch(&path);
    let mut store = Store::open_owner(&path, &versioned()).unwrap();

    let refused: Result<(), ServiceError> = store.write_with(|tx| {
        tx.execute("INSERT INTO humans VALUES ('gone', 'n')", [])?;
        Err(ServiceError::Refused("no"))
    });
    assert!(matches!(refused, Err(ServiceError::Refused("no"))));

    // Commit state and refuse afterwards: the refusal travels inside `Ok`.
    let outcome: Result<Result<(), ServiceError>, ServiceError> = store.write_with(|tx| {
        tx.execute("INSERT INTO humans VALUES ('kept', 'n')", [])?;
        Ok(Err(ServiceError::Refused("counted")))
    });
    assert!(matches!(outcome, Ok(Err(ServiceError::Refused("counted")))));

    let broken: Result<(), ServiceError> = store.write_with(|tx| {
        tx.execute("INSERT INTO humans VALUES ('gone-too', 'n')", [])?;
        tx.execute("INSERT INTO links VALUES ('l', 'no-such-human', NULL)", [])?;
        Ok(())
    });
    assert!(
        matches!(&broken, Err(ServiceError::Storage(m)) if m.contains("FOREIGN KEY")),
        "{broken:?}"
    );

    let ids: Vec<String> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT id FROM humans ORDER BY id")
            .unwrap();
        let rows = stmt.query_map([], |row| row.get(0)).unwrap();
        rows.map(Result::unwrap).collect()
    };
    assert_eq!(ids, ["kept"]);

    // BEGIN IMMEDIATE: a second connection cannot start a write while the callback runs.
    let other = Connection::open(&path).unwrap();
    other.busy_timeout(std::time::Duration::ZERO).unwrap();
    let seen: Result<rusqlite::Result<usize>, ServiceError> =
        store.write_with(|_tx| Ok(other.execute("INSERT INTO humans VALUES ('late', 'n')", [])));
    let blocked = seen.unwrap();
    assert!(
        matches!(&blocked, Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DatabaseBusy),
        "{blocked:?}"
    );
}

#[test]
fn store_open_is_unchanged_by_owner_mode_and_still_never_migrates_or_creates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sqlite");
    assert!(matches!(
        Store::open(&path, &versioned().store),
        Err(StoreError::Missing(_))
    ));
    touch(&path);
    assert!(matches!(
        Store::open(&path, &versioned().store),
        Err(StoreError::OlderSchema {
            found: 0,
            expected: 2,
            ..
        })
    ));
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
}
