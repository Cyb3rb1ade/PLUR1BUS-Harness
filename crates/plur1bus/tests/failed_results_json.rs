//! A command that reports a failure in its result (`audit verify`, `model scan`) exits 1 and, with `--json`, prints ONE
//! document: the unchanged result plus the `error/1` document of the failure as its top-level `error`. A success has no
//! `error`. Unix only (the fake core listens on `run/core.sock`).
#![cfg(unix)]
use assert_cmd::Command;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;

/// A fake core that answers `core.auth` (announcing every scripted method) and then each scripted method.
fn spawn(home: &Path, script: Vec<(&str, Value)>) {
    let run = home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    let token = "d".repeat(64);
    std::fs::write(run.join("core.token"), &token).unwrap();
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    let script: HashMap<String, Value> = script
        .into_iter()
        .map(|(m, v)| (m.to_string(), v))
        .collect();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let mut w = stream.try_clone().unwrap();
            let r = BufReader::new(stream);
            let (script, token) = (script.clone(), token.clone());
            std::thread::spawn(move || {
                let mut authed = false;
                for line in r.lines() {
                    let Ok(line) = line else { return };
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let id = msg["id"].clone();
                    let method = msg["method"].as_str().unwrap_or("").to_string();
                    let reply = if method == "core.auth" {
                        authed = msg["params"]["token"] == token;
                        let methods: serde_json::Map<String, Value> = script
                            .keys()
                            .map(|m| {
                                (
                                    m.clone(),
                                    json!({"stability":"experimental","since":"1.5.0"}),
                                )
                            })
                            .collect();
                        json!({"jsonrpc":"2.0","id":id,"result":{"contract":"1.12.0","rpc":"1.5.0","instanceId":"i","pid":1,
                            "capabilities":{"methods":methods,"notifications":{},"extensionPoints":{},"features":[]}}})
                    } else if !authed {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"auth","data":{"error":"E_UNAUTHORIZED","reason":"auth-required"}}})
                    } else {
                        match script.get(&method) {
                            Some(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
                            None => {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"nope","data":{"error":"E_INTERNAL","reason":"method-not-found"}}})
                            }
                        }
                    };
                    w.write_all(format!("{reply}\n").as_bytes()).unwrap();
                    w.flush().unwrap();
                }
            });
        }
    });
}

fn run(home: &Path, args: &[&str]) -> (Option<i32>, String) {
    let o = Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(home)
        .args(args)
        .output()
        .unwrap();
    (
        o.status.code(),
        String::from_utf8_lossy(&o.stdout).into_owned(),
    )
}

#[test]
fn a_failed_audit_verify_is_one_document_with_an_error_object_and_exit_1() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "audit.verify",
            json!({"ok": false, "findingsTotal": 1, "findings": [{"code": "chain-broken", "file": "audit.log"}]}),
        )],
    );
    let (code, stdout) = run(d.path(), &["--json", "audit", "verify"]);
    assert_eq!(code, Some(1));
    let v: Value = serde_json::from_str(&stdout).expect("stdout is exactly one JSON document");
    assert_eq!(v["schema"], "audit.verify/1");
    assert_eq!(v["ok"], false);
    assert_eq!(
        v["findings"][0]["code"], "chain-broken",
        "the result is kept"
    );
    assert_eq!(v["error"]["schema"], "error/1");
    assert_eq!(v["error"]["error"], "E_STORAGE");
    assert_eq!(v["error"]["reason"], "audit-verify-failed");
    // Without --json nothing changes: the result on stdout, exit 1.
    let (code, stdout) = run(d.path(), &["audit", "verify"]);
    assert_eq!(code, Some(1));
    assert!(stdout.contains("chain-broken"), "{stdout}");
}

#[test]
fn an_intact_audit_verify_has_no_error_object() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "audit.verify",
            json!({"ok": true, "findingsTotal": 0, "findings": []}),
        )],
    );
    let (code, stdout) = run(d.path(), &["--json", "audit", "verify"]);
    assert_eq!(code, Some(0));
    let v: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["schema"], "audit.verify/1");
    assert!(v.get("error").is_none(), "{v}");
}

#[test]
fn a_failed_model_scan_is_one_document_with_an_error_object_and_exit_1() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "models.scan",
            json!({"providers": [{"provider": "p1", "result": "failed: timeout"}, {"provider": "p2", "result": "ok"}]}),
        )],
    );
    let (code, stdout) = run(d.path(), &["--json", "model", "scan"]);
    assert_eq!(code, Some(1));
    let v: Value = serde_json::from_str(&stdout).expect("stdout is exactly one JSON document");
    assert_eq!(v["schema"], "model.scan/1");
    assert_eq!(v["providers"][1]["result"], "ok", "the result is kept");
    assert_eq!(v["error"]["schema"], "error/1");
    assert_eq!(v["error"]["error"], "E_INTERNAL");
    assert_eq!(v["error"]["reason"], "scan-failed");

    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "models.scan",
            json!({"providers": [{"provider": "p2", "result": "ok"}]}),
        )],
    );
    let (code, stdout) = run(d.path(), &["--json", "model", "scan"]);
    assert_eq!(code, Some(0));
    let v: Value = serde_json::from_str(&stdout).unwrap();
    assert!(v.get("error").is_none(), "{v}");
}

/// A damaged output of `media save` is a runtime failure (`E_STORAGE`, exit 1), not a usage error (`E_INVALID_PARAMS`, exit
/// 2), and no half-written file is left under the destination name.
#[test]
fn a_damaged_media_output_is_a_storage_failure_with_exit_1() {
    for (what, reply) in [
        (
            "invalid output range",
            json!({"data": "AAAA", "nextOffset": 0, "totalBytes": 3}),
        ),
        (
            "incomplete output",
            json!({"data": "AAAA", "totalBytes": 99, "manifest": {"files": [{"sha256": ""}]}}),
        ),
    ] {
        let d = tempfile::tempdir().unwrap();
        spawn(d.path(), vec![("media.output.get", reply)]);
        let dest = d.path().join("out.bin");
        let (code, stdout) = run(
            d.path(),
            &[
                "--json",
                "media",
                "output",
                "m1",
                "--out",
                dest.to_str().unwrap(),
            ],
        );
        assert_eq!(code, Some(1), "{what}: {stdout}");
        let v: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(v["schema"], "error/1", "{what}: {v}");
        assert_eq!(v["error"], "E_STORAGE", "{what}: {v}");
        assert_eq!(v["message"], what, "{v}");
        assert!(
            !dest.exists(),
            "{what}: nothing is published under the destination"
        );
    }
}
