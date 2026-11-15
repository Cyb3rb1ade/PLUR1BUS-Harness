//! The secret helper (P4-20) as a process: `plur1bus-core secrets-helper` behind the isolated backend, over real pipes.
//! What a helper can do wrong is scripted in-process (`src/secrets/isolated/tests.rs`); here are the things only a process
//! shows: the executable serves the file backend, a second helper reads what the first wrote, the helper writes nothing
//! but frames and ends with its input, and a process that never answers is killed at the budget even while a request
//! larger than a pipe is still being written to it.
//!
//! No helper started here can reach a keyring of the machine: every one runs with the test seam
//! (`PLUR1BUS_SECRETS_KEYRING`), switched off unless a test asks for the keyring in memory. The adapters for the real
//! keyrings are exercised by `tests/keyring_probe.rs`, in CI only.
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
    helper_of, isolated_backend, spawn_process, BackendDescription, IsolatedOptions, SpawnHelper,
    HELPER_COMMAND,
};
use plur1bus_core::secrets::os_keyring::{ALLOW_VARIABLE, SEAM_VARIABLE};
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
    // Every process started from here inherits the keyring seam, switched off: no helper can reach a keyring of the
    // machine, however a test starts it. (Set before any thread exists.)
    std::env::set_var(ALLOW_VARIABLE, "1");
    std::env::set_var(SEAM_VARIABLE, "off");
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
            "a_keyring_that_is_switched_off_is_not_there",
            a_keyring_that_is_switched_off_is_not_there,
        ),
        (
            "the_keyring_backend_runs_in_the_helper_over_the_keyring_in_memory",
            the_keyring_backend_runs_in_the_helper_over_the_keyring_in_memory,
        ),
        (
            "a_seam_the_helper_may_not_use_ends_it_before_it_serves",
            a_seam_the_helper_may_not_use_ends_it_before_it_serves,
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
/// `plur1bus-core secrets-helper` with the keyring seam at `keyring` (`off` or `memory`).
fn helper_command(keyring: &str) -> Command {
    let mut command = Command::new(core());
    command
        .arg(HELPER_COMMAND)
        .env(ALLOW_VARIABLE, "1")
        .env(SEAM_VARIABLE, keyring);
    command
}

fn helper_with(keyring: &'static str) -> SpawnHelper {
    Box::new(move |_| spawn_process(helper_command(keyring)))
}

/// The production port (`helper_of`): the helper inherits this process's environment, and with it the seam.
fn options(unavailable: &Arc<AtomicBool>) -> IsolatedOptions {
    IsolatedOptions {
        budget: Duration::from_secs(20),
        spawn: helper_of(core()),
        unavailable: unavailable.clone(),
    }
}

fn options_with(keyring: &'static str, unavailable: &Arc<AtomicBool>) -> IsolatedOptions {
    IsolatedOptions {
        spawn: helper_with(keyring),
        ..options(unavailable)
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

/// A helper whose keyring is switched off: the backend says the keyring is not there, and the helper stays up.
fn a_keyring_that_is_switched_off_is_not_there() {
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

/// The keyring backend (index entry, one credential per name) behind the helper, over the keyring that lives in the
/// helper's memory: what the adapters of the operating systems are given to do, without one of them.
fn the_keyring_backend_runs_in_the_helper_over_the_keyring_in_memory() {
    let unavailable: Arc<AtomicBool> = Arc::default();
    let (mut backend, handle) = isolated_backend(
        BackendDescription::Keyring {
            service: "plur1bus:helper-test".into(),
        },
        options_with("memory", &unavailable),
    );
    let probe = backend.probe().unwrap();
    assert_eq!((probe.available, probe.reason), (true, None));
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
        json!({ "name": "api", "backend": "keyring", "createdAt": "2026-01-02T03:04:05.678Z",
            "updatedAt": "2026-01-02T03:04:05.678Z", "updatedBy": "owner:local", "description": "what it is for" })
    );
    assert_eq!(backend.get("api").unwrap().as_deref(), Some(VALUE));
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
    assert_eq!(registered, [VALUE]);
    let names: Vec<String> = backend
        .list()
        .unwrap()
        .iter()
        .map(|meta| meta.to_json()["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["api"]);
    assert!(backend.delete("api", None).unwrap());
    assert_eq!(backend.get("api").unwrap(), None);
    assert!(!unavailable.load(Ordering::SeqCst));
    handle.close();
}

/// The seam without its permission, or with a value nobody knows: the helper ends at once with 2 and has served
/// nothing. It does not fall through to the keyring of the machine.
fn a_seam_the_helper_may_not_use_ends_it_before_it_serves() {
    let run = |configure: &dyn Fn(&mut Command)| {
        let mut command = Command::new(core());
        command
            .arg(HELPER_COMMAND)
            .env_remove(ALLOW_VARIABLE)
            .env_remove(SEAM_VARIABLE)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure(&mut command);
        let mut child = command.spawn().unwrap();
        // A request for the keyring is waiting on its input, should it read after all.
        let description = BackendDescription::Keyring {
            service: "plur1bus:helper-test".into(),
        };
        let frame = encode_frame(&request(1, &description, Operation::Probe, &[])).unwrap();
        let _ = child.stdin.take().unwrap().write_all(&frame);
        let output = child.wait_with_output().unwrap();
        (output.status.code(), output.stdout, output.stderr)
    };
    for (what, configure) in [
        (
            "no permission",
            (&|c: &mut Command| {
                c.env(SEAM_VARIABLE, "memory");
            }) as &dyn Fn(&mut Command),
        ),
        ("a permission that is not 1", &|c: &mut Command| {
            c.env(SEAM_VARIABLE, "off").env(ALLOW_VARIABLE, "yes");
        }),
        ("an unknown stand-in", &|c: &mut Command| {
            c.env(SEAM_VARIABLE, "real").env(ALLOW_VARIABLE, "1");
        }),
    ] {
        let (code, out, err) = run(configure);
        assert_eq!(code, Some(2), "{what}");
        assert!(out.is_empty() && err.is_empty(), "{what}: {out:?} {err:?}");
    }
    // With the seam as it should be, the same request is answered.
    let (code, out, _) = run(&|c: &mut Command| {
        c.env(SEAM_VARIABLE, "off").env(ALLOW_VARIABLE, "1");
    });
    assert_eq!(code, Some(0));
    assert!(!out.is_empty());
}

fn the_helper_writes_frames_only_and_ends_with_its_input() {
    let home = tempfile::tempdir().unwrap();
    let mut helper = spawn_process(helper_command("off")).unwrap();
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
