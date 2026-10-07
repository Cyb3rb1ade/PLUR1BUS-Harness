//! `plur1bus budget status|set` CLI integration tests (M2 L8). The core itself is covered by
//! `packages/core/test/budget-rpc.test.ts`; here only what the CLI does on its own.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn budget_help_shows_experimental_on_each_leaf() {
    let out = bin().args(["budget", "--help"]).assert().success();
    assert!(String::from_utf8(out.get_output().stdout.clone())
        .unwrap()
        .contains("[experimental]"));
    for sub in ["status", "set"] {
        let out = bin().args(["budget", sub, "--help"]).assert().success();
        let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
        assert!(text.contains("[experimental]"), "budget {sub} --help");
    }
}

#[test]
fn budget_set_refuses_an_incomplete_limit_before_touching_the_core() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args([
            "--json", "budget", "set", "--global", "--period", "day", "--hard", "5",
        ])
        .assert()
        .failure()
        .code(2);
    let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(doc["schema"], "error/1");
    assert_eq!(doc["error"], "E_INVALID_PARAMS");
    assert!(doc["message"].as_str().unwrap().contains("--metric"));
}

#[test]
fn budget_set_refuses_a_malformed_amount() {
    let dir = tempfile::tempdir().unwrap();
    let out = bin()
        .arg("--home")
        .arg(dir.path().join("home"))
        .args([
            "--json", "budget", "set", "--agent", "main", "--period", "day", "--metric", "cost",
            "--hard", "five",
        ])
        .assert()
        .failure()
        .code(2);
    let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(doc["error"], "E_INVALID_PARAMS");
    assert!(doc["message"].as_str().unwrap().contains("USD"));
}

#[test]
fn budget_status_and_set_fail_with_core_unavailable_when_no_core_runs() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    for args in [
        vec!["budget", "status"],
        vec!["budget", "set", "--timezone", "UTC"],
    ] {
        let out = bin()
            .arg("--home")
            .arg(&home)
            .arg("--json")
            .args(&args)
            .assert()
            .failure();
        let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
        assert_eq!(doc["schema"], "error/1", "{args:?}");
        assert_eq!(doc["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[test]
fn budget_set_rejects_global_with_agent_and_unknown_period() {
    bin()
        .args([
            "budget", "set", "--global", "--agent", "a", "--period", "day", "--metric", "cost",
            "--hard", "1",
        ])
        .assert()
        .failure();
    bin()
        .args([
            "budget", "set", "--global", "--period", "week", "--metric", "cost", "--hard", "1",
        ])
        .assert()
        .failure();
}
