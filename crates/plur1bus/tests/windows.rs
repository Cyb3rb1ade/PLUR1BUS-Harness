//! Windows pipe security (ruling S11): the supervisor pipe's explicit user-and-SYSTEM DACL and first-instance rule,
//! the run files' DACL, and the core pipe's default DACL (Node's `net`, checked with `pipe_dacl_report`). The core is
//! `tests/fixtures/fake-core.mjs` run by `node`. Every test uses its own temp home.
//!
//! `run/`'s inheritable ACL (HB5, DS36): the supervisor sets it once at start, a module's run files inherit it and
//! skip `icacls`, and when it cannot be set the module's own `icacls` path secures them instead. The module is the
//! built fixture (`PLUR1BUS_FIXTURE_MODULE`, default `packages/module-fixture/dist`, built by `pnpm build`).
#![cfg(windows)]
mod common;

use plur1bus_rpc::acl::{
    run_writable_by_others, CONTAINER_INHERIT_ACE, INHERITED_ACE, OBJECT_INHERIT_ACE,
};
use plur1bus_rpc::win::{
    file_dacl_detail, file_dacl_report, pipe_dacl_report, user_sid, writable_by_others, DaclEntry,
};
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

const WAIT: Duration = Duration::from_secs(15);

/// Kills the process if a test ends before it exits.
struct Proc(Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Same rule as `paths::core_address` / `supervisor_address` on Windows.
fn pipe(home: &Path, role: &str) -> String {
    let h = format!(
        "{:x}",
        Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
    );
    format!(r"\\.\pipe\plur1bus-{}-{role}", &h[..16])
}

fn wait_until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(Instant::now() < deadline, "{what} did not happen");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn supervise(home: &Path) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--home")
        .arg(home)
        .args(["supervise", "--no-core"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    c
}

/// Starts `supervise --no-core` and waits until it answers `supervisor.auth` as the pid in `run/supervisor.pid`.
fn start_supervisor(home: &Path) -> Proc {
    let p = Proc(supervise(home).spawn().unwrap());
    let pid = p.0.id();
    wait_until("supervisor.auth", || {
        let token = std::fs::read_to_string(home.join("run/supervisor.token")).ok()?;
        let opts = ConnectOptions {
            connect_timeout: Duration::from_secs(2),
            call_timeout: Duration::from_secs(5),
            endpoint: Endpoint::Supervisor,
            expected_server_pid: Some(pid),
        };
        Client::connect(&pipe(home, "supervisor"), token.trim(), opts).ok()
    });
    p
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

/// `CreateNamedPipeW` with the default DACL; `Err` carries the OS error.
fn create_pipe(name: &str, first: bool) -> std::io::Result<OwnedHandle> {
    let name = wide(name);
    let mode = PIPE_ACCESS_DUPLEX
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: `name` is NUL-terminated; null security attributes mean the default DACL.
    let h = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            4096,
            4096,
            0,
            std::ptr::null(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a new handle we own.
    Ok(unsafe { OwnedHandle::from_raw_handle(h) })
}

fn sids(entries: &[DaclEntry]) -> BTreeSet<String> {
    entries.iter().map(|e| e.sid.clone()).collect()
}

/// The DACL of a file as SDDL, through `icacls /save` (UTF-16LE). Only its control flags are read (`D:P`): SDDL writes
/// well-known accounts as aliases (the CI runner's built-in Administrator is `LA`, not its SID), so the entries are
/// compared through [`file_dacl_report`], which names every trustee by its full SID.
fn file_sddl(file: &Path, scratch: &Path) -> String {
    let saved = scratch.join(format!(
        "{}.acl",
        file.file_name().unwrap().to_string_lossy()
    ));
    let icacls = Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()))
        .join(r"System32\icacls.exe");
    let ok = Command::new(icacls)
        .arg(file)
        .arg("/save")
        .arg(&saved)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(ok.success(), "icacls /save failed for {}", file.display());
    let bytes = std::fs::read(&saved).unwrap();
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_start_matches('\u{feff}')
        .to_string()
}

#[test]
fn supervisor_pipe_dacl_grants_only_user_and_system() {
    let dir = tempfile::tempdir().unwrap();
    let _sup = start_supervisor(dir.path());
    let entries = pipe_dacl_report(&pipe(dir.path(), "supervisor")).unwrap();
    let user = user_sid().unwrap();
    assert_eq!(
        sids(&entries),
        BTreeSet::from([user.clone(), "S-1-5-18".to_string()]),
        "{entries:?}"
    );
    assert!(entries.iter().all(|e| e.allow), "{entries:?}");
    assert_eq!(writable_by_others(&entries, &user), Vec::<String>::new());
}

#[test]
fn a_second_pipe_instance_owner_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let _sup = start_supervisor(dir.path());
    // The name is taken: nobody can create a first instance of it while the supervisor runs.
    let e = create_pipe(&pipe(dir.path(), "supervisor"), true)
        .expect_err("a first instance of the supervisor's pipe was created");
    assert_eq!(e.raw_os_error(), Some(ERROR_ACCESS_DENIED as i32), "{e}");
}

#[test]
fn a_supervisor_refuses_a_pipe_name_someone_else_created_first() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    // A squatter's instance with the default DACL: FILE_FLAG_FIRST_PIPE_INSTANCE makes the bind fail.
    let _squat = create_pipe(&pipe(home, "supervisor"), true).unwrap();
    let mut p = Proc(supervise(home).spawn().unwrap());
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(s) = p.0.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "supervise did not exit");
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut stderr = String::new();
    std::io::Read::read_to_string(p.0.stderr.as_mut().unwrap(), &mut stderr).unwrap();
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("cannot listen"), "{stderr}");
    assert!(
        !home.join("run/supervisor.token").exists(),
        "run files left behind"
    );
}

