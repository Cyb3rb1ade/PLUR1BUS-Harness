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

#[test]
fn serve_resolves_the_run_files_then_refuses_until_the_front_door_lands_and_touches_nothing() {
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
        let output = core(&args, dir.path());
        assert_eq!(output.status.code(), Some(1), "{}", stderr(&output));
        let message = stderr(&output);
        assert!(message.starts_with("core: "), "{message}");
        assert!(message.contains("lands in P4-10"), "{message}");
        if cfg!(unix) {
            let address = format!("{}/run/core.sock", home.display());
            assert!(message.contains(&address), "{message}");
        }
        assert_eq!(
            std::fs::read_dir(&home).unwrap().count(),
            0,
            "nothing written"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_relative_home_is_made_absolute_against_the_working_directory() {
    let dir = tempfile::tempdir().unwrap();
    let output = core(&["serve", "--home", "rel"], dir.path());
    assert_eq!(output.status.code(), Some(1));
    let message = stderr(&output);
    let address = message
        .split_whitespace()
        .find(|word| word.ends_with("core.sock"))
        .unwrap_or_else(|| panic!("{message}"));
    assert!(Path::new(address).is_absolute(), "{address}");
    assert!(address.ends_with("/rel/run/core.sock"), "{address}");
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
