//! Native configuration/reference disclosure, value-free guidance and real Supervisor log integration.
mod common;
use common::{client, start, start_with_core};
use serde_json::json;
use std::fs;

#[test]
fn safe_names_are_readable_in_native_config_and_real_supervisor_logs() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path();
    let name = format!(
        "service.{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let literal = uuid::Uuid::new_v4().to_string();
    let mut config = plur1bus_config::defaults();
    config["voice"]["providers"]["elevenlabs"]["apiKeyRef"] = json!(name);
    config["engine"]["embedding"]["apiKey"] = json!(literal);
    fs::write(home.join("config.json"), config.to_string()).unwrap();
    let _supervisor = start_with_core(
        home,
        &home.join("events.jsonl"),
        "0.2",
        &[("PLUR1BUS_SERVICE_MANAGER", &name)],
    );
    let mut connection = client(home);
    let whole = connection.call("config.get", json!({})).unwrap();
    assert_eq!(
        whole["value"]["voice"]["providers"]["elevenlabs"]["apiKeyRef"],
        name
    );
    assert_eq!(whole["value"]["engine"]["embedding"]["apiKey"], "••••");
    let narrow = connection
        .call(
            "config.get",
            json!({"key":"voice.providers.elevenlabs.apiKeyRef"}),
        )
        .unwrap();
    assert_eq!(narrow["value"], name);
    let records = fs::read_to_string(home.join("logs/supervisor.log")).unwrap();
    assert!(
        records.contains(&name),
        "real metadata log lost a safe reference name"
    );
    assert!(!records.contains(&literal));
}

#[test]
fn pasted_reference_values_are_masked_and_warned_without_changing_private_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path();
    let pasted = format!("sk-{}", uuid::Uuid::new_v4().simple());
    let mut config = plur1bus_config::defaults();
    config["voice"]["providers"]["elevenlabs"]["apiKeyRef"] = json!(pasted);
    fs::write(home.join("config.json"), config.to_string()).unwrap();
    let _supervisor = start(home);
    let output = assert_cmd::Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(home)
        .args([
            "--json",
            "config",
            "get",
            "voice.providers.elevenlabs.apiKeyRef",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["schema"], "config.get/1");
    assert_eq!(result["value"], "••••");
    let notice = String::from_utf8(output.stderr).unwrap();
    assert!(notice.contains("Reference looks like a pasted key"));
    assert!(notice.contains("voice.providers.elevenlabs.apiKeyRef"));
    assert!(!notice.contains(&pasted));
    let log = fs::read_to_string(home.join("logs/supervisor.log")).unwrap();
    assert!(log.contains("Reference looks like a pasted key"));
    assert!(!log.contains(&pasted));
    let private: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("config.json")).unwrap()).unwrap();
    assert_eq!(
        private["voice"]["providers"]["elevenlabs"]["apiKeyRef"],
        pasted
    );
}

#[test]
fn disabled_childless_module_manifest_repair_refreshes_log_policy_without_a_config_edit() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path();
    let module_dir = home.join("modules/fixture");
    fs::create_dir_all(&module_dir).unwrap();
    let mut config = plur1bus_config::defaults();
    let secret = format!("runtime-{}", uuid::Uuid::new_v4());
    config["modules"]["fixture"] =
        json!({"enabled":false,"reference":"bad name","literal":secret,"label":"public label"});
    let original = config.to_string();
    fs::write(home.join("config.json"), &original).unwrap();
    let manifest_path = module_dir.join("module.json");
    fs::write(&manifest_path, "invalid manifest").unwrap();
    let _supervisor = start(home);
    let mut connection = client(home);
    let held = connection.call("config.get", json!({}));
    assert!(
        held.is_err(),
        "damaged installed policy must never expose an unclassified public view"
    );
    let before = fs::read_to_string(home.join("logs/supervisor.log")).unwrap();
    assert!(
        before.contains("supervisor started"),
        "metadata damage must keep normal log output available"
    );
    assert!(!before.contains("configuration sensitivity metadata is unavailable"));
    assert!(!before.contains(&secret));
    fs::write(&manifest_path,json!({"name":"fixture","version":"0.1.0","apiVersion":"1","entry":"index.js",
        "scope":"installation","priority":500,"configSchema":{"type":"object","properties":{
            "reference":{"type":"string","x-secret-reference":true},"literal":{"type":"string","x-sensitive":true},"label":{"type":"string"}
        }}}).to_string()).unwrap();
    common::wait_until("manifest-only disclosure refresh", common::WAIT, || {
        fs::read_to_string(home.join("logs/supervisor.log"))
            .is_ok_and(|text| text.contains("modules.fixture.reference"))
    });
    let projected = connection.call("config.get", json!({})).unwrap();
    assert_eq!(
        projected["value"]["modules"]["fixture"]["label"],
        "public label"
    );
    assert_eq!(
        projected["value"]["modules"]["fixture"]["reference"],
        "••••"
    );
    assert_eq!(projected["value"]["modules"]["fixture"]["literal"], "••••");
    assert_eq!(
        fs::read_to_string(home.join("config.json")).unwrap(),
        original
    );
    let log = fs::read_to_string(home.join("logs/supervisor.log")).unwrap();
    assert!(!log.contains(&secret));
    assert!(!log.contains("bad name"));
}
