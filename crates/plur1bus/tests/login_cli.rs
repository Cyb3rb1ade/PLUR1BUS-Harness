//! `plur1bus login …` CLI tests that need no core (R2). The flows against a scripted core are unit tests in
//! `commands/login.rs`; the core side (handlers, RBAC, no token in any result) is `packages/core/test/rpc/auth-surface.test.ts`.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

const MARKER: &str = "sk-p1b-SECRET-MARKER-9f3a7c1e5d2b";

fn bin(home: &std::path::Path) -> Command {
    let mut c = Command::cargo_bin("plur1bus").unwrap();
    c.arg("--home").arg(home);
    c.env_remove("PLUR1BUS_CONTAINER");
    c
}

fn text(o: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn piped(home: &std::path::Path, args: &[&str], stdin: &[u8]) -> std::process::Output {
    let mut child = bin(home)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn login_is_no_longer_a_stub_and_is_experimental() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path()).args(["login", "--help"]).output().unwrap();
    assert!(o.status.success());
    let help = text(&o);
    assert!(help.contains("[experimental]"));
    assert!(help.contains("--paste") && help.contains("--no-browser"));
    for sub in ["status", "list", "logout"] {
        let o = bin(home.path())
            .args(["login", sub, "--help"])
            .output()
            .unwrap();
        assert!(o.status.success(), "{sub}");
        assert!(text(&o).contains("[experimental]"), "{sub}");
    }
    assert!(!text(&bin(home.path()).arg("login").output().unwrap()).contains("arrives in"));
}

#[test]
fn a_key_in_an_argument_is_refused_without_echoing_it() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["login", "openai", "--api-key", MARKER],
        vec!["login", "openai", &format!("--api-key={MARKER}")],
        vec!["login", "--api-key", MARKER],
        vec!["login", "anthropic", "--key", MARKER],
        vec!["login", "anthropic", &format!("--key={MARKER}")],
        vec!["login", "anthropic", MARKER],
        vec!["login", MARKER],
    ] {
        let o = bin(home.path()).args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(!text(&o).contains("MARKER"), "{args:?}: {}", text(&o));
        assert!(text(&o).contains("stdin"), "{args:?}");
        let o = bin(home.path()).arg("--json").args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(!text(&o).contains("MARKER"), "{args:?}");
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["schema"], "error/1");
        assert_eq!(v["reason"], "value-in-argument");
    }
}

#[test]
fn bare_login_and_unknown_providers_are_usage_errors() {
    let home = tempfile::tempdir().unwrap();
    let o = bin(home.path()).args(["--json", "login"]).output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(
        (v["error"].as_str(), v["reason"].as_str()),
        (Some("E_INVALID_PARAMS"), Some("provider-required"))
    );
    let o = bin(home.path())
        .args(["--json", "login", "nonesuch"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(2));
    assert!(!text(&o).contains("nonesuch"));
}

#[test]
fn an_api_key_is_read_from_stdin_validated_and_never_printed() {
    let home = tempfile::tempdir().unwrap();
    // Empty stdin: refused before any connection.
    let o = piped(home.path(), &["--json", "login", "anthropic"], b"\n");
    assert_eq!(o.status.code(), Some(2));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(
        (v["error"].as_str(), v["detail"].as_str()),
        (Some("E_INVALID_PARAMS"), Some("key"))
    );
    // A key with no core to take it: fails at the connection, and the key is nowhere in the output.
    let o = piped(
        home.path(),
        &["--json", "login", "anthropic"],
        format!("{MARKER}\n").as_bytes(),
    );
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(!text(&o).contains("MARKER"), "{}", text(&o));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE");
    // OAuth-only flags do not mix with an API key.
    let o = piped(home.path(), &["login", "anthropic", "--paste"], b"x\n");
    assert_eq!(o.status.code(), Some(2));
}

#[test]
fn status_list_and_logout_report_an_unreachable_core_as_json() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["--json", "login", "status"],
        vec!["--json", "login", "list"],
        vec!["--json", "login", "logout", "abcdef0123456789"],
    ] {
        let o = bin(home.path()).args(&args).output().unwrap();
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["schema"], "error/1", "{args:?}");
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}