#[test]
fn supervisor_run_files_grant_only_user_and_system() {
    let dir = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let _sup = start_supervisor(dir.path());
    let user = user_sid().unwrap();
    for f in ["supervisor.token", "supervisor.pid"] {
        let path = dir.path().join("run").join(f);
        let sddl = file_sddl(&path, scratch.path());
        assert!(sddl.contains("D:P"), "{f}: inherited entries kept: {sddl}");
        let entries = file_dacl_report(&path).unwrap();
        assert_eq!(
            sids(&entries),
            BTreeSet::from([user.clone(), "S-1-5-18".to_string()]),
            "{f}: {entries:?}"
        );
        assert_eq!(entries.len(), 2, "{f}: {entries:?}");
        assert!(entries.iter().all(|e| e.allow), "{f}: {entries:?}");
    }
}

#[test]
fn supervisor_logs_grant_only_user_and_system() {
    let dir = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let _sup = start_supervisor(dir.path());
    let user = user_sid().unwrap();
    let logs = dir.path().join("logs");
    let log = logs.join("supervisor.log");
    for path in [&logs, &log] {
        let sddl = file_sddl(path, scratch.path());
        assert!(
            sddl.contains("D:P"),
            "{}: inherited entries kept: {sddl}",
            path.display()
        );
        let entries = file_dacl_report(path).unwrap();
        assert_eq!(
            sids(&entries),
            BTreeSet::from([user.clone(), "S-1-5-18".to_string()]),
            "{}: {entries:?}",
            path.display()
        );
        assert_eq!(entries.len(), 2, "{}: {entries:?}", path.display());
        assert!(
            entries.iter().all(|e| e.allow),
            "{}: {entries:?}",
            path.display()
        );
    }
}

#[test]
fn core_pipe_default_dacl_is_not_writable_by_others() {
    let dir = tempfile::tempdir().unwrap();
    let home: PathBuf = dir.path().to_path_buf();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs");
    let core = Proc(
        Command::new("node")
            .arg(&fixture)
            .arg("--home")
            .arg(&home)
            .env("FAKE_CORE_MODE", "ok")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let address = pipe(&home, "core");
    let entries = wait_until("the core pipe", || pipe_dacl_report(&address).ok());
    let user = user_sid().unwrap();
    assert_eq!(
        writable_by_others(&entries, &user),
        Vec::<String>::new(),
        "{entries:?}"
    );
    // The pipe's server is the pid the core recorded, so the S11 check passes; then stop it the clean way.
    let token = std::fs::read_to_string(home.join("run/core.token")).unwrap();
    let recorded: u32 = std::fs::read_to_string(home.join("run/core.pid"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(recorded, core.0.id());
    let mut c = Client::connect(
        &address,
        token.trim(),
        ConnectOptions {
            connect_timeout: Duration::from_secs(2),
            expected_server_pid: Some(recorded),
            ..Default::default()
        },
    )
    .unwrap();
    let _ = c.call("core.shutdown", json!({}));
}

// ---- run/'s inheritable ACL (HB5) ------------------------------------------------------------------------------------

/// The built fixture module's directory.
fn fixture_dist() -> PathBuf {
    std::env::var_os("PLUR1BUS_FIXTURE_MODULE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/module-fixture/dist")
        })
}

/// A temp home with the fixture installed as `modules/fixture` and `supervisor.graceMs = 1000`; returns the temp dir
/// (holding the home `h` and the fake core's events file).
fn home_with_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    let dst = home.join("modules").join("fixture");
    std::fs::create_dir_all(&dst).unwrap();
    let src = fixture_dist();
    for entry in std::fs::read_dir(&src)
        .unwrap_or_else(|e| panic!("{}: {e} (run `pnpm build` first)", src.display()))
    {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            std::fs::copy(entry.path(), dst.join(entry.file_name())).unwrap();
        }
    }
    std::fs::write(
        home.join("config.json"),
        r#"{ "schemaVersion": 1, "supervisor": { "graceMs": 1000 }, "modules": {} }"#,
    )
    .unwrap();
    let events = dir.path().join("events.jsonl");
    (dir, home, events)
}

