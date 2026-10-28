//! The one public Lock API interoperates with the actual Node Neo directory writer.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime};

use plur1bus_engine::store::lock::Lock;
use plur1bus_rpc::process;
use serde_json::{json, Value};

const STALE: Duration = Duration::from_secs(300);
fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("re02-neo-lock-")
        .tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap())
        .unwrap()
}
fn node(mode: &str, root: &Path) -> Command {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .arg(repository.join("crates/plur1bus-engine/tests/node/neo-lock-check.mjs"))
        .arg(mode)
        .arg(root)
        .current_dir(repository.join("packages/core"));
    command
}
fn probe(mode: &str, root: &Path) -> Value {
    let output = node(mode, root).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn lock_path(root: &Path) -> PathBuf {
    PathBuf::from(probe("path", root)["lockPath"].as_str().unwrap())
}
fn ready(child: &mut Child) -> Value {
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "holder exited before readiness"
        );
        if line.starts_with('{') {
            let value = serde_json::from_str(&line).unwrap();
            child.stdout = Some(reader.into_inner());
            return value;
        }
    }
}
fn directory_handle(path: &Path) -> fs::File {
    #[allow(unused_mut)] // Windows directory times need BACKUP_SEMANTICS.
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES,
        };
        options
            .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(path).unwrap()
}
fn age(path: &Path, duration: Duration) {
    directory_handle(path)
        .set_modified(SystemTime::now() - duration)
        .unwrap();
}
fn owner(path: &Path, pid: u32, host: &str, start: &Value) {
    fs::create_dir_all(path).unwrap();
    fs::write(
        path.join("owner.json"),
        serde_json::to_vec(&json!({ "nonce":"previous", "pid":pid, "host":host,
        "procStart":start, "acquiredAt":"2000-01-01T00:00:00.000Z" }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn neo_rust_and_node_holders_block_each_other() {
    let root = scratch();
    let path = lock_path(root.path());
    let guard = Lock::try_acquire_neo(&path, STALE).unwrap().unwrap();
    assert_eq!(probe("probe", root.path())["acquired"], false);
    drop(guard);
    assert_eq!(probe("probe", root.path())["acquired"], true);
    let mut child = node("hold", root.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let record = ready(&mut child);
    assert_eq!(record["ready"], true);
    assert!(path.is_dir());
    assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_none());
    child.stdin.take().unwrap().write_all(b"x").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_some());
}

#[test]
fn neo_rust_takes_over_an_actual_dead_node_holder_immediately() {
    let root = scratch();
    let mut child = node("hold", root.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let record = ready(&mut child);
    let path = PathBuf::from(record["lockPath"].as_str().unwrap());
    child.kill().unwrap();
    child.wait().unwrap();
    let guard = Lock::try_acquire_neo(&path, STALE).unwrap().unwrap();
    assert!(guard.path().is_dir());
}

#[test]
fn neo_rust_process_holder_child() {
    if let Some(path) = std::env::var_os("PLUR1BUS_RE02_NEO_CHILD") {
        let guard = Lock::try_acquire_neo(Path::new(&path), STALE)
            .unwrap()
            .unwrap();
        writeln!(std::io::stdout(), "{{\"ready\":true}}").unwrap();
        std::io::stdout().flush().unwrap();
        let _ = std::io::stdin().read(&mut [0u8; 1]);
        drop(guard);
    } else {
        let directory = scratch();
        let path = directory.path().join(".neo-write.lock");
        let guard = Lock::try_acquire_neo(&path, STALE).unwrap().unwrap();
        assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_none());
        drop(guard);
    }
}

#[test]
fn neo_node_takes_over_an_actual_dead_rust_holder_immediately() {
    let root = scratch();
    let path = lock_path(root.path());
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "neo_rust_process_holder_child", "--nocapture"])
        .env("PLUR1BUS_RE02_NEO_CHILD", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    assert_eq!(ready(&mut child)["ready"], true);
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(probe("probe", root.path())["acquired"], true);
}

#[test]
fn neo_orphans_wait_for_fifteen_seconds_of_directory_age_on_both_sides() {
    let root = scratch();
    let path = lock_path(root.path());
    fs::create_dir_all(&path).unwrap();
    assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_none());
    age(&path, Duration::from_secs(16));
    let guard = Lock::try_acquire_neo(&path, STALE).unwrap().unwrap();
    drop(guard);
    fs::create_dir(&path).unwrap();
    age(&path, Duration::from_secs(16));
    assert_eq!(probe("probe", root.path())["acquired"], true);
}

#[test]
fn neo_liveness_incarnation_and_foreign_hard_ceiling_use_directory_mtime() {
    let directory = scratch();
    let path = directory.path().join(".neo-write.lock");
    let own = serde_json::to_value(process::incarnation().unwrap()).unwrap();
    let host = process::hostname().unwrap();
    owner(&path, std::process::id(), &host, &own);
    age(&path, STALE * 2);
    assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_none());
    let mut previous = own.clone();
    previous["mono"] = json!(own["mono"].as_i64().unwrap() - 10_000);
    owner(&path, std::process::id(), &host, &previous);
    drop(Lock::try_acquire_neo(&path, STALE).unwrap().unwrap());
    owner(&path, std::process::id(), "a-different-host", &own);
    age(&path, STALE * 2);
    assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_none());
    age(&path, STALE * 10 + Duration::from_secs(1));
    assert!(Lock::try_acquire_neo(&path, STALE).unwrap().is_some());
}

