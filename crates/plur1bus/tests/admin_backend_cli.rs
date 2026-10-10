//! Offline CLI checks: synthetic RPC over local Unix IPC, never TCP or real credentials.
use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

#[test]
fn admin_commands_fail_as_json_without_a_core() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["agent", "pause", "alpha"],
        vec!["agent", "resume", "alpha"],
        vec!["agent", "archive", "alpha"],
        vec!["agent", "unarchive", "alpha"],
        vec!["agent", "export", "alpha", "--offer-only"],
        vec![
            "agent",
            "delete",
            "alpha",
            "--confirm-name",
            "Alpha",
            "--export-offer",
            "offer-fixture",
        ],
        vec!["agent", "rights", "get", "alpha"],
        vec!["agent", "rights", "set", "alpha", "person-fixture", "use"],
        vec!["user", "list"],
        vec!["user", "role", "person-fixture", "member"],
        vec![
            "user",
            "invite",
            "create",
            "Alex",
            "--role",
            "member",
            "--channel",
            "test",
        ],
        vec!["user", "invite", "list"],
        vec!["user", "invite", "revoke", "invite-fixture"],
        vec![
            "breakglass",
            "request",
            "person-fixture",
            "--reason",
            "Investigate incident",
        ],
        vec!["breakglass", "list"],
        vec!["breakglass", "revoke", "grant-fixture"],
        vec!["breakglass", "notices"],
        vec!["pairing", "qr", "--link", "plur1bus://pair?fixture"],
    ] {
        let output = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .arg("--json")
            .args(&args)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        let doc: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(doc["schema"], "error/1", "{args:?}");
        assert_eq!(doc["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[cfg(unix)]
#[test]
fn json_preserves_raw_rpc_fields_and_session_filters_reach_the_core() {
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
        for _ in 0..4 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut w = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream).lines();
            let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            assert_eq!(auth["method"], "core.auth");
            writeln!(w,"{}",json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
            let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(w,"{}",json!({"jsonrpc":"2.0","id":request["id"],"result":{"future":{"retained":true},"method":request["method"],"sessions":[],"truncated":false}})).unwrap();
            requests.push(request);
        }
        requests
    });
    for (args, schema) in [
        (vec!["agent", "pause", "alpha"], "agent.pause/1"),
        (vec!["user", "list"], "user.list/1"),
        (vec!["breakglass", "notices"], "breakglass.notices/1"),
        (
            vec![
                "session",
                "list",
                "--owner",
                "person-fixture",
                "--agent",
                "alpha",
                "--all-owners",
            ],
            "session.list/1",
        ),
    ] {
        let out = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .arg("--json")
            .args(&args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(doc["schema"], schema);
        assert_eq!(doc["future"]["retained"], true);
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[3]["params"]["owner"], "person-fixture");
    assert_eq!(requests[3]["params"]["agentId"], "alpha");
    assert_eq!(requests[3]["params"]["allOwners"], true);
    assert!(requests[0]["params"].get("caller").is_none());
}
