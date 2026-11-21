use crate::budget::{Clock, UuidIds};
use crate::collab::{ids::SystemIds, CollabStore, StoreOptions};
use crate::decision::receipts::{ReceiptStore, ReceiptStoreOptions, Retention};
use crate::dreams::store::DreamStore;
use crate::sessions::SessionStore;
use crate::skill_mining::evidence;
use plur1bus_store::rusqlite::{self, ErrorCode, OptionalExtension};
use plur1bus_store::{Store, StoreError};
use std::fs;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> i64 {
        1_700_000_000_000
    }
}

fn open(name: &str, path: &Path, use_fixture_permissions: bool) -> Result<Store, String> {
    // Empty, synthetic databases in the test's own temp directory. Deliberately
    // no assertion about the ACL of a production file.
    let fixture = |p: &Path| p == path;
    let hook = use_fixture_permissions.then_some(&fixture as &dyn Fn(&Path) -> bool);
    match name {
        "sessions" => {
            SessionStore::open_with_permissions(path, Arc::new(FixedClock), Arc::new(UuidIds), hook)
                .map(SessionStore::into_test_store)
                .map_err(|e| e.to_string())
        }
        "delivery" => crate::delivery::store::open(path, hook).map_err(|e| e.to_string()),
        "handoff" => crate::handoff::store::open(path, hook).map_err(|e| e.to_string()),
        "jobs" => crate::jobs::user::store::open(path, hook).map_err(|e| e.to_string()),
        "collab" => CollabStore::open_with_permissions(
            path,
            StoreOptions::new(Arc::new(FixedClock), Arc::new(SystemIds)),
            hook,
        )
        .map(CollabStore::into_test_store)
        .map_err(|e| e.to_string()),
        "receipts" => ReceiptStore::open(ReceiptStoreOptions {
            path: path.into(),
            clock: Arc::new(FixedClock),
            ids: Some(Arc::new(UuidIds)),
            retention: Retention::default(),
            secure_path: use_fixture_permissions.then(|| {
                let expected = path.to_owned();
                Box::new(move |p: &Path| p == expected) as crate::delivery::SecurePath
            }),
        })
        .map(ReceiptStore::into_test_store)
        .map_err(|e| e.to_string()),
        "dreams" => match hook {
            Some(f) => DreamStore::open_with_permissions(path, f),
            None => DreamStore::open(path),
        }
        .map(DreamStore::into_test_store)
        .map_err(|e| e.to_string()),
        "skill-mining" => match hook {
            Some(f) => evidence::Store::open_with_permissions(path, f),
            None => evidence::Store::open(path),
        }
        .map(evidence::Store::into_test_store)
        .map_err(|e| e.to_string()),
        _ => panic!("unknown store {name}"),
    }
}

fn signal(dir: &Path, name: &str) {
    fs::write(dir.join(name), []).unwrap();
}

fn await_signal(dir: &Path, name: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !dir.join(name).exists() {
        assert!(Instant::now() < deadline, "timed out waiting for {name}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

// A scoped test table exercises a read/decide/write transaction on each real
// owner's connection without adding a constraint that could mask a lock bug.
fn claim(tx: &rusqlite::Transaction<'_>, candidate: &str) -> rusqlite::Result<String> {
    let prior = tx
        .query_row("SELECT winner FROM test_writer_claim", [], |r| r.get(0))
        .optional()?;
    if let Some(winner) = prior {
        return Ok(winner);
    }
    tx.execute("INSERT INTO test_writer_claim VALUES (?1)", [candidate])?;
    Ok(candidate.into())
}

#[test]
fn writer_process() {
    let Some(dir) = std::env::var_os("PLUR1BUS_K12_WRITER_TEST_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let name = std::env::var("PLUR1BUS_K12_WRITER_TEST_STORE").unwrap();
    let role = std::env::var("PLUR1BUS_K12_WRITER_TEST_ROLE").unwrap();
    let mut db = open(&name, &dir.join("owner.sqlite"), true).unwrap();
    if role == "first" {
        db.conn()
            .execute("CREATE TABLE test_writer_claim (winner TEXT NOT NULL)", [])
            .unwrap();
        signal(dir, "first-ready");
        await_signal(dir, "second-ready");
        let winner = db
            .write(|tx| -> rusqlite::Result<_> {
                let winner = claim(tx, "first")?;
                signal(dir, "holding");
                await_signal(dir, "release");
                Ok(winner)
            })
            .unwrap();
        assert_eq!(winner, "first");
        signal(dir, "committed");
    } else {
        signal(dir, "second-ready");
        await_signal(dir, "holding");
        db.conn().busy_timeout(Duration::ZERO).unwrap();
        let attempt = db.write(|_| Ok::<_, rusqlite::Error>(()));
        signal(dir, "attempted");
        assert!(
            matches!(
                attempt,
                Err(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e, _)))
                    if e.code == ErrorCode::DatabaseBusy
            ),
            "transaction began while the writer held the lock: {attempt:?}"
        );
        await_signal(dir, "committed");
        assert_eq!(db.write(|tx| claim(tx, "second")).unwrap(), "first");
        let rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM test_writer_claim", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }
}

struct Worker(Child);

impl Worker {
    fn spawn(dir: &Path, name: &str, role: &str) -> Self {
        Self(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "private_store::tests::writer_process",
                    "--nocapture",
                ])
                .env("PLUR1BUS_K12_WRITER_TEST_DIR", dir)
                .env("PLUR1BUS_K12_WRITER_TEST_STORE", name)
                .env("PLUR1BUS_K12_WRITER_TEST_ROLE", role)
                .spawn()
                .unwrap(),
        )
    }

    fn check(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success(), "writer {status}");
                return;
            }
            assert!(Instant::now() < deadline, "writer did not exit");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn assert_two_writers(name: &str) {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let mut first = Worker::spawn(dir, name, "first");
    await_signal(dir, "first-ready");
    let mut second = Worker::spawn(dir, name, "second");
    await_signal(dir, "attempted");
    signal(dir, "release");
    first.check();
    second.check();
}

macro_rules! owners {
    ($($test:ident => $name:literal),+ $(,)?) => {
        $(
            #[test]
            fn $test() {
                assert_two_writers($name);
            }
        )+

        #[cfg(windows)]
        #[test]
        fn no_windows_owner_opens_without_a_verified_acl() {
            for name in [$($name),+] {
                let temp = tempfile::tempdir().unwrap();
                let path = temp.path().join("owner.sqlite");
                assert!(open(name, &path, false).is_err(), "{name}");
                assert!(!path.exists(), "{name} created a file without an ACL");
            }
        }
    };
}

owners!(
    sessions => "sessions",
    delivery => "delivery",
    handoff => "handoff",
    jobs => "jobs",
    collab => "collab",
    receipts => "receipts",
    dreams => "dreams",
    skill_mining => "skill-mining",
);
