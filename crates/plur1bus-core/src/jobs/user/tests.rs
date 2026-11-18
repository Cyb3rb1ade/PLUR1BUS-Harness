//! Unit tests of the user-jobs store beside the recorded scenarios: the refusals that need a file to be arranged first.
use super::testing::{open, Ctx, ScriptedIds, World};
use super::UserJobs;
use serde_json::json;
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};

fn ctx(path: std::path::PathBuf) -> Rc<Ctx> {
    let world = World::from_json(&json!({"now": 1000, "principals": {}, "agents": ["main"]}));
    Rc::new(Ctx {
        w: Arc::new(Mutex::new(world)),
        path,
        ids: RefCell::new(Vec::new()),
    })
}

fn open_at(cx: &Rc<Ctx>) -> Result<UserJobs, crate::jobs::JobsError> {
    open(
        cx,
        &Rc::new(RefCell::new(Weak::new())),
        &Arc::new(ScriptedIds::default()),
    )
}

#[test]
fn a_store_of_a_newer_version_is_refused_and_left_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("user-jobs.sqlite");
    let cx = ctx(path.clone());
    open_at(&cx).unwrap().close();
    {
        let db = plur1bus_store::rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version = 3").unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let err = open_at(&cx).err().expect("refused");
    assert!(err.to_string().contains("newer"), "{err}");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(
        !dir.path().join("user-jobs.sqlite-wal").exists() || {
            // A WAL file a refused open left behind would mean it wrote to the store.
            std::fs::metadata(dir.path().join("user-jobs.sqlite-wal"))
                .unwrap()
                .len()
                == 0
        }
    );
}

#[cfg(unix)]
#[test]
fn the_store_file_and_its_directory_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("user-jobs.sqlite");
    let cx = ctx(path.clone());
    open_at(&cx).unwrap().close();
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
}

#[test]
fn a_closed_service_refuses_every_read_and_write() {
    let dir = tempfile::tempdir().unwrap();
    let cx = ctx(dir.path().join("user-jobs.sqlite"));
    let jobs = open_at(&cx).unwrap();
    jobs.close();
    assert!(jobs.has("user:x").is_err());
    assert!(jobs.get("user:x").is_err());
    // `tick` on a closed service is a no-op in TypeScript too (the scenario "audit-and-stop" records it).
    assert!(jobs.tick().is_ok());
}
