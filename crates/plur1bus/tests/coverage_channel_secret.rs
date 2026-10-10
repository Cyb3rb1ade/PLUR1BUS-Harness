//! `plur1bus channel set` for a `*Secret` key: a secret NAME is forwarded to the core as the raw text, and a VALUE typed for
//! that key should never leave the command. Offline: a synthetic core answers over a local Unix socket, so no channel runs and
//! no network is used. The typed value is a plain marker built at run time, not a credential format.
#![cfg(unix)]

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

/// Serves one core session: answers `core.auth`, then the single request with a `channel.set` result. Returns that request,
/// or `Null` when no session arrived (the test then unblocks the accept itself, see `set_and_collect`).
fn fake_core(run: &Path) -> std::thread::JoinHandle<Value> {
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    std::thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return Value::Null;
        };
        // The wake-up connect of `set_and_collect` can already be closed: then the timeout cannot be set (EINVAL on macOS),
        // and the read below simply sees end-of-file, which returns `Null`.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut w = stream.try_clone().unwrap();
        let mut lines = BufReader::new(stream).lines();
        let Some(Ok(line)) = lines.next() else {
            return Value::Null;
        };
        let auth: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(auth["method"], "core.auth");
        writeln!(w,"{}",json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
        let Some(Ok(line)) = lines.next() else {
            return Value::Null;
        };
        let request: Value = serde_json::from_str(&line).unwrap();
        writeln!(
            w,
            "{}",
            json!({"jsonrpc":"2.0","id":request["id"],"result":{"id":"slack","key":"botTokenSecret","changed":true,"restart":{"live":[],"core":false,"modules":[]},"secret":{"name":"channels.slack.bot","present":true}}})
        )
        .unwrap();
        request
    })
}

/// Runs `channel set slack <key> <value>` against the fake core and returns the request it received.
fn set_and_collect(key: &str, value: &str) -> (Output, Value) {
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("core.token"), "offline-fixture").unwrap();
    let server = fake_core(&run);
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .arg("--home")
        .arg(dir.path())
        .arg("--json")
        .args(["channel", "set", "slack", key, value])
        .env_remove("PLUR1BUS_CONTAINER")
        .output()
        .unwrap();
    // Wake the accept if the CLI never connected, so the server thread ends and the join cannot hang.
    let _ = UnixStream::connect(run.join("core.sock"));
    (out, server.join().unwrap())
}

#[test]
fn a_secret_name_is_forwarded_as_the_text_of_the_set() {
    let (out, request) = set_and_collect("botTokenSecret", "channels.slack.bot");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(request["method"], "channel.set");
    assert_eq!(request["params"]["id"], "slack");
    assert_eq!(request["params"]["key"], "botTokenSecret");
    assert_eq!(request["params"]["text"], "channels.slack.bot");
}

#[test]
fn a_value_typed_for_a_secret_key_never_reaches_the_core() {
    // A space is not in a secret name, so this marker is a value by the name rule (a plain `-` would be a valid name).
    let typed = ["FIXTURE", "NOT", "A", "SECRET"].join(" ");
    let (out, request) = set_and_collect("botTokenSecret", &typed);
    assert!(
        !request.to_string().contains(&typed),
        "the typed value was sent to the core: {request}"
    );
    assert!(request.is_null(), "the core was called: {request}");
    assert_eq!(
        out.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let shown = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !shown.contains(&typed),
        "the typed value was echoed: {shown}"
    );
    assert!(shown.contains("plur1bus secret set <name>"), "{shown}");
}

#[test]
fn a_credential_typed_for_a_secret_key_never_reaches_the_core_or_the_output() {
    // A token is a valid name by format; the credential shape is what refuses it here.
    let typed = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    let (out, request) = set_and_collect("botTokenSecret", &typed);
    assert!(request.is_null(), "the core was called: {request}");
    assert_eq!(out.status.code(), Some(2));
    let shown = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!shown.contains(&typed), "{shown}");
    assert!(
        shown.contains("treat the value you just typed as exposed"),
        "{shown}"
    );
}
