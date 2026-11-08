//! Real principal-bound checkpoint files, restart and concurrent stale completions.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::{harness_user_principal, RequestContext},
    contract::{AgentContext, Cancel, Principal},
    neo::{
        merged::Layout,
        session_store::{Change, SessionStore},
    },
    text::js::JsString,
};
use serde_json::json;
use std::{
    fs,
    path::Path,
    sync::{atomic::Ordering, Arc},
};
fn principal(agent: &str, user: &str, workspace: &Path) -> Principal {
    serde_json::from_value(json!({"agentId":agent,"workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal(user),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap()
}
fn agent() -> AgentContext {
    serde_json::from_value(json!({"origin":"user","background":false})).unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    Arc<support::TestHost>,
    Principal,
    SessionStore,
) {
    let root = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    for id in ["alpha", "beta"] {
        host.set_workspace(id, root.path().into());
    }
    host.time.store(1700000000000, Ordering::SeqCst);
    let p = principal("alpha", "one", root.path());
    let store = SessionStore::open(root.path(), host.clone()).unwrap();
    (root, host, p, store)
}
fn directory(root: &Path, p: &Principal, host: &support::TestHost) -> std::path::PathBuf {
    root.join("workspaces").join(
        Layout::for_key(
            &RequestContext::build(p, &agent(), host)
                .unwrap()
                .workspace_key,
        )
        .canonical,
    )
}
fn state_file(dir: &Path) -> std::path::PathBuf {
    fs::read_dir(dir)
        .unwrap()
        .map(|v| v.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("native-hook-state-")
        })
        .unwrap()
}
#[test]
fn read_is_pure_and_persisted_progress_survives_restart_without_crossing_principals() {
    let (root, host, p, store) = setup();
    let key = JsString::from("session");
    assert!(
        !store
            .read(&p, &agent(), &key, &Cancel::never())
            .unwrap()
            .known
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    let out = store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance {
                baseline: 0,
                to: 12,
            },
            &Cancel::never(),
        )
        .unwrap();
    assert!(out.applied);
    assert_eq!(out.watermark.count, 12.);
    let reopened = SessionStore::open(root.path(), host.clone()).unwrap();
    assert_eq!(
        reopened
            .read(&p, &agent(), &key, &Cancel::never())
            .unwrap()
            .count,
        12.
    );
    for other in [
        principal("beta", "one", root.path()),
        principal("alpha", "two", root.path()),
    ] {
        assert!(
            !reopened
                .read(&other, &agent(), &key, &Cancel::never())
                .unwrap()
                .known
        );
        reopened
            .apply(
                &other,
                &agent(),
                &key,
                Change::Advance { baseline: 0, to: 3 },
                &Cancel::never(),
            )
            .unwrap();
    }
    assert_eq!(
        reopened
            .read(&p, &agent(), &key, &Cancel::never())
            .unwrap()
            .count,
        12.
    );
}
#[test]
fn competing_file_writers_and_stale_failures_preserve_highest_progress() {
    let (root, host, p, store) = setup();
    let key = JsString::from("session");
    std::thread::scope(|scope| {
        for to in [4, 15, 9, 27] {
            let host = host.clone();
            let p = p.clone();
            let path = root.path().to_owned();
            let key = key.clone();
            scope.spawn(move || {
                SessionStore::open(&path, host)
                    .unwrap()
                    .apply(
                        &p,
                        &agent(),
                        &key,
                        Change::Advance { baseline: 0, to },
                        &Cancel::never(),
                    )
                    .unwrap();
            });
        }
    });
    assert_eq!(
        store
            .read(&p, &agent(), &key, &Cancel::never())
            .unwrap()
            .count,
        27.
    );
    let file = state_file(&directory(root.path(), &p, &host));
    let before = fs::read(&file).unwrap();
    assert!(
        !store
            .apply(
                &p,
                &agent(),
                &key,
                Change::Failure {
                    baseline: 0,
                    failures: 2
                },
                &Cancel::never()
            )
            .unwrap()
            .applied
    );
    assert_eq!(fs::read(&file).unwrap(), before);
    assert!(
        store
            .apply(
                &p,
                &agent(),
                &key,
                Change::Advance {
                    baseline: 27,
                    to: 2
                },
                &Cancel::never()
            )
            .unwrap()
            .applied
    );
}
#[test]
fn cancel_rebinding_corrupt_and_ownerless_legacy_state_fail_closed() {
    let (root, host, p, store) = setup();
    let key = JsString::from("session");
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 1 },
            &cancel
        )
        .is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    let dir = directory(root.path(), &p, &host);
    fs::create_dir_all(&dir).unwrap();
    let legacy = dir.join("hook-state.json");
    fs::write(
        &legacy,
        "{\"agent_end\":{\"lastProcessedMessageCount\":90}}",
    )
    .unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 1 },
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::write(&legacy, include_bytes!("fixtures/neo-v1/hook-state.json")).unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 1 },
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_file(legacy).unwrap();
    store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 1 },
            &Cancel::never(),
        )
        .unwrap();
    let path = state_file(&dir);
    let before = fs::read(&path).unwrap();
    fs::write(&path, "{}").unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 1, to: 2 },
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"{}");
    fs::write(&path, before).unwrap();
    let other = support::canonical_tempdir();
    host.set_workspace("alpha", other.path().into());
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
}

