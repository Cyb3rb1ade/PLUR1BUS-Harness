//! `plur1bus model list|scan|override` CLI integration tests (D112 Task 10).
use assert_cmd::prelude::*;
use serde_json::Value;
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

    let checks = doc["checks"].as_array().unwrap();
    let last = checks.last().unwrap();
    assert_eq!(last["id"], "models.roles");
    assert_eq!(last["status"], "skip");
}
