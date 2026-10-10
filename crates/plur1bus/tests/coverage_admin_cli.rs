//! Admin leaves (`agent`, `user`, `breakglass`, `pairing`): the argument rules decided by clap before any core call,
//! the `Examples:` block every leaf's help carries, and the request each leaf forwards to a synthetic core over a local
//! Unix socket. Offline and hermetic: no TCP, no credentials, no sleeps; the fake core answers one request per connection.
#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

const LEAVES: &[&[&str]] = &[
    &["agent", "pause"],
    &["agent", "resume"],
    &["agent", "archive"],
    &["agent", "unarchive"],
    &["agent", "export"],
    &["agent", "delete"],
    &["agent", "rights", "get"],
    &["agent", "rights", "set"],
    &["user", "list"],
    &["user", "role"],
    &["user", "invite", "create"],
    &["user", "invite", "list"],
    &["user", "invite", "revoke"],
    &["breakglass", "request"],
    &["breakglass", "list"],
    &["breakglass", "revoke"],
    &["breakglass", "notices"],
    &["pairing", "qr"],
];

fn plur1bus(home: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_plur1bus"));
    c.arg("--home")
        .arg(home)
        .arg("--json")
        .args(args)
        .env_remove("PLUR1BUS_CONTAINER");
    c
}

fn doc(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "not JSON ({e}): {:?} stderr: {:?}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

/// Serves `connections` core sessions: answers `core.auth`, then the one request on the same socket with `{"ok":true}`.
/// Returns the requests received, in order.
fn fake_core(run: &Path, connections: usize) -> std::thread::JoinHandle<Vec<Value>> {
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..connections {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut w = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream).lines();
            let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            assert_eq!(auth["method"], "core.auth");
            writeln!(w,"{}",json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
            let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(
                w,
                "{}",
                json!({"jsonrpc":"2.0","id":request["id"],"result":{"ok":true}})
            )
            .unwrap();
            requests.push(request);
        }
        requests
    })
}

#[test]
fn every_leaf_help_shows_an_example_of_its_own_path() {
    for leaf in LEAVES {
        let out = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
            .args(*leaf)
            .arg("--help")
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(out.status.success(), "{leaf:?}: {text}");
        assert!(text.contains("Examples:"), "{leaf:?}: {text}");
        let path = leaf.join(" ");
        assert!(
            text.contains(&format!("plur1bus {path}")),
            "{leaf:?}: {text}"
        );
    }
}

#[test]
fn missing_arguments_and_out_of_set_values_are_usage_errors() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        // delete needs both the typed name and the offer it answers
        vec!["agent", "delete", "alpha"],
        vec!["agent", "delete", "alpha", "--confirm-name", "Alpha"],
        vec![
            "agent",
            "delete",
            "alpha",
            "--export-offer",
            "offer-fixture",
        ],
        vec!["agent", "rights", "set", "alpha", "person-fixture", "write"],
        vec!["agent", "rights", "set", "alpha", "person-fixture"],
        vec!["user", "role", "person-fixture", "arbitrary"],
        vec!["user", "invite", "create", "Alex", "--role", "member"],
        // owner is a role preset for `user role`, not an invitation preset
        vec![
            "user",
            "invite",
            "create",
            "Alex",
            "--role",
            "owner",
            "--channel",
            "test",
        ],
        vec!["user", "invite", "revoke"],
        vec!["breakglass", "request", "person-fixture"],
        vec![
            "breakglass",
            "request",
            "person-fixture",
            "--reason",
            "Investigate incident",
            "--minutes",
            "0",
        ],
        vec![
            "breakglass",
            "request",
            "person-fixture",
            "--reason",
            "Investigate incident",
            "--minutes",
            "61",
        ],
        vec![
            "user",
            "invite",
            "create",
            "Alex",
            "--role",
            "member",
            "--channel",
            "test",
            "--minutes",
            "61",
        ],
        vec!["pairing", "qr"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
            .arg("--home")
            .arg(dir.path())
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
    }
}

#[test]
fn range_edges_parse_and_then_fail_only_because_no_core_runs() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec![
            "user",
            "invite",
            "create",
            "Alex",
            "--role",
            "member",
            "--channel",
            "test",
            "--minutes",
            "1",
        ],
        vec![
            "user",
            "invite",
            "create",
            "Alex",
            "--role",
            "member",
            "--channel",
            "test",
            "--minutes",
            "60",
        ],
        vec![
            "breakglass",
            "request",
            "person-fixture",
            "--reason",
            "Investigate incident",
            "--minutes",
            "1",
        ],
        vec![
            "breakglass",
            "request",
            "person-fixture",
            "--reason",
            "Investigate incident",
            "--minutes",
            "60",
        ],
    ] {
        let out = plur1bus(dir.path(), &args).output().unwrap();
        assert!(!out.status.success(), "{args:?}");
        assert_eq!(doc(&out)["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[test]
fn json_after_the_leaf_still_gives_the_json_error_document() {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .arg("--home")
        .arg(dir.path())
        .args(["agent", "pause", "alpha", "--json"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let d = doc(&out);
    assert_eq!(d["schema"], "error/1");
    assert_eq!(d["error"], "E_CORE_UNAVAILABLE");
}

#[test]
fn each_leaf_forwards_its_arguments_verbatim_and_the_defaults_it_owns() {
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("core.token"), "offline-fixture").unwrap();
    let cases: &[(&[&str], &str)] = &[
        (
            &[
                "agent",
                "delete",
                "alpha",
                "--confirm-name",
                "Alpha Typed",
                "--export-offer",
                "offer-fixture",
            ],
            "agent.delete",
        ),
        (
            &["agent", "rights", "set", "alpha", "person-fixture", "none"],
            "agent.rights.set",
        ),
        (&["agent", "export", "alpha"], "agent.export"),
        (
            &[
                "user",
                "invite",
                "create",
                "Alex",
                "--role",
                "operator",
                "--channel",
                "test",
            ],
            "user.invite.create",
        ),
        (
            &[
                "breakglass",
                "request",
                "person-fixture",
                "--reason",
                "Investigate incident",
            ],
            "breakglass.request",
        ),
        (
            &["user", "role", "person-fixture", "owner"],
            "user.role.set",
        ),
    ];
    let server = fake_core(&run, cases.len());
    for (args, _) in cases {
        let out = plur1bus(dir.path(), args).output().unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let requests = server.join().unwrap();
    for (req, (_, method)) in requests.iter().zip(cases) {
        assert_eq!(req["method"], *method);
        assert!(req["params"].get("caller").is_none(), "{req}");
    }
    let p = |i: usize| &requests[i]["params"];
    assert_eq!(p(0)["agentId"], "alpha");
    assert_eq!(p(0)["confirmName"], "Alpha Typed");
    assert_eq!(p(0)["exportOfferId"], "offer-fixture");
    assert_eq!(p(1)["userId"], "person-fixture");
    assert_eq!(p(1)["right"], Value::Null);
    assert_eq!(p(2)["offerOnly"], false);
    assert_eq!(p(3)["displayName"], "Alex");
    assert_eq!(p(3)["role"], "operator");
    assert_eq!(p(3)["channel"], "test");
    assert_eq!(p(3)["expiresInMinutes"], 60);
    assert_eq!(p(4)["targetUserId"], "person-fixture");
    assert_eq!(p(4)["windowMinutes"], 15);
    assert_eq!(p(5)["role"], "owner");
}
