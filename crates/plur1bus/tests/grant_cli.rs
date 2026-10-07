//! `plur1bus grant …` CLI tests that need no core (D109, D8). The pure parts (parameters, rendering) are unit tests in
//! `src/commands/grant.rs`; the end-to-end run over a real core is `tests/system/`.
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
fn every_grant_leaf_is_experimental() {
    for args in [
        vec!["grant"],
        vec!["grant", "list"],
        vec!["grant", "add"],
        vec!["grant", "revoke"],
    ] {
        let mut a = args.clone();
        a.push("--help");
        let o = run(&a);
        assert!(o.status.success(), "{args:?}");
        assert!(text(&o).contains("[experimental]"), "{args:?}");
    }
}

#[test]
fn add_input_errors_exit_2_before_any_connection() {
    for args in [
        vec![
            "grant", "add", "fs.write", "--agent", "a", "--scope", "task",
        ],
        vec![
            "grant", "add", "fs.write", "--agent", "a", "--scope", "session",
        ],
        vec![
            "grant",
            "add",
            "fs.write",
            "--agent",
            "a",
            "--scope",
            "always",
            "--expires",
            "soon",
        ],
        vec![
            "grant",
            "add",
            "fs.write",
            "--agent",
            "a",
            "--scope",
            "always",
            "--task-id",
            "t",
        ],
    ] {
        let mut a = vec!["--json"];
        a.extend(&args);
        let o = run(&a);
        assert_eq!(o.status.code(), Some(2), "{args:?}: {}", text(&o));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["schema"], "error/1");
        assert_eq!(v["error"], "E_INVALID_PARAMS", "{args:?}");
    }
    // clap-level refusals are exit 2 too
    assert_eq!(
        run(&["grant", "add", "fs.write", "--agent", "a", "--scope", "once"])
            .status
            .code(),
        Some(2)
    );
    assert_eq!(
        run(&["grant", "list", "--limit", "0"]).status.code(),
        Some(2)
    );
}

#[test]
fn without_a_core_every_grant_command_says_so() {
    for args in [
        vec!["grant", "list"],
        vec![
            "grant", "add", "fs.write", "--agent", "a", "--scope", "always",
        ],
        vec!["grant", "revoke", "grt_1", "--reason", "done"],
    ] {
        let mut a = vec!["--json"];
        a.extend(&args);
        let o = run(&a);
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?}");
        assert_eq!(v["degraded"]["capability"], "grants");
    }
}
