//! The binary exists, answers `--version` with the workspace version and refuses an unknown subcommand with the
//! usage exit code of docs/errors.md.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::process::Command;

#[test]
fn version_flag_prints_the_workspace_version() {
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus-engine"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        text.trim(),
        format!("plur1bus-engine {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn an_unknown_subcommand_exits_with_the_usage_code() {
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus-engine"))
        .arg("frobnicate")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}
