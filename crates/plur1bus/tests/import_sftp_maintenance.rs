//! Actual HTTP SSH source sealing and the same supervised import lifecycle as local sources.
mod common;

use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};

fn run_source(selector: &str) {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().canonicalize().unwrap();
    let home = directory.join("h");
    std::fs::create_dir(&home).unwrap();
    let mut config = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    config["engine"] =
        json!({"neo":{"enabled":false},"reranker":{"enabled":false},"dreaming":{"enabled":false}});
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let core = repo.join("packages/core/dist/core.js");
    let _supervisor = common::start_with_core(
        &home,
        &directory.join("events.jsonl"),
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", core.to_str().unwrap()),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
            ("PLUR1BUS_SECRETS_KEYRING", "memory"),
        ],
    );
    let mut supervisor = common::client(&home);
    common::wait_child(
        &mut supervisor,
        "actual SSH Core ready",
        Duration::from_secs(40),
        |child| child["process"]["state"] == "ready",
    );
    let bin = assert_cmd::cargo::cargo_bin("plur1bus");
    let server = bin
        .parent()
        .unwrap()
        .join("examples")
        .join(if cfg!(windows) {
            "sftp_test_server.exe"
        } else {
            "sftp_test_server"
        });
    assert!(server.is_file(), "required prerequisite: cargo build --locked -p plur1bus-remote-fs --example sftp_test_server");
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
        ])
        .arg(repo.join("packages/api/test/fixtures/import-maintenance-ssh-stack.mjs"))
        .arg(&home)
        .arg(directory.join("remote"))
        .arg(selector)
        .arg(server)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "actual HTTP SSH import failed: {}{}",
        String::from_utf8_lossy(&output.stderr),
        common::log_tails()
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    for proof in [
        "ssh",
        "bothFamiliesDiscovered",
        "sourceSelected",
        "snapshotSealed",
        "pluginsClassified",
        "mcpDisabled",
        "importedCards",
        "disabledSkill",
        "coreRestarted",
        "offlineStatus",
        "noLeaks",
    ] {
        assert_eq!(result[proof], true, "missing actual SSH proof {proof}");
    }
    eprintln!("actual HTTP SSH {selector}: {result}");
    supervisor
        .call("daemon.stop", json!({"budgetMs":5000}))
        .unwrap();
}

#[test]
fn first_source_family_imports_from_a_real_readonly_sftp_snapshot() {
    run_source("source-a");
}

#[test]
fn second_source_family_imports_from_a_real_readonly_sftp_snapshot() {
    run_source("source-b");
}
