//! The `plur1bus-core` binary as the supervisor will spawn it. Until P4-10, `serve` resolves its paths and refuses.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::{Command, Output};

fn core(args: &[&str], cwd: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_plur1bus-core"))
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Without a legacy core to start (no Node at `PLUR1BUS_NODE`), `serve` exits 1 after taking the lock and leaves no run file
/// behind: the token, the pid file and the socket exist only while a core serves.
#[test]
fn serve_without_a_legacy_core_exits_1_and_leaves_no_run_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir(&home).unwrap();
    for args in [
        vec!["serve", "--home", home.to_str().unwrap()],
        vec![
            "serve",
            "--home",
            home.to_str().unwrap(),
            "--lifeline",
            "stdin",
            "--instance",
            "123E4567-E89B-12D3-A456-426614174000",
        ],
    ] {
        let output = core_without_node(&args, dir.path());
        assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
        let message = stderr(&output);
        assert!(message.starts_with("core: "), "{message}");
        assert!(
            message.contains("the legacy core did not start"),
            "{message}"
        );
        let run: Vec<String> = std::fs::read_dir(home.join("run"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(run.is_empty(), "run files left behind: {run:?}");
    }
}

fn core_without_node(args: &[&str], cwd: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_plur1bus-core"))
        .args(args)
        .current_dir(cwd)
        .env("PLUR1BUS_NODE", cwd.join("no-such-node"))
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn a_relative_home_is_made_absolute_against_the_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let output = core_without_node(&["serve", "--home", "rel"], dir.path());
    assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
    assert!(
        dir.path().join("rel/state/core.lock").is_file(),
        "the lock was taken under <cwd>/rel"
    );
}

#[test]
fn usage_errors_exit_2_like_the_typescript_core() {
    let dir = tempfile::tempdir().unwrap();
    for (args, needle) in [
        (vec![], "Usage"),
        (vec!["serve"], "--home"),
        (vec!["serve", "--home="], "needs a value"),
        (vec!["serve", "--home", "/h", "--lifeline", "pipe"], "stdin"),
        (
            vec!["serve", "--home", "/h", "--instance", "not-a-uuid"],
            "must be a UUID",
        ),
        (vec!["serve", "--home", "/h", "--unknown"], "--unknown"),
    ] {
        let output = core(&args, dir.path());
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}: {}",
            stderr(&output)
        );
        assert!(
            stderr(&output).contains(needle),
            "{args:?}: {}",
            stderr(&output)
        );
    }
}

#[test]
fn the_core_validators_cover_every_core_method() {
    let started = std::time::Instant::now();
    let validators = plur1bus_core::server::validators().unwrap();
    let elapsed = started.elapsed();
    assert_eq!(validators.server(), "core");
    for method in plur1bus_rpc::server::CORE_METHODS {
        assert!(
            !matches!(
                validators.check_result(method, &serde_json::json!(null)),
                Err(plur1bus_rpc::server::DispatchError::UnknownMethod)
            ),
            "{method}"
        );
    }
    eprintln!(
        "compiled {} core validators in {elapsed:?}",
        plur1bus_rpc::server::CORE_METHODS.len()
    );
}
