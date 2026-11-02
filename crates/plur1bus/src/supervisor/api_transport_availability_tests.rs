//! Actual two-stage Core authentication: transport loss must not masquerade as a bad credential.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::{fs::PermissionsExt, net::UnixListener};

fn authenticate(second_reply: Option<Value>) -> Result<Value, &'static str> {
    let home = tempfile::tempdir().unwrap();
    let layout = Layout::new(home.path().into());
    std::fs::create_dir(layout.run()).unwrap();
    std::fs::set_permissions(layout.run(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let token = "a".repeat(64);
    std::fs::write(layout.core_token(), &token).unwrap();
    std::fs::set_permissions(layout.core_token(), std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(layout.core_pid(), std::process::id().to_string()).unwrap();
    let listener = UnixListener::bind(core_address(&layout.home, "posix")).unwrap();
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let mut peer = BufReader::new(socket);
        let mut line = String::new();
        peer.read_line(&mut line).unwrap();
        let first: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(first["method"], "core.auth");
        assert_eq!(first["params"]["token"], token);
        writeln!(peer.get_mut(), "{}", json!({"jsonrpc":"2.0","id":first["id"],
            "result":{"contract":"1.4.1","rpc":"1.12.0","instanceId":"fixture","pid":std::process::id()}})).unwrap();
        peer.get_mut().flush().unwrap();
        line.clear();
        if peer.read_line(&mut line).unwrap() == 0 {
            return;
        }
        let second: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(second["method"], "core.auth");
        assert_eq!(second["params"]["api"]["principal"]["userId"], "owner");
        if let Some(mut reply) = second_reply {
            reply["id"] = second["id"].clone();
            writeln!(peer.get_mut(), "{reply}").unwrap();
            peer.get_mut().flush().unwrap();
        }
    });
    let result = principal(
        &layout,
        &json!({"clientId":"harness-api","token":"b".repeat(64),
        "principal":{"kind":"person","userId":"owner","role":"owner"}}),
    );
    server.join().unwrap();
    result
}

#[test]
fn loss_between_authentication_stages_is_core_unavailable() {
    assert_eq!(authenticate(None), Err("core-unavailable"));
}

#[test]
fn explicit_shutdown_is_unavailable_but_authentication_and_unrelated_errors_still_refuse() {
    for (code, reason, expected) in [
        ("E_NOT_AVAILABLE", "stopping", "core-unavailable"),
        ("E_NOT_AVAILABLE", "models-loading", "api-delegation"),
        ("E_UNAUTHORIZED", "no-principal", "api-delegation"),
        ("E_UNAUTHORIZED", "api-delegation", "api-delegation"),
    ] {
        let reply = json!({"jsonrpc":"2.0","error":{"code":-32000,"message":"fixture refusal",
            "data":{"error":code,"reason":reason}}});
        assert_eq!(authenticate(Some(reply)), Err(expected), "{code}/{reason}");
    }
}
