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

#[test]
fn a_different_manager_can_edit_without_changing_the_execution_identity() {
    use super::testing::caller_of;
    use crate::approvals::js_json::J;

    let directory = tempfile::tempdir().unwrap();
    let cx = ctx(directory.path().join("user-jobs.sqlite"));
    let owner = json!({"userId":"owner", "role":"owner", "kind":"person"});
    let editor = json!({"userId":"editor", "role":"admin", "kind":"person"});
    cx.w.lock().unwrap().principals = vec![
        ("owner".into(), owner.clone()),
        ("editor".into(), editor.clone()),
    ];
    let jobs = open_at(&cx).unwrap();
    let job = jobs
        .create(
            &J::from_value(&json!({
                "agentId": "main", "name": "Calendar fixture", "prompt": "Summarize",
                "enabled": true, "schedule": {"cron": "0 9 * * *", "timezone": "UTC"}
            })),
            &caller_of(&owner),
        )
        .unwrap();
    let id = job.get("id").unwrap().as_str().unwrap();
    jobs.update(
        &J::from_value(&json!({"id":id,"name":"Renamed"})),
        &caller_of(&editor),
    )
    .unwrap();
    let stored = jobs.get(id).unwrap();
    assert_eq!(stored.get("name").and_then(J::as_str), Some("Renamed"));
    assert_eq!(stored.get("runAs").and_then(J::as_str), Some("owner"));
    assert_eq!(
        cx.w.lock().unwrap().audit.last().unwrap().action,
        "jobs.updated"
    );
}

#[test]
fn taking_over_a_job_requires_manage_and_a_successful_audit() {
    use super::testing::caller_of;
    use crate::approvals::js_json::J;

    let directory = tempfile::tempdir().unwrap();
    let cx = ctx(directory.path().join("user-jobs.sqlite"));
    let owner = json!({"userId":"owner", "role":"owner", "kind":"person"});
    let editor = json!({"userId":"editor", "role":"admin", "kind":"person"});
    let user = json!({"userId":"user", "role":"user", "kind":"person"});
    cx.w.lock().unwrap().principals = vec![
        ("owner".into(), owner.clone()),
        ("editor".into(), editor.clone()),
        ("user".into(), user.clone()),
    ];
    let jobs = open_at(&cx).unwrap();
    let job = jobs
        .create(
            &J::from_value(&json!({
                "agentId": "main", "name": "Calendar fixture", "prompt": "Summarize",
                "enabled": true, "schedule": {"cron": "0 9 * * *", "timezone": "UTC"}
            })),
            &caller_of(&owner),
        )
        .unwrap();
    let id = job.get("id").unwrap().as_str().unwrap();
    assert!(jobs.take_over(id, &caller_of(&user)).is_err());
    let use_only =
        json!({"userId":"editor","role":"member","kind":"person","agentRights":{"main":"use"}});
    assert_eq!(
        jobs.take_over(id, &caller_of(&use_only))
            .unwrap_err()
            .code(),
        Some("E_DENIED")
    );
    cx.w.lock().unwrap().principals = vec![("editor".into(), use_only)];
    assert_eq!(
        jobs.take_over(id, &caller_of(&editor)).unwrap_err().code(),
        Some("E_DENIED")
    );
    cx.w.lock().unwrap().principals = vec![("editor".into(), editor.clone())];
    cx.w.lock().unwrap().audit_fail = true;
    assert!(jobs.take_over(id, &caller_of(&editor)).is_err());
    assert_eq!(
        jobs.get(id).unwrap().get("runAs").and_then(J::as_str),
        Some("owner")
    );
    cx.w.lock().unwrap().audit_fail = false;
    let changed = jobs.take_over(id, &caller_of(&editor)).unwrap();
    assert_eq!(changed.get("runAs").and_then(J::as_str), Some("editor"));
    assert_eq!(changed.get("nextRunAt"), job.get("nextRunAt"));
    assert_eq!(
        cx.w.lock().unwrap().audit.last().unwrap().action,
        "jobs.runAs.changed"
    );
}

