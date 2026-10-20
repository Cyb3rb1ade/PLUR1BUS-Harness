//! `plur1bus audit verify` CLI tests (B5). The verifier itself is covered by `packages/core/test/audit/`; here only
//! what the CLI does on its own.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn audit_help_shows_experimental_on_each_leaf() {
    let out = bin().args(["audit", "--help"]).assert().success();
    assert!(String::from_utf8(out.get_output().stdout.clone())
        .unwrap()
        .contains("[experimental]"));
    let out = bin().args(["audit", "verify", "--help"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("[experimental]"));
}

#[test]
fn audit_verify_without_a_core_is_a_clean_error_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let out = bin()
        .arg("--home")
        .arg(&home)
        .args(["--json", "audit", "verify"])
        .assert()
        .failure();
    let doc: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(doc["schema"], "error/1");
    assert!(
        !home.join("logs").exists(),
        "the CLI never writes audit files"
    );
}

#[test]
fn audit_pin_is_parsed_before_any_connection_and_rejects_bad_external_values() {
    for pin in [
        "bad",
        "0:0123",
        "1:short",
        "9007199254740992:0000000000000000000000000000000000000000000000000000000000000000",
    ] {
        let out = bin()
            .args(["audit", "verify", "--pin", pin])
            .assert()
            .failure();
        let stderr = String::from_utf8_lossy(&out.get_output().stderr);
        assert!(
            stderr.contains("expected positive safe sequence and 64 lowercase hexadecimal hash"),
            "{stderr}"
        );
    }
}

#[cfg(unix)]
#[test]
fn audit_pin_reaches_the_core_and_json_retains_unknown_rpc_fields() {
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("core.token"), "offline-fixture").unwrap();
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut lines = BufReader::new(stream).lines();
        let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        writeln!(writer,"{}",json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
        let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        writeln!(writer,"{}",json!({"jsonrpc":"2.0","id":request["id"],"result":{"ok":true,"future":{"retained":true},"records":1,"files":1,"lastSeq":1,"lastHash":"a".repeat(64),"anchor":{"status":"match","seq":1},"findings":[],"findingsTotal":0}})).unwrap();
        request
    });
    let pin = format!("1:{}", "a".repeat(64));
    let out = bin()
        .arg("--home")
        .arg(dir.path())
        .args(["--json", "audit", "verify", "--pin", &pin])
        .assert()
        .success();
    let result: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(result["future"]["retained"], true);
    let request = server.join().unwrap();
    assert_eq!(request["method"], "audit.verify");
    assert_eq!(
        request["params"],
        json!({"pin":{"seq":1,"hash":"a".repeat(64)}})
    );
}
