//! `plur1bus channel ...` CLI integration tests (R3). The handlers are covered by
//! `packages/core/test/rpc/channel-surface.test.ts`; here only what the CLI does on its own.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

const LEAVES: [&str; 8] = [
    "list",
    "show",
    "enable",
    "disable",
    "set",
    "test",
    "status",
    "link-help",
];

#[test]
fn every_leaf_is_marked_experimental_in_the_group_help() {
    let out = bin().args(["channel", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    for leaf in LEAVES {
        let line = text
            .lines()
            .find(|l| l.trim_start().starts_with(leaf))
            .unwrap_or_else(|| panic!("channel --help lists {leaf}"));
        assert!(line.contains("[experimental]"), "{line}");
    }
}

#[test]
fn set_help_says_a_secret_key_takes_a_name() {
    let out = bin().args(["channel", "set", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("NAME of a secret"), "{text}");
    assert!(text.contains("plur1bus secret set"), "{text}");
}

#[test]
fn missing_arguments_are_usage_errors_before_any_core_call() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["channel"],
        vec!["channel", "show"],
        vec!["channel", "set", "discord", "locale"],
        vec!["channel", "test", "discord", "--to", "someone"],
    ] {
        bin()
            .arg("--home")
            .arg(dir.path().join("home"))
            .args(&args)
            .assert()
            .failure()
            .code(2);
    }
}

#[test]
fn every_leaf_fails_with_core_unavailable_when_no_core_runs() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    for args in [
        vec!["channel", "list"],
        vec!["channel", "status"],
        vec!["channel", "show", "discord"],
        vec!["channel", "link-help", "discord"],
        vec!["channel", "enable", "discord"],
        vec!["channel", "disable", "discord"],
        vec!["channel", "set", "discord", "locale", "de"],
        vec!["channel", "test", "discord"],
        vec!["channel", "test", "discord", "--send-owner"],
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
fn a_value_typed_for_a_secret_key_is_never_echoed_when_no_core_runs() {
    let dir = tempfile::tempdir().unwrap();
    let typed = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    let out = bin()
        .arg("--home")
        .arg(dir.path().join("home"))
        .args([
            "--json",
            "channel",
            "set",
            "slack",
            "botTokenSecret",
            &typed,
        ])
        .assert()
        .failure();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap()
        + &String::from_utf8(out.get_output().stderr.clone()).unwrap();
    assert!(!text.contains(&typed), "{text}");
}
