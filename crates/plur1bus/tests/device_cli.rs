use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

#[test]
fn device_json_fails_cleanly_offline_and_help_lists_commands() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["list"],
        vec!["revoke", "dev_test"],
        vec!["rename", "dev_test", "Phone"],
    ] {
        let result = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path().join("home"))
            .args(["device", "--json"])
            .args(args)
            .assert()
            .failure();
        let value: Value = serde_json::from_slice(&result.get_output().stdout).unwrap();
        assert_eq!(value["schema"], "error/1");
        assert_eq!(value["error"], "E_CORE_UNAVAILABLE");
    }
    let result = Command::cargo_bin("plur1bus")
        .unwrap()
        .args(["device", "--help"])
        .assert()
        .success();
    let text = String::from_utf8_lossy(&result.get_output().stdout);
    for leaf in ["list", "revoke", "rename"] {
        assert!(text.contains(leaf));
    }
}

#[cfg(unix)]
#[test]
fn device_json_roundtrips_over_synthetic_local_ipc() {
    use serde_json::json;
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
            assert_eq!(auth["method"], "core.auth");
            writeln!(writer, "{}", json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
            let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(writer, "{}", json!({"jsonrpc":"2.0","id":request["id"],"result":{"devices":[],"id":"dev_fixture","future":{"retained":true}}})).unwrap();
            requests.push(request);
        }
        requests
    });
    for (args, schema) in [
        (vec!["list"], "device.list/1"),
        (vec!["revoke", "dev_fixture"], "device.revoke/1"),
        (vec!["rename", "dev_fixture", "Phone"], "device.rename/1"),
    ] {
        let output = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .args(["--json", "device"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["schema"], schema);
        assert_eq!(value["future"]["retained"], true);
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["method"], "device.list");
    assert_eq!(requests[0]["params"], json!({}));
    assert_eq!(requests[1]["params"], json!({"id":"dev_fixture"}));
    assert_eq!(
        requests[2]["params"],
        json!({"id":"dev_fixture","name":"Phone"})
    );
}
