//! The secret helper (P4-20) as a process: `plur1bus-core secrets-helper` behind the isolated backend, over real pipes.
//! What a helper can do wrong is scripted in-process (`src/secrets/isolated/tests.rs`); here are the things only a process
//! shows: the executable serves the file backend, a second helper reads what the first wrote, the helper writes nothing
//! but frames and ends with its input, and a process that never answers is killed at the budget even while a request
//! larger than a pipe is still being written to it.
//!
//! `harness = false`: `main` is that silent process when it is started as `hang`, else it runs every test below in turn
//! (a test name argument filters them).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout
)]

use plur1bus_core::secrets::isolated::protocol::{encode_frame, read_frame, request, Operation};
use plur1bus_core::secrets::isolated::{
    helper_of, isolated_backend, spawn_process, BackendDescription, IsolatedOptions, HELPER_COMMAND,
};
use plur1bus_core::secrets::{SecretBackend, SecretErrorCode};
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const VALUE: &str = "a value in plain words for the helper";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("hang") {
        hang(args.get(2).map(String::as_str));
    }
    let filter: Vec<&String> = args
        .iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    let tests: &[(&str, fn())] = &[
        (
            "the_helper_serves_the_file_backend_and_a_second_one_reads_it",
            the_helper_serves_the_file_backend_and_a_second_one_reads_it,
        ),
        (
            "this_build_has_no_keyring_behind_the_helper",
            this_build_has_no_keyring_behind_the_helper,
        ),
        (
            "the_helper_writes_frames_only_and_ends_with_its_input",
            the_helper_writes_frames_only_and_ends_with_its_input,
        ),
        (
            "a_process_that_never_answers_is_killed_at_the_budget",
            a_process_that_never_answers_is_killed_at_the_budget,
        ),
        (
            "the_helper_is_not_in_the_help",
            the_helper_is_not_in_the_help,
        ),
    ];
    let mut ran = 0;
    for (name, test) in tests {
        if filter.is_empty() || filter.iter().any(|f| name.contains(f.as_str())) {
            println!("test {name} ...");
            test();
            println!("test {name} ... ok");
            ran += 1;
        }
    }
    println!("test result: ok. {ran} passed");
}

/// The process that never answers: it reads nothing, writes nothing and, left alone, ends after a minute.
fn hang(pid_file: Option<&str>) -> ! {
    if let Some(path) = pid_file {
        std::fs::write(path, std::process::id().to_string()).unwrap();
    }
    std::thread::sleep(Duration::from_secs(60));
    std::process::exit(0);
}

fn core() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_plur1bus-core"))
}

fn file_in(dir: &Path) -> BackendDescription {
    BackendDescription::File {
        dir: dir.to_str().unwrap().to_owned(),
    }
}

/// A generous budget: a loaded CI machine may take its time to start a process.
fn options(unavailable: &Arc<AtomicBool>) -> IsolatedOptions {
    IsolatedOptions {
        budget: Duration::from_secs(20),
        spawn: helper_of(core()),
        unavailable: unavailable.clone(),
    }
}

fn the_helper_serves_the_file_backend_and_a_second_one_reads_it() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("state").join("secrets");
    let unavailable: Arc<AtomicBool> = Arc::default();
    let (mut backend, handle) = isolated_backend(file_in(&dir), options(&unavailable));
    assert!(backend.probe().unwrap().available);
    assert_eq!(backend.get("api").unwrap(), None);
    let meta = backend
        .put(
            "api",
            VALUE,
            1_767_323_045_678,
            Some("owner:local"),
            Some("what it is for"),
            None,
        )
        .unwrap();
    assert_eq!(
        meta.to_json(),
        json!({ "name": "api", "backend": "file", "createdAt": "2026-01-02T03:04:05.678Z",
            "updatedAt": "2026-01-02T03:04:05.678Z", "updatedBy": "owner:local", "description": "what it is for" })
    );
    let mut registered = Vec::new();
    let mut register = |value: &str| registered.push(value.to_owned());
    backend
        .put(
            "api",
            "another value after a rotation",
            1_767_323_105_678,
            None,
            None,
            Some(&mut register),
        )
        .unwrap();
    assert_eq!(
        registered,
        [VALUE],
        "the replaced value comes back to be masked"
    );
    let refused = backend
        .describe(
            "api",
            "another value after a rotation",
            1_767_323_105_678,
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(refused.code, SecretErrorCode::InvalidDescription);

    // The files are the file backend's: private, and without the value in the clear.
    let store = std::fs::read_to_string(dir.join("store.json")).unwrap();
    assert!(store.contains("plur1bus.secrets-file/1") && !store.contains("another value"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            (
                mode(&dir),
                mode(&dir.join("store.json")),
                mode(&dir.join("store.key"))
            ),
            (0o700, 0o600, 0o600)
        );
    }

    // A second helper, another process: it reads what the first wrote.
    let (mut second, second_handle) = isolated_backend(file_in(&dir), options(&unavailable));
    assert_eq!(
        second.get("api").unwrap().as_deref(),
        Some("another value after a rotation")
    );
    assert_eq!(second.list().unwrap().len(), 1);
    assert!(second.delete("api", Some(1_767_323_165_678)).unwrap());
    assert_eq!(
        second
            .tombstones()
            .unwrap()
            .unwrap()
            .get("api")
            .map(String::as_str),
        Some("2026-01-02T03:06:05.678Z")
    );
    assert_eq!(
        backend.get("api").unwrap(),
        None,
        "the first helper sees the delete"
    );
    backend.clear_tombstone("api").unwrap().unwrap();
    assert!(second.tombstones().unwrap().unwrap().is_empty());

    handle.close();
    second_handle.close();
    assert!(!unavailable.load(Ordering::SeqCst), "no helper failed");
    assert_eq!(
        backend.list().unwrap_err().code,
        SecretErrorCode::BackendUnavailable,
        "a closed backend"
    );
}

