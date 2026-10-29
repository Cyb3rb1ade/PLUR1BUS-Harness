//! The supervisor serves bounded maintenance metadata while Core is offline.
mod common;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::time::Duration;

fn import_tree(home: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn visit(base: &Path, path: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            let key = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                out.insert(format!("{key}/"), vec![]);
                visit(base, &path, out);
            } else {
                out.insert(key, std::fs::read(path).unwrap());
            }
        }
    }
    let mut tree = std::collections::BTreeMap::new();
    visit(home, &home.join("imports"), &mut tree);
    tree
}

fn call(home: &Path, method: &str, params: Value) -> Value {
    let mut stream = common::raw(home);
    writeln!(
        stream,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"supervisor.auth",
        "params":{"token":common::token(home)}})
    )
    .unwrap();
    stream.flush().unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let auth: Value = serde_json::from_str(&line).unwrap();
    assert!(auth.get("result").is_some(), "authentication failed");
    writeln!(
        reader.get_mut(),
        "{}",
        json!({"jsonrpc":"2.0","id":2,"method":method,"params":params})
    )
    .unwrap();
    reader.get_mut().flush().unwrap();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == 2 {
            return value;
        }
    }
}

#[test]
fn empty_run_history_is_available_on_the_actual_supervisor() {
    let dir = tempfile::tempdir().unwrap();
    let _supervisor = common::start(dir.path());
    let before = import_tree(dir.path());
    let response = call(dir.path(), "admin.import.runs", json!({"limit":25}));
    assert_eq!(response["result"], json!({"runs":[]}));
    assert_eq!(
        import_tree(dir.path()),
        before,
        "reading history must preserve the startup import-lock tree"
    );
}

#[test]
fn malformed_maintenance_identifiers_are_refused_without_filesystem_effects() {
    let dir = tempfile::tempdir().unwrap();
    let _supervisor = common::start(dir.path());
    let before = import_tree(dir.path());
    for method in ["admin.import.status", "admin.import.abort"] {
        let response = call(dir.path(), method, json!({"runId":"../outside"}));
        assert_eq!(response["error"]["data"]["error"], "E_INVALID_PARAMS");
    }
    assert_eq!(import_tree(dir.path()), before);
}

fn real_stack(mode: &str) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    let source = dir.path().join("source");
    std::fs::create_dir(&home).unwrap();
    let mut config = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    config["engine"] =
        json!({"neo":{"enabled":false},"reranker":{"enabled":false},"dreaming":{"enabled":false}});
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let core_entry = root.join("packages/core/dist/core.js");
    let _supervisor = common::start_with_core(
        &home,
        &dir.path().join("events.jsonl"),
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", core_entry.to_str().unwrap()),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
            (
                "PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY",
                if mode == "failure" { "1" } else { "" },
            ),
        ],
    );
    let mut supervisor = common::client(&home);
    common::wait_child(
        &mut supervisor,
        "actual Core ready",
        Duration::from_secs(40),
        |child| child["process"]["state"] == "ready",
    );
    let output = std::process::Command::new("node")
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
        ])
        .arg(root.join("packages/api/test/fixtures/import-maintenance-native-stack.mjs"))
        .arg(&home)
        .arg(&source)
        .arg(mode)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env(
            "PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY",
            if mode == "failure" { "1" } else { "" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "actual maintenance HTTP stack failed: {}{}",
        String::from_utf8_lossy(&output.stderr),
        common::log_tails()
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result.as_object().unwrap().values().all(Value::is_boolean));
    let proofs: &[&str] = match mode {
        "abort" => &[
            "aborted",
            "restored",
            "baselineExact",
            "offlineAbort",
            "offlineStatus",
            "coreRestarted",
        ],
        "rollback" => &[
            "imported",
            "coreRestarted",
            "offlineStatus",
            "disabledSkill",
            "rollback",
            "restored",
            "baselineExact",
            "importedSkillRemoved",
        ],
        "failure" => &[
            "failed",
            "restored",
            "baselineExact",
            "entityAppliedThenUndone",
            "offlineStatus",
            "coreRestarted",
        ],
        "device" => &[
            "imported",
            "coreRestarted",
            "offlineStatus",
            "disabledSkill",
            "memoryRecall",
            "deviceMfa",
        ],
        _ => &[
            "imported",
            "coreRestarted",
            "offlineStatus",
            "disabledSkill",
            "memoryRecall",
        ],
    };
    for proof in proofs {
        assert_eq!(
            result[proof], true,
            "missing actual maintenance proof {proof}"
        );
    }
    eprintln!("actual HTTP maintenance {mode}: {result}");
    supervisor
        .call("daemon.stop", json!({"budgetMs":5000}))
        .unwrap();
}

#[test]
fn real_supervisor_executes_the_sealed_import_and_restarts_held_core() {
    real_stack("complete");
}

#[test]
fn real_supervisor_restores_an_aborted_import_before_restarting_core() {
    real_stack("abort");
}

#[test]
fn real_supervisor_applies_a_fresh_preflighted_manual_rollback() {
    real_stack("rollback");
}

#[test]
fn real_supervisor_undoes_a_mid_entity_failure_before_restarting_core() {
    real_stack("failure");
}

#[test]
fn real_mfa_approved_desktop_cookie_keeps_only_its_active_import_authority_offline() {
    real_stack("device");
}
