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
