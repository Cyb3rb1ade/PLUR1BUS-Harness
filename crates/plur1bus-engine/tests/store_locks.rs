//! Node-compatible registry and job locks, including dead holders and delayed releases (RE-02/T6).
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime},
};

use plur1bus_engine::store::lock::{JobLock, Lock, LockBusy};
use plur1bus_rpc::process;
use serde_json::{json, Value};

const STALE: Duration = Duration::from_millis(100);

fn scratch_directory() -> tempfile::TempDir {
    let root = fs::canonicalize(std::env::temp_dir()).unwrap();
    tempfile::Builder::new()
        .prefix("re02-lock-")
        .tempdir_in(root)
        .unwrap()
}

fn age(path: &Path, milliseconds: u64) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_millis(milliseconds))
        .unwrap();
}

fn write_holder(path: &Path, pid: u32, host: &str, start: &Value) {
    fs::write(
        path,
        serde_json::to_vec(&json!({"nonce":"previous-owner", "pid":pid,
        "host":host, "procStart":start, "acquiredAt":"2000-01-01T00:00:00.000Z"}))
        .unwrap(),
    )
    .unwrap();
}

fn node(mode: &str, path: &Path) -> Command {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .arg(root.join("crates/plur1bus-engine/tests/node/roundtrip-check.mjs"))
        .arg("--lock")
        .arg(mode)
        .arg(path)
        .arg("100")
        .current_dir(root.join("packages/core"));
    command
}

#[test]
fn a_second_acquire_in_the_same_process_is_busy_even_beyond_the_ceiling() {
    let dir = scratch_directory();
    let held = JobLock::acquire(dir.path(), "job", STALE).unwrap();
    age(held.path(), 2_000);
    assert!(matches!(
        JobLock::acquire(dir.path(), "job", STALE),
        Err(LockBusy::Held)
    ));
    drop(held);
    assert!(JobLock::acquire(dir.path(), "job", STALE).is_ok());
}

#[test]
fn a_lock_of_a_dead_pid_is_taken_over_after_the_stale_threshold() {
    let dir = scratch_directory();
    let path = dir.path().join("dead.lock");
    let output = node("leave", &path).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    age(&path, 0);
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_none());
    age(&path, 200);
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_some());
}

#[test]
fn a_lock_of_a_live_pid_with_a_recycled_start_time_is_taken_over() {
    let dir = scratch_directory();
    let path = dir.path().join("recycled.lock");
    let mut start = process::incarnation().unwrap();
    start.mono -= 2_000;
    write_holder(
        &path,
        std::process::id(),
        &process::hostname().unwrap(),
        &json!(start),
    );
    age(&path, 200);
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_some());
}

#[test]
fn a_live_holder_keeps_an_old_lock_until_the_hard_ceiling_without_heartbeat() {
    let dir = scratch_directory();
    let path = dir.path().join("live.lock");
    let mut held = Lock::try_acquire(&path, STALE, None).unwrap().unwrap();
    let content = fs::read(&path).unwrap();
    age(&path, 300);
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(10));
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert_eq!(fs::read(&path).unwrap(), content);
    assert!(Lock::try_acquire(&path, STALE, Some(STALE * 2))
        .unwrap()
        .is_none());
    age(&path, 2_000);
    let replacement = Lock::try_acquire(&path, STALE, None).unwrap().unwrap();
    held.release();
    assert!(
        path.exists(),
        "the first owner's delayed release removed its replacement"
    );
    drop(replacement);
    assert!(!path.exists());
}

#[test]
fn a_foreign_host_uses_only_the_clamped_ceiling_and_broken_content_is_reaped() {
    let dir = scratch_directory();
    let path = dir.path().join("foreign.lock");
    write_holder(
        &path,
        std::process::id(),
        "a-different-host.invalid",
        &Value::Null,
    );
    age(&path, 200);
    assert!(Lock::try_acquire(&path, STALE, Some(STALE * 4))
        .unwrap()
        .is_none());
    age(&path, 500);
    drop(
        Lock::try_acquire(&path, STALE, Some(STALE * 4))
            .unwrap()
            .unwrap(),
    );
    fs::write(&path, "{truncated").unwrap();
    age(&path, 200);
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_some());
}

#[test]
fn rust_locks_block_node_and_node_locks_block_rust() {
    let dir = scratch_directory();
    let path = dir.path().join("roundtrip.lock");
    let rust = Lock::try_acquire(&path, STALE, None).unwrap().unwrap();
    let output = node("probe", &path).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["acquired"], false);
    drop(rust);

    let mut child = node("hold", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let result: Value = serde_json::from_str(&ready).unwrap();
    assert_eq!(result["ready"], true);
    assert_eq!(result["host"], process::hostname().unwrap());
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_none());
    let observed = process::incarnation_of(child.id()).unwrap();
    assert!(
        (observed.mono as f64 - result["procStart"]["mono"].as_f64().unwrap()).abs() <= 1_000.0
    );
    assert_eq!(
        serde_json::to_value(observed.boot).unwrap(),
        result["procStart"]["boot"]
    );
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(!path.exists());
}

#[test]
fn node_takes_over_a_lock_left_by_a_dead_rust_holder() {
    let dir = scratch_directory();
    let path = dir.path().join("rust-dead.lock");
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_rust_holder_child_leaves_a_nonce_lock",
            "--nocapture",
        ])
        .env("PLUR1BUS_RE02_LOCK_CHILD", &path)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    age(&path, 200);
    let output = node("probe", &path).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["acquired"], true);
    assert!(!path.exists());
}

#[test]
fn a_rust_holder_child_leaves_a_nonce_lock() {
    let scratch = scratch_directory();
    let child = std::env::var_os("PLUR1BUS_RE02_LOCK_CHILD").filter(|_| {
        std::env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    });
    let path = child
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| scratch.path().join("local.lock"));
    let guard = Lock::try_acquire(&path, STALE, None).unwrap().unwrap();
    let row: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(row["pid"], std::process::id());
    assert!(row["nonce"].as_str().unwrap().len() >= 32);
    assert!(row["acquiredAt"].as_str().unwrap().ends_with('Z'));
    if child.is_some() {
        std::mem::forget(guard);
    }
}

#[test]
fn a_corrupt_non_utf8_lock_is_taken_over_after_the_stale_threshold() {
    let dir = scratch_directory();
    let path = dir.path().join("invalid-utf8.lock");
    fs::write(&path, [0xff]).unwrap();
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_none());
    age(&path, 200);
    assert!(Lock::try_acquire(&path, STALE, None).unwrap().is_some());
}

#[cfg(windows)]
#[test]
fn a_windows_sharing_violation_is_retried_after_the_release_settle_window() {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = scratch_directory();
    let path = directory.path().join("sharing.lock");
    let mut guard = Lock::try_acquire(&path, Duration::from_secs(30), None)
        .unwrap()
        .unwrap();
    let reader = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    guard.release();
    assert!(
        path.exists(),
        "the exclusively opened file should still block rename"
    );
    drop(reader);
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "deferred release left its owned file behind"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