#[test]
fn neo_late_release_puts_back_another_owner_without_deleting_it() {
    let directory = scratch();
    let path = directory.path().join(".neo-write.lock");
    let mut guard = Lock::try_acquire_neo(&path, STALE).unwrap().unwrap();
    fs::rename(&path, directory.path().join("old-owner")).unwrap();
    owner(
        &path,
        std::process::id(),
        &process::hostname().unwrap(),
        &serde_json::to_value(process::incarnation().unwrap()).unwrap(),
    );
    let bytes = fs::read(path.join("owner.json")).unwrap();
    guard.release();
    guard.release();
    assert_eq!(fs::read(path.join("owner.json")).unwrap(), bytes);
}

#[test]
fn neo_two_contenders_for_one_dead_holder_leave_one_owner() {
    let directory = scratch();
    let path = directory.path().join(".neo-write.lock");
    for _ in 0..16 {
        owner(&path, u32::MAX, &process::hostname().unwrap(), &json!(null));
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                Lock::try_acquire_neo(&path, STALE).unwrap()
            });
            let second = scope.spawn(|| {
                barrier.wait();
                Lock::try_acquire_neo(&path, STALE).unwrap()
            });
            let guards = [first.join().unwrap(), second.join().unwrap()];
            assert_eq!(guards.iter().filter(|guard| guard.is_some()).count(), 1);
        });
    }
}

#[test]
fn neo_live_owner_survives_lossy_utf8_and_node_number_coercion() {
    for string_pid in [false, true] {
        let root = scratch();
        let path = lock_path(root.path());
        fs::create_dir_all(&path).unwrap();
        let pid = if string_pid {
            json!(std::process::id().to_string())
        } else {
            json!(std::process::id())
        };
        let value = json!({"nonce":"previous","pid":pid,"host":process::hostname().unwrap(),"procStart":process::incarnation().unwrap(),"acquiredAt":"~"});
        let mut bytes = serde_json::to_vec(&value).unwrap();
        let invalid = bytes.iter().position(|byte| *byte == b'~').unwrap();
        bytes[invalid] = 0xff;
        fs::write(path.join("owner.json"), &bytes).unwrap();
        age(&path, Duration::from_secs(16));
        assert!(
            Lock::try_acquire_neo(&path, STALE).unwrap().is_none(),
            "live holder was mistaken for an orphan"
        );
        assert_eq!(probe("probe", root.path())["acquired"], false);
        assert_eq!(fs::read(path.join("owner.json")).unwrap(), bytes);
    }
}