#[cfg(unix)]
#[test]
fn checkpoint_links_foreign_binding_and_oversized_files_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (root, host, p, store) = setup();
    let key = JsString::from("session");
    store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 1 },
            &Cancel::never(),
        )
        .unwrap();
    let dir = directory(root.path(), &p, &host);
    let path = state_file(&dir);
    let before = fs::read(&path).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let outside = root.path().join("outside");
    fs::write(&outside, &before).unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&outside, &path).unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 1, to: 2 },
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read(&outside).unwrap(), before);
    fs::remove_file(&path).unwrap();
    fs::hard_link(&outside, &path).unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    fs::remove_file(&path).unwrap();
    let mut foreign: serde_json::Value = serde_json::from_slice(&before).unwrap();
    foreign["ownership"]["ownerUserId"] = json!(harness_user_principal("other"));
    fs::write(&path, foreign.to_string()).unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    fs::File::create(&path)
        .unwrap()
        .set_len(4 * 1024 * 1024 + 1)
        .unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    fs::write(&path, &before).unwrap();
    let oversized = JsString::from("a".repeat(4097).as_str());
    assert!(store
        .apply(
            &p,
            &agent(),
            &oversized,
            Change::Advance { baseline: 0, to: 1 },
            &Cancel::never()
        )
        .is_err());
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance {
                baseline: 1,
                to: u64::MAX
            },
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn held_checkpoint_lease_obeys_deadline_without_writing_state() {
    use std::time::{Duration, Instant};
    let (root, host, p, store) = setup();
    let key = JsString::from("session");
    store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 1 },
            &Cancel::never(),
        )
        .unwrap();
    let dir = directory(root.path(), &p, &host);
    let path = state_file(&dir);
    let before = fs::read(&path).unwrap();
    let lock = dir.join(".native-hook-leases").join(format!(
        "{}.lock",
        path.file_name().unwrap().to_str().unwrap()
    ));
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock)
        .unwrap();
    held.lock().unwrap();
    let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(15));
    assert!(matches!(
        store.apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 1, to: 2 },
            &cancel
        ),
        Err(plur1bus_engine::contract::EngineError::Cancelled(_))
    ));
    assert_eq!(fs::read(path).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn checkpoint_child_fixture() {
    use std::io::{Read, Write};
    let Some(root) = std::env::var_os("PLUR1BUS_SESSION_CHECKPOINT_FIXTURE") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", root.clone());
    let p = principal("alpha", "one", &root);
    let store = SessionStore::open(&root, host.clone()).unwrap();
    store
        .apply(
            &p,
            &agent(),
            &JsString::from("session"),
            Change::Advance {
                baseline: 0,
                to: 13,
            },
            &Cancel::never(),
        )
        .unwrap();
    let dir = directory(&root, &p, &host);
    let state = state_file(&dir);
    let lock = dir.join(".native-hook-leases").join(format!(
        "{}.lock",
        state.file_name().unwrap().to_str().unwrap()
    ));
    let held = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock)
        .unwrap();
    held.lock().unwrap();
    println!("SESSION_COMMITTED_AND_LOCKED");
    std::io::stdout().flush().unwrap();
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
}
#[cfg(unix)]
#[test]
fn killed_writer_preserves_acknowledged_checkpoint_and_releases_kernel_lease() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let (root, host, p, _) = setup();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "checkpoint_child_fixture", "--nocapture"])
        .env("PLUR1BUS_SESSION_CHECKPOINT_FIXTURE", root.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert!(lines.read_line(&mut line).unwrap() > 0);
        if line.contains("SESSION_COMMITTED_AND_LOCKED") {
            break;
        }
    }
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    let reopened = SessionStore::open(root.path(), host).unwrap();
    let key = JsString::from("session");
    assert_eq!(
        reopened
            .read(&p, &agent(), &key, &Cancel::never())
            .unwrap()
            .count,
        13.
    );
    let cancel =
        Cancel::with_deadline(std::time::Instant::now() + std::time::Duration::from_secs(5));
    assert!(
        reopened
            .apply(
                &p,
                &agent(),
                &key,
                Change::Advance {
                    baseline: 13,
                    to: 14
                },
                &cancel
            )
            .unwrap()
            .applied
    );
}

#[test]
fn replacing_a_workspace_at_the_same_path_does_not_reuse_its_checkpoint() {
    let root = support::canonical_tempdir();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", workspace.clone());
    let p = principal("alpha", "one", &workspace);
    let store = SessionStore::open(root.path(), host).unwrap();
    let key = JsString::from("session");
    store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance {
                baseline: 0,
                to: 12,
            },
            &Cancel::never(),
        )
        .unwrap();
    fs::rename(&workspace, root.path().join("old-workspace")).unwrap();
    fs::create_dir(&workspace).unwrap();
    assert!(store.read(&p, &agent(), &key, &Cancel::never()).is_err());
    assert!(store
        .apply(
            &p,
            &agent(),
            &key,
            Change::Advance { baseline: 0, to: 2 },
            &Cancel::never()
        )
        .is_err());
    fs::remove_dir(&workspace).unwrap();
    fs::rename(root.path().join("old-workspace"), &workspace).unwrap();
    assert_eq!(
        store
            .read(&p, &agent(), &key, &Cancel::never())
            .unwrap()
            .count,
        12.
    );
}
