//! Agent create/validate/import CLI mapping: local IPC only, no real credentials.
use assert_cmd::prelude::*;
use serde_json::{json, Value};
use std::process::Command;

#[test]
fn payload_errors_do_not_echo_file_contents() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("payload.json");
    std::fs::write(&file, "not-json-private-content").unwrap();
    for args in [
        vec!["validate", file.to_str().unwrap()],
        vec!["import", file.to_str().unwrap()],
        vec!["create", "alpha", "--config", file.to_str().unwrap()],
    ] {
        let output = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .arg("--json")
            .arg("agent")
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(doc["schema"], "error/1");
        assert_eq!(doc["error"], "E_INVALID_PARAMS");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private-content"));
    }
}

#[cfg(unix)]
#[test]
fn new_commands_pass_all_parameters_and_preserve_raw_json_results() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("core.token"), "offline-fixture").unwrap();
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..3 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream).lines();
            let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(writer, "{}", json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
            let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(writer, "{}", json!({"jsonrpc":"2.0","id":request["id"],"result":{"agentId":"alpha","valid":true,"errors":[],"discardedRights":[],"future":{"retained":true}}})).unwrap();
            requests.push(request);
        }
        requests
    });
    let settings = dir.path().join("settings.json");
    let payload = dir.path().join("payload.json");
    let export = dir.path().join("export.json");
    let config = json!({"persona":"Plain persona.","model":"local","memory":{"mediaEmbedding":{"enabled":false}},"rights":{"person-one":"use"},"channels":["telegram"]});
    std::fs::write(&settings, config.to_string()).unwrap();
    let mut create = config;
    create["name"] = json!("alpha");
    std::fs::write(&payload, create.to_string()).unwrap();
    let bundle = json!({"format":"plur1bus.agent-export/1"});
    std::fs::write(
        &export,
        json!({"schema":"agent.export/1","bundle":bundle}).to_string(),
    )
    .unwrap();
    for (args, schema) in [
        (
            vec!["create", "alpha", "--config", settings.to_str().unwrap()],
            "agent.create/1",
        ),
        (
            vec!["validate", payload.to_str().unwrap()],
            "agent.validate/1",
        ),
        (
            vec![
                "import",
                export.to_str().unwrap(),
                "--on-conflict",
                "rename",
            ],
            "agent.import/1",
        ),
    ] {
        let output = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .arg("--json")
            .arg("agent")
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(doc["schema"], schema);
        assert_eq!(doc["future"]["retained"], true);
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["method"], "agent.create");
    assert_eq!(requests[0]["params"], create);
    assert_eq!(requests[1]["method"], "agent.validate");
    assert_eq!(requests[1]["params"], create);
    assert_eq!(requests[2]["method"], "agent.import");
    assert_eq!(
        requests[2]["params"],
        json!({"bundle":bundle,"onConflict":"rename"})
    );
}

#[test]
fn live_supervisor_cli_roundtrip_preserves_signed_manifest_and_rights() {
    use std::path::PathBuf;
    struct StopOnDrop(PathBuf);
    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            let _ = Command::cargo_bin("plur1bus")
                .unwrap()
                .arg("--home")
                .arg(&self.0)
                .args(["daemon", "stop"])
                .output();
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = tempfile::tempdir().unwrap();
    let mut config: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("packages/config-schema/fixtures/defaults.json"))
            .unwrap(),
    )
    .unwrap();
    config["engine"] = json!({"neo":{"enabled":false},"gc":{"enabled":false},"obsidianBridge":{"enabled":false},"merging":{"enabled":false},"dreaming":{"enabled":false},"skillMiner":{"enabled":false},"temporalContext":{"enabled":false},"conversationReactivationRecall":{"enabled":false},"reranker":{"enabled":false}});
    config["modelProfiles"]["local"] = json!({"strategy":"fallback","candidates":[{"model":"local/offline","weight":1}],"params":{},"cache":{"hint":"none"}});
    std::fs::write(dir.path().join("config.json"), config.to_string()).unwrap();
    let envs = [
        (
            "PLUR1BUS_CORE_JS",
            root.join("packages/core/dist/core.js")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "PLUR1BUS_NODE",
            std::env::var("PLUR1BUS_NODE").unwrap_or_else(|_| "node".into()),
        ),
        ("PLUR1BUS_ALLOW_TEST_INTERNALS", "1".into()),
        ("PLUR1BUS_TEST_INTERNALS", "flat-embedder".into()),
        ("PLUR1BUS_SECRETS_KEYRING", "memory".into()),
    ];
    let call = |args: &[&str]| -> Value {
        let output = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .arg("--json")
            .args(args)
            .envs(envs.iter().map(|(k, v)| (*k, v)))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    };
    let _stop = StopOnDrop(dir.path().to_path_buf());
    call(&["daemon", "start"]);
    let settings = dir.path().join("settings.json");
    let payload = dir.path().join("payload.json");
    let transfer = dir.path().join("export.json");
    let value = json!({"persona":"Literal {{name}} persona.","model":"local","memory":{"mediaEmbedding":{"enabled":false}},"channels":["signal"],"rights":{}});
    std::fs::write(&settings, value.to_string()).unwrap();
    let mut validate = value;
    validate["name"] = json!("cli-agent");
    std::fs::write(&payload, validate.to_string()).unwrap();
    assert_eq!(
        call(&["agent", "validate", payload.to_str().unwrap()])["valid"],
        true
    );
    assert_eq!(
        call(&[
            "agent",
            "create",
            "cli-agent",
            "--config",
            settings.to_str().unwrap()
        ])["agentId"],
        "cli-agent"
    );
    let rights = call(&["agent", "rights", "get", "cli-agent"]);
    assert!(rights["rights"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["userId"] == "local-owner" && r["right"] == "manage"));
    let export = call(&["agent", "export", "cli-agent"]);
    assert_eq!(export["bundle"]["algorithm"], "Ed25519");
    std::fs::write(&transfer, export.to_string()).unwrap();
    let imported = call(&[
        "agent",
        "import",
        transfer.to_str().unwrap(),
        "--on-conflict",
        "rename",
    ]);
    assert_eq!(imported["agentId"], "cli-agent-2");
    assert_eq!(imported["discardedRights"], json!([]));
    let persisted: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["agents"]["cli-agent-2"]["model"], "local");
    assert!(persisted["agents"]["cli-agent-2"].get("rights").is_none());
}
