//! `plur1bus audit verify` CLI tests (B5). The verifier itself is covered by `packages/core/test/audit/`; here only
//! what the CLI does on its own.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn audit_help_shows_experimental_on_each_leaf() {
    let out = bin().args(["audit", "--help"]).assert().success();
    assert!(String::from_utf8(out.get_output().stdout.clone())
        .unwrap()
        .contains("[experimental]"));
    let out = bin().args(["audit", "verify", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("[experimental]"));
}

#[test]
fn audit_verify_without_a_core_is_a_clean_error_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "verify"])
        .assert()
        .failure();
    let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(doc["schema"], "error/1");
    assert!(
        !home.join("logs").exists(),
        "the CLI never writes audit files"
    );
}