fn supervisor_log(home: &Path) -> Vec<Value> {
    std::fs::read_to_string(home.join("logs/supervisor.log"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Waits until the supervisor logs `fixture ready`; returns that record.
fn wait_fixture_ready(home: &Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(r) = supervisor_log(home)
            .into_iter()
            .find(|r| r["msg"] == "fixture ready")
        {
            return r;
        }
        assert!(
            Instant::now() < deadline,
            "the fixture module did not become ready{}",
            common::log_tails()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Stops the supervisor over RPC (never a signal on Windows) and waits for it to exit.
fn stop_supervisor(s: &mut common::Supervisor) {
    let mut c = common::client(&s.home);
    let _ = c.call("daemon.stop", json!({ "budgetMs": 5000 }));
    let deadline = Instant::now() + WAIT;
    while s.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the supervisor did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn user_and_system(user: &str) -> BTreeSet<String> {
    BTreeSet::from([user.to_string(), "S-1-5-18".to_string()])
}

#[test]
fn run_dir_acl_is_protected_and_inheritable_after_supervisor_start() {
    let (_dir, home, events) = home_with_fixture();
    let mut s = common::start_with_core(&home, &events, "1", &[]);
    let user = user_sid().unwrap();
    let d = file_dacl_detail(&home.join("run")).unwrap();
    assert!(d.protected, "run/ is not SE_DACL_PROTECTED: {d:?}");
    assert_eq!(d.aces.len(), 2, "{d:?}");
    let sids: BTreeSet<String> = d.aces.iter().map(|(e, _)| e.sid.clone()).collect();
    assert_eq!(sids, user_and_system(&user), "{d:?}");
    for (e, flags) in &d.aces {
        assert!(e.allow, "{d:?}");
        assert_eq!(
            flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE),
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            "{d:?}"
        );
        assert_eq!(flags & INHERITED_ACE, 0, "{d:?}");
    }
    assert!(
        supervisor_log(&home).iter().any(|r| r["msg"]
            .as_str()
            .is_some_and(|m| m.starts_with("run/ ACL set"))),
        "{}",
        common::log_tails()
    );
    stop_supervisor(&mut s);
}

#[test]
fn module_run_files_inherit_the_restrictive_acl() {
    let (_dir, home, events) = home_with_fixture();
    let mut s = common::start_with_core(&home, &events, "1", &[]);
    wait_fixture_ready(&home);
    let user = user_sid().unwrap();
    for f in ["module-fixture.token", "module-fixture.pid"] {
        let path = home.join("run").join(f);
        let d = file_dacl_detail(&path).unwrap();
        let entries: Vec<DaclEntry> = d.aces.iter().map(|(e, _)| e.clone()).collect();
        assert_eq!(
            run_writable_by_others(&entries, &user),
            Vec::<String>::new(),
            "{f}: {d:?}"
        );
        assert_eq!(sids(&entries), user_and_system(&user), "{f}: {d:?}");
        // Inherited from run/, not written by icacls (which would protect the DACL and drop the flag).
        assert!(
            d.aces.iter().all(|(_, flags)| flags & INHERITED_ACE != 0),
            "{f}: {d:?}"
        );
        assert!(!d.protected, "{f}: icacls ran: {d:?}");
    }
    // The post-ready check found nothing.
    assert!(
        !supervisor_log(&home).iter().any(|r| r["msg"]
            .as_str()
            .is_some_and(|m| m.contains("is writable by"))),
        "{}",
        common::log_tails()
    );
    stop_supervisor(&mut s);
}

#[test]
fn the_module_becomes_ready_without_icacls_delays() {
    let (_dir, home, events) = home_with_fixture();
    let mut s = common::start_with_core(&home, &events, "1", &[]);
    let ready = wait_fixture_ready(&home);
    let ms = ready["readyMs"].as_u64().unwrap();
    // For the task report: the spawn-to-ready time of a module on this runner.
    println!("fixture spawn-to-ready: {ms} ms");
    // Headroom for a loaded shared runner (3093 ms was seen once): the per-module icacls path this replaces took
    // several seconds per module on top of Node's start, so 6 s still tells the two apart.
    assert!(ms < 6000, "fixture took {ms} ms to become ready");
    stop_supervisor(&mut s);
}

#[test]
fn when_the_run_acl_cannot_be_set_children_fall_back_to_secure_path() {
    let (_dir, home, events) = home_with_fixture();
    let mut s =
        common::start_with_core(&home, &events, "1", &[("PLUR1BUS_TEST_FAIL_RUN_ACL", "1")]);
    wait_fixture_ready(&home);
    assert!(
        supervisor_log(&home).iter().any(|r| r["msg"]
            .as_str()
            .is_some_and(|m| m.starts_with("run/ ACL not set"))),
        "{}",
        common::log_tails()
    );
    let user = user_sid().unwrap();
    let d = file_dacl_detail(&home.join("run/module-fixture.token")).unwrap();
    let entries: Vec<DaclEntry> = d.aces.iter().map(|(e, _)| e.clone()).collect();
    // The module ran icacls itself: protected, user and SYSTEM only.
    assert!(d.protected, "{d:?}");
    assert_eq!(sids(&entries), user_and_system(&user), "{d:?}");
    assert_eq!(
        run_writable_by_others(&entries, &user),
        Vec::<String>::new(),
        "{d:?}"
    );
    stop_supervisor(&mut s);
}
