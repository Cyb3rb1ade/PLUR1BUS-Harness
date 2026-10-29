//! B8: a signed fixture crosses the real HTTP upload, delegated supervisor, worker and activation boundaries.
mod common;

use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, test_key};
use serde_json::json;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[test]
fn signed_mcp_crosses_the_real_api_upload_inspect_confirm_install_enable_stack() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    std::fs::create_dir(&home).unwrap();
    let mut config = serde_json::to_value(plur1bus_config::defaults()).unwrap();
    config["agents"]["main"] = json!({});
    config["engine"] =
        json!({"neo":{"enabled":false},"reranker":{"enabled":false},"dreaming":{"enabled":false}});
    std::fs::write(
        home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let key = test_key("web-stack");
    let template = json!({
        "$schema":"https://plur1bus.app/schema/p1x/1/p1x.schema.json","format":1,
        "id":"test/web-mcp","name":"web-mcp","version":"1.0.0","kind":"mcp-server",
        "title":{"en":"Web fixture"},"summary":{"en":"Actual stack fixture"},
        "publisher":{"id":"test","name":"Test"},"licence":"MIT",
        "compat":{"harness":">=0.0.0"},"requires":{"runtime":{"type":"none"}},
        "remote":{"url":"https://fixture.invalid/mcp","auth":"none"},
        "capabilities":{"network":{"mode":"allowlist","hosts":["fixture.invalid"]},
            "filesystem":[],"processes":{"spawn":false},"harness":{"authority":"none"}}
    });
    let bytes = build_package_from(
        &template,
        vec![PayloadFile {
            rel: "README.md".into(),
            bytes: b"Fixture\n".to_vec(),
            exec: false,
        }],
        Some(&key),
    );
    let package = dir.path().join("fixture.p1x");
    std::fs::write(&package, bytes).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let core = root.join("packages/core/dist/core.js");
    let keys = format!("{}={}", key.label, key.public_b64);
    let _supervisor = common::start_with_core(
        &home,
        &dir.path().join("events.jsonl"),
        "0.2",
        &[
            ("PLUR1BUS_CORE_JS", core.to_str().unwrap()),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
            ("PLUR1BUS_TEST_EXT_PUBKEYS", &keys),
        ],
    );
    let mut supervisor = common::client(&home);
    common::wait_child(
        &mut supervisor,
        "Core ready",
        Duration::from_secs(30),
        |child| child["process"]["state"] == "ready",
    );
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
        ])
        .arg(root.join("packages/api/test/fixtures/extensions-native-stack.mjs"))
        .arg(&home)
        .arg(package)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "actual HTTP stack failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"upload":true,"inspect":true,"confirmation":true,"install":true,"enabled":true})
    );
    supervisor
        .call("daemon.stop", json!({"budgetMs":5000}))
        .unwrap();
}
