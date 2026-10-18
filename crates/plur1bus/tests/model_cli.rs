//! `plur1bus model list|scan|override` CLI integration tests (D112 Task 10).
use assert_cmd::prelude::*;
use serde_json::{json, Value};
use std::fs;
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn model_help_shows_experimental_on_each_leaf() {
    let mut cmd = bin();
    cmd.args(["model", "--help"]);
    let assert = cmd.assert().success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("[experimental]"));

    for sub in ["list", "scan", "override"] {
        let mut cmd = bin();
        cmd.args(["model", sub, "--help"]);
        let assert = cmd.assert().success();
        let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
        assert!(
            stdout.contains("[experimental]"),
            "model {sub} --help should show [experimental]"
        );
    }
}

#[test]
fn model_list_stale_read_without_core() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let cat_dir = home.join("catalog");
    fs::create_dir_all(&cat_dir).unwrap();

    let fixture = serde_json::json!({
        "revision": 1,
        "models": [
            {
                "provider": "p1",
                "id": "m1",
                "displayName": "Model 1",
                "kind": "chat",
                "status": "available",
                "firstSeen": "2026-10-03T10:00:00.000Z",
                "lastSeen": "2026-10-03T10:00:00.000Z",
                "source": "scan",
                "capabilities": [],
                "aliases": [],
                "overrides": {}
            }
        ],
        "providers": {
            "p1": {
                "lastScanAt": "2026-10-03T10:00:00.000Z",
                "lastResult": "ok",
                "modelCount": 1
            }
        }
    });
    fs::write(cat_dir.join("models.json"), fixture.to_string()).unwrap();

    let mut cmd = bin();
    cmd.arg("--home")
        .arg(&home)
        .args(["--json", "model", "list"]);
    let assert = cmd.assert().success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let doc: Value = serde_json::from_str(&stdout).unwrap();

    assert_eq!(doc["schema"], "model.list/1");
    assert_eq!(doc["stale"], true);
    assert_eq!(doc["models"].as_array().unwrap().len(), 1);
    assert_eq!(doc["models"][0]["id"], "m1");
    assert_eq!(doc["models"][0]["new"], true);
    let mut human = bin();
    let output = human
        .arg("--home")
        .arg(&home)
        .args(["model", "list"])
        .assert()
        .success();
    assert!(String::from_utf8_lossy(&output.get_output().stdout).contains("available new"));
}

#[test]
fn model_scan_and_override_fail_when_core_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();

    // scan --json exits 1 with E_CORE_UNAVAILABLE
    let mut cmd = bin();
    cmd.arg("--home")
        .arg(&home)
        .args(["--json", "model", "scan"]);
    let assert = cmd.assert().code(1);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let doc: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(doc["error"], "E_CORE_UNAVAILABLE");

    // override --json exits 1 with E_CORE_UNAVAILABLE
    let mut cmd = bin();
    cmd.arg("--home").arg(&home).args([
        "--json", "model", "override", "p1", "m1", "--name", "New Name",
    ]);
    let assert = cmd.assert().code(1);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let doc: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(doc["error"], "E_CORE_UNAVAILABLE");
}

#[test]
fn firstaid_check_includes_models_roles_at_end() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();

    let mut cmd = bin();
    cmd.arg("--home")
        .arg(&home)
        .args(["--json", "1staid", "check"]);
    let assert = cmd.assert().success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let doc: Value = serde_json::from_str(&stdout).unwrap();
    assert!(
        doc.get("error").is_none(),
        "a success carries no error object: {doc}"
    );

    let checks = doc["checks"].as_array().unwrap();
    // `remote.exposure` and `models.decision` are appended after it (check ids are append-only).
    let last = &checks[checks.len() - 4];
    assert_eq!(last["id"], "dreams.last-runs");
    assert_eq!(last["status"], "skip");
    assert_eq!(checks[checks.len() - 3]["id"], "remote.exposure");
    // No decision role on a fresh home: an info row, not a warning, naming the way to set it.
    let decision = checks
        .iter()
        .find(|c| c["id"] == "models.decision")
        .unwrap();
    assert_eq!(decision["id"], "models.decision");
    assert_eq!(decision["status"], "info", "{decision}");
    assert_eq!(
        decision["detail"]["limited"],
        json!(["messageTriage", "toolPreselection", "modelClassChoice"])
    );
    assert!(decision["hint"]
        .as_str()
        .unwrap()
        .contains("modelRoles.decision"));
}

#[test]
fn firstaid_check_reports_the_decision_role_as_ok_once_it_is_set() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    fs::write(
        home.join("config.json"),
        json!({ "modelRoles": { "decision": "p/small" } }).to_string(),
    )
    .unwrap();

    let mut cmd = bin();
    cmd.arg("--home")
        .arg(&home)
        .args(["--json", "1staid", "check"]);
    // The exit code depends on unrelated rows; only this row matters here.
    let out = cmd.output().unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let doc: Value = serde_json::from_str(&stdout).unwrap();
    let decision = doc["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "models.decision")
        .unwrap()
        .clone();
    assert_eq!(decision["id"], "models.decision");
    assert_eq!(decision["status"], "ok", "{decision}");
}

#[test]
fn session_model_and_chat_reasoning_are_experimental_and_invalid_choices_are_usage_errors() {
    for args in [
        vec!["session", "model", "get", "--help"],
        vec!["session", "model", "set", "--help"],
    ] {
        let output = bin().args(args).output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("[experimental]"));
    }
    for args in [
        vec!["session", "model", "set", "ses_1"],
        vec!["session", "model", "set", "ses_1", "--reasoning", "banana"],
        vec!["chat", "--reasoning", "banana"],
    ] {
        assert_eq!(bin().args(args).output().unwrap().status.code(), Some(2));
    }
    let output = bin().args(["chat", "--help"]).output().unwrap();
    assert!(String::from_utf8_lossy(&output.stdout).contains("--reasoning"));
}
