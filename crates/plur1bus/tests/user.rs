mod common;

use assert_cmd::Command;
use predicates::prelude::*;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn user_is_no_longer_a_stub_and_lists_its_subcommands() {
    bin()
        .args(["user", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("ls"))
        .stdout(predicate::str::contains("pair"))
        .stdout(predicate::str::contains("link"))
        .stdout(predicate::str::contains("unlink"));
}

#[test]
fn pair_has_start_claim_and_confirm() {
    bin()
        .args(["user", "pair", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("start"))
        .stdout(predicate::str::contains("claim"))
        .stdout(predicate::str::contains("confirm"));
}

#[test]
fn without_a_core_it_answers_core_unavailable_not_a_stub() {
    let home = tempfile::tempdir().unwrap();
    let out = bin()
        .args(["--json", "--home"])
        .arg(home.path())
        .args(["user", "ls"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE");
}
