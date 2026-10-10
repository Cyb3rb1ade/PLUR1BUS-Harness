//! `plur1bus media search|index|caption` CLI tests. The handlers are covered on the core side; here only what the CLI
//! does on its own: usage errors before any core call, the reindex confirmation, and the no-core failure.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn usage_errors_exit_2_before_any_core_call() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["media", "search"],
        vec!["media", "search", "words", "--like", "m-1"],
        vec!["media", "search", "words", "--kind", "pdf"],
        vec!["media", "search", "words", "--limit", "0"],
        vec!["media", "index"],
        vec!["media", "index", "bogus"],
        vec!["media", "caption", "set", "m-1"],
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
fn reindex_without_yes_and_without_a_terminal_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let out = bin()
        .arg("--home")
        .arg(dir.path().join("home"))
        .args(["--json", "media", "index", "reindex"])
        .assert()
        .failure()
        .code(2);
    let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(doc["schema"], "error/1");
    assert_eq!(doc["error"], "E_INVALID_PARAMS");
    assert_eq!(doc["applied"], false);
}

#[test]
fn every_new_leaf_fails_with_core_unavailable_when_no_core_runs() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    for args in [
        vec!["media", "search", "red bicycle"],
        vec!["media", "search", "--like", "m-1", "--kind", "image"],
        vec!["media", "index", "status"],
        vec!["media", "index", "pause"],
        vec!["media", "index", "resume"],
        vec!["media", "index", "reindex", "--yes"],
        vec!["media", "caption", "set", "m-1", "a red bike"],
    ] {
        let out = bin()
            .arg("--home")
            .arg(&home)
            .arg("--json")
            .args(&args)
            .assert()
            .failure();
        let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
        assert_eq!(doc["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[test]
fn leaves_are_marked_experimental_and_search_has_examples() {
    let out = bin().args(["media", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    for leaf in ["search", "index", "caption"] {
        let line = text
            .lines()
            .find(|l| l.trim_start().starts_with(leaf))
            .unwrap_or_else(|| panic!("media --help lists {leaf}"));
        assert!(line.contains("[experimental]"), "{line}");
    }
    let out = bin().args(["media", "search", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(
        text.contains("plur1bus media search \"red bicycle"),
        "{text}"
    );
}
