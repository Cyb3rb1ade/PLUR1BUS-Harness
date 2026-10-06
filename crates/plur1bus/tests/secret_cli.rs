//! `plur1bus secret …` CLI tests that need no core (M2). The end-to-end run over a real core is
//! `tests/system/secrets.test.ts`.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

const MARKER: &str = "p1b-SECRET-MARKER-9f3a7c1e5d2b";

fn bin(home: &std::path::Path) -> Command {
    let mut c = Command::cargo_bin("plur1bus").unwrap();
    c.arg("--home").arg(home);
    c
}

fn text(o: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

#[test]
fn every_secret_leaf_is_experimental() {
    let home = tempfile::tempdir().unwrap();
    let top = bin(home.path())
        .args(["secret", "--help"])
        .output()
        .unwrap();
    assert!(text(&top).contains("[experimental]"));
    for sub in ["status", "set", "get", "rm", "ls"] {
        let o = bin(home.path())
            .args(["secret", sub, "--help"])
            .output()
            .unwrap();
        assert!(o.status.success(), "{sub}");
        assert!(
            text(&o).contains("[experimental]"),
            "secret {sub} --help should show [experimental]"
        );
    }
}

#[test]
fn a_value_in_an_argument_is_refused_without_echoing_it() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path())
        .args(["secret", "set", "k", MARKER])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(!text(&o).contains(MARKER), "{}", text(&o));
    assert!(text(&o).contains("stdin"));
    // --json too, and a value that looks like a flag
    let o = bin(home.path())
        .args(["--json", "secret", "set", "k", &format!("--{MARKER}")])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(!text(&o).contains(MARKER));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["schema"], "error/1");
    assert_eq!(v["reason"], "value-in-argument");
}

#[test]
fn set_refuses_an_empty_stdin_before_it_connects() {
    let home = tempfile::tempdir().unwrap();
    let mut child = bin(home.path())
        .args(["--json", "secret", "set", "k"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
    let o = child.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(
        (v["error"].as_str(), v["detail"].as_str()),
        (Some("E_INVALID_PARAMS"), Some("value"))
    );
}

#[test]
fn rm_needs_yes_outside_a_terminal_and_does_not_connect() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path())
        .args(["--json", "secret", "rm", "k"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["applied"], false);
}

#[test]
fn without_a_core_every_command_says_so_and_names_the_capability() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["status"],
        vec!["ls"],
        vec!["get", "k"],
        vec!["get", "k", "--reveal"],
        vec!["rm", "k", "--yes"],
    ] {
        let mut full = vec!["--json", "secret"];
        full.extend(args.iter().copied());
        let o = bin(home.path())
            .args(&full)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?}");
        assert_eq!(v["degraded"]["capability"], "secrets");
    }
}
