//! `plur1bus approval …` CLI tests that need no core (D109, D8).
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::{Command, Stdio};

fn run(args: &[&str]) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(home.path())
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn text(o: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

#[test]
fn every_approval_leaf_is_experimental() {
    for sub in ["list", "pending", "approve", "deny", "verify"] {
        let o = run(&["approval", sub, "--help"]);
        assert!(o.status.success(), "{sub}");
        assert!(text(&o).contains("[experimental]"), "approval {sub}");
    }
    assert!(text(&run(&["approval", "--help"])).contains("[experimental]"));
}

#[test]
fn approve_without_a_terminal_and_without_yes_is_refused_and_never_connects() {
    for json in [true, false] {
        let mut a = vec![];
        if json {
            a.push("--json");
        }
        a.extend(["approval", "approve", "apr_1"]);
        let o = run(&a);
        assert_eq!(o.status.code(), Some(2), "{}", text(&o));
        if json {
            let v: Value = serde_json::from_slice(&o.stdout).unwrap();
            assert_eq!(v["error"], "E_INVALID_PARAMS");
            assert_eq!(v["reason"], "confirmation-required");
            assert_eq!(v["applied"], false);
        } else {
            assert!(text(&o).contains("--yes"), "{}", text(&o));
        }
    }
}

#[test]
fn approve_with_yes_reaches_the_core_step() {
    let o = run(&["--json", "approval", "approve", "apr_1", "--yes"]);
    assert_eq!(o.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE");
    assert_eq!(v["degraded"]["capability"], "approvals");
}

#[test]
fn without_a_core_every_other_command_says_so() {
    for args in [
        vec!["approval", "list"],
        vec!["approval", "pending"],
        vec!["approval", "deny", "apr_1"],
        vec!["approval", "verify"],
    ] {
        let mut a = vec!["--json"];
        a.extend(&args);
        let o = run(&a);
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[test]
fn bad_input_exits_2() {
    assert_eq!(
        run(&["approval", "list", "--status", "waiting"])
            .status
            .code(),
        Some(2)
    );
    assert_eq!(
        run(&["approval", "approve", "apr_1", "--nonce", "x"])
            .status
            .code(),
        Some(2)
    );
    assert_eq!(
        run(&["approval", "list", "--limit", "0"]).status.code(),
        Some(2)
    );
}