/// Until the platform adapters land, the helper's keyring is not there: the backend says so, and the helper stays up.
fn this_build_has_no_keyring_behind_the_helper() {
    let unavailable: Arc<AtomicBool> = Arc::default();
    let (mut backend, handle) = isolated_backend(
        BackendDescription::Keyring {
            service: "plur1bus:helper-test".into(),
        },
        options(&unavailable),
    );
    let probe = backend.probe().unwrap();
    assert_eq!(
        (probe.available, probe.reason.as_deref()),
        (false, Some("keyring-unavailable"))
    );
    for refused in [backend.get("api").unwrap_err(), backend.list().unwrap_err()] {
        assert_eq!(refused.code, SecretErrorCode::BackendUnavailable);
        assert_eq!(refused.message, "the OS keyring is not available");
    }
    assert!(backend.tombstones().is_none());
    assert!(
        !unavailable.load(Ordering::SeqCst),
        "the backend refused; the helper did not fail"
    );
    handle.close();
}

fn the_helper_writes_frames_only_and_ends_with_its_input() {
    let home = tempfile::tempdir().unwrap();
    let mut command = Command::new(core());
    command.arg(HELPER_COMMAND);
    let mut helper = spawn_process(command).unwrap();
    let backend = file_in(&home.path().join("secrets"));
    for (id, operation) in [(1, Operation::Probe), (2, Operation::List)] {
        let frame = encode_frame(&request(id, &backend, operation, &[])).unwrap();
        helper.input.write_all(&frame).unwrap();
        helper.input.flush().unwrap();
        let reply = read_frame(&mut helper.output).unwrap().unwrap();
        assert_eq!(reply["id"], json!(id));
        assert!(reply.get("error").is_none(), "{reply}");
    }
    // The input closes: the helper ends, and nothing but the two frames was ever on its output.
    drop(helper.input);
    assert_eq!(read_frame(&mut helper.output).unwrap(), None);
    let started = Instant::now();
    while !helper.control.exited() {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the helper outlives its input"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    // Something that is no frame ends it too, with a failure and still without a byte of output.
    let output = Command::new(core())
        .arg(HELPER_COMMAND)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(b"this is a line of text\n")?;
            child.wait_with_output()
        })
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        output.stdout.is_empty() && output.stderr.is_empty(),
        "{output:?}"
    );
}

fn a_process_that_never_answers_is_killed_at_the_budget() {
    let home = tempfile::tempdir().unwrap();
    let pid_file = home.path().join("hang.pid");
    let unavailable: Arc<AtomicBool> = Arc::default();
    let child_pid_file = pid_file.clone();
    let (mut backend, handle) = isolated_backend(
        file_in(&home.path().join("secrets")),
        IsolatedOptions {
            budget: Duration::from_secs(2),
            spawn: Box::new(move |_| {
                let mut command = Command::new(std::env::current_exe()?);
                command.arg("hang").arg(&child_pid_file);
                let process = spawn_process(command)?;
                // The process has started (it wrote its pid) before the call goes on: the budget may then kill it at
                // any moment, and the check below still knows whom to look for.
                let waited = Instant::now();
                while !child_pid_file.exists() && waited.elapsed() < Duration::from_secs(30) {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(process)
            }),
            unavailable: unavailable.clone(),
        },
    );
    // Larger than any pipe: the request can never be written out to a process that does not read.
    let large = "v".repeat(1024 * 1024);
    let started = Instant::now();
    let refused = backend.put("api", &large, 0, None, None, None).unwrap_err();
    let took = started.elapsed();
    assert_eq!(refused.code, SecretErrorCode::BackendUnavailable);
    assert_eq!(refused.message, "Secret-Store unavailable");
    assert!(
        took >= Duration::from_secs(2) && took < Duration::from_secs(15),
        "{took:?}"
    );
    assert!(unavailable.load(Ordering::SeqCst), "the store is told");

    #[cfg(unix)]
    {
        // The process is gone and collected: nothing answers to its pid any more.
        let pid = std::fs::read_to_string(&pid_file).expect("the silent process started");
        let alive = || {
            Command::new("kill")
                .args(["-0", pid.trim()])
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        };
        let waited = Instant::now();
        while alive() {
            assert!(
                waited.elapsed() < Duration::from_secs(10),
                "the silent process is still there"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    handle.close();
}

fn the_helper_is_not_in_the_help() {
    let help = Command::new(core()).arg("--help").output().unwrap();
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(help.status.success() && text.contains("serve"), "{text}");
    assert!(
        !text.contains(HELPER_COMMAND),
        "the helper is started by the core only:\n{text}"
    );
}