#[test]
fn two_connections_dispatch_one_scheduled_slot() {
    use super::testing::{caller_of, options};
    use crate::approvals::js_json::J;
    use std::cell::Cell;

    let directory = tempfile::tempdir().unwrap();
    let cx = ctx(directory.path().join("user-jobs.sqlite"));
    let person = json!({"userId":"human", "role":"owner", "kind":"person"});
    cx.w.lock()
        .unwrap()
        .principals
        .push(("human".into(), person.clone()));
    let owner = caller_of(&person);
    let me = Rc::new(RefCell::new(Weak::new()));
    let ids = Arc::new(ScriptedIds::default());
    let second = Rc::new(UserJobs::open(options(&cx, &me, &ids)).unwrap());
    let mut first_options = options(&cx, &me, &ids);
    let reached_second = Rc::new(Cell::new(false));
    let called = Rc::clone(&reached_second);
    let other = Rc::clone(&second);
    first_options.display_name = Some(Box::new(move |_| {
        other.tick()?;
        called.set(true);
        Ok(None)
    }));
    let first = UserJobs::open(first_options).unwrap();
    let job = first
        .create(
            &J::from_value(&json!({
                "agentId": "main", "name": "Calendar fixture", "prompt": "Summarize",
                "enabled": true, "schedule": {"cron": "* * * * *", "timezone": "UTC"}
            })),
            &owner,
        )
        .unwrap();
    cx.w.lock().unwrap().now = job.get("nextRunAt").unwrap().as_f64().unwrap() as i64;

    first.tick().unwrap();

    assert!(reached_second.get());
    assert_eq!(
        cx.w.lock()
            .unwrap()
            .events
            .iter()
            .filter(|event| event.get("turn").is_some())
            .count(),
        1
    );
    assert_eq!(
        second
            .history(job.get("id").unwrap().as_str(), &owner, None)
            .unwrap()
            .len(),
        1
    );
}

fn scheduled_owner(cx: &Ctx) -> crate::rbac::types::Principal {
    let person = json!({"userId":"human", "role":"owner", "kind":"person"});
    cx.w.lock()
        .unwrap()
        .principals
        .push(("human".into(), person.clone()));
    super::testing::caller_of(&person)
}

#[test]
fn scheduled_tick_child() {
    let Some(path) = std::env::var_os("PLUR1BUS_K7A_TEST_JOB") else {
        return;
    };
    let cx = ctx(path.into());
    scheduled_owner(&cx);
    cx.w.lock().unwrap().now = std::env::var("PLUR1BUS_K7A_TEST_NOW")
        .unwrap()
        .parse()
        .unwrap();
    open_at(&cx).unwrap().tick().unwrap();
    assert_eq!(
        cx.w.lock()
            .unwrap()
            .events
            .iter()
            .filter(|event| event.get("turn").is_some())
            .count(),
        1
    );
}

#[test]
fn two_processes_dispatch_one_scheduled_slot() {
    use crate::approvals::js_json::J;
    use crate::private_store::tests::Worker;

    let temp = tempfile::tempdir().unwrap();
    let cx = ctx(temp.path().join("jobs.sqlite"));
    let owner = scheduled_owner(&cx);
    let me = Rc::new(RefCell::new(Weak::new()));
    let ids = Arc::new(ScriptedIds::default());
    let mut options = super::testing::options(&cx, &me, &ids);
    let child_cx = cx.clone();
    options.display_name = Some(Box::new(move |_| {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "jobs::user::tests::scheduled_tick_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_K7A_TEST_JOB", &child_cx.path)
            .env(
                "PLUR1BUS_K7A_TEST_NOW",
                child_cx.w.lock().unwrap().now.to_string(),
            )
            .spawn()
            .unwrap();
        Worker(child).check();
        Ok(None)
    }));
    let parent = UserJobs::open(options).unwrap();
    let job = parent
        .create(
            &J::from_value(&json!({
                "agentId":"main","name":"Scheduled fixture","prompt":"Summarize",
                "enabled":true,"schedule":{"cron":"* * * * *","timezone":"UTC"}
            })),
            &owner,
        )
        .unwrap();
    cx.w.lock().unwrap().now = job.get("nextRunAt").unwrap().as_f64().unwrap() as i64;
    parent.tick().unwrap();
    assert_eq!(
        cx.w.lock()
            .unwrap()
            .events
            .iter()
            .filter(|event| event.get("turn").is_some())
            .count(),
        0
    );
    assert_eq!(
        parent
            .history(job.get("id").unwrap().as_str(), &owner, None)
            .unwrap()
            .len(),
        1
    );
}
