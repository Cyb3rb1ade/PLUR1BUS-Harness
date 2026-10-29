//! Imported MCP candidates become inert checked packages inside the isolated worker, never in the supervisor.
use serde_json::{json, Value};
use std::process::Command;

fn candidate() -> Value {
    json!({"schema":"import.mcp-candidate/1","source":"hermes","profile":null,
        "name":"hermes-default-example-0123456789ab","fingerprint":"a".repeat(64),
        "transport":{"type":"http","url":"https://source.example/mcp","auth":"header"},
        "requiredSecrets":[{"slot":"TOKEN"}],"reasons":[]})
}

#[test]
fn imported_metadata_is_prepared_as_a_checked_inert_package_by_the_real_worker() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&plur1bus_config::defaults()).unwrap(),
    )
    .unwrap();
    let source = dir.path().join("candidate.json");
    std::fs::write(&source, serde_json::to_vec(&candidate()).unwrap()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let output = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&home)
        .args([
            "ext",
            "__worker",
            "import-mcp",
            "--id",
            &id,
            "--installation-id",
            &"b".repeat(64),
            "--candidate-file",
        ])
        .arg(&source)
        .output()
        .unwrap();
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        output.status.success(),
        "isolated import producer failed: {}",
        reply["error"]
    );
    assert_eq!(reply["ok"], true);
    let result = &reply["result"];
    assert_eq!(result["staged"]["record"]["kind"], "mcp-server");
    assert_eq!(result["staged"]["record"]["trust"], "imported");
    assert_eq!(result["staged"]["record"]["capabilitiesAck"], Value::Null);
    assert_eq!(result["inspection"]["sourcePath"], Value::Null);
    assert_eq!(result["inspection"]["manifest"]["remote"]["auth"], "header");
    assert_eq!(result["inspection"]["manifest"]["scripts"], json!([]));
    assert!(
        !home.join("mcp").exists(),
        "preparation cannot activate or expose package code"
    );
    assert!(!home.join("extensions/state.json").exists());
}
