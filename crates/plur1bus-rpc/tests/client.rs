#![cfg(unix)]
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::time::{Duration, Instant};

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn fake_core(rpc: &'static str) -> String {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let p = path.to_string_lossy().to_string();
    let listener = UnixListener::bind(&path).unwrap();
    std::mem::forget(dir);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = stream.unwrap();
            let mut w = stream.try_clone().unwrap();
            let r = BufReader::new(stream);
            let mut authed = false;
            std::thread::spawn(move || {
                for line in r.lines() {
                    let msg: Value = serde_json::from_str(&line.unwrap()).unwrap();
                    let id = msg["id"].clone();
                    let reply = |w: &mut dyn Write, v: Value| {
                        w.write_all(format!("{}\n", serde_json::to_string(&v).unwrap()).as_bytes())
                            .unwrap();
                    };
                    match msg["method"].as_str().unwrap() {
                        "core.auth" => {
                            authed = msg["params"]["token"] == TOKEN;
                            if authed {
                                reply(
                                    &mut w,
                                    json!({"jsonrpc":"2.0","id":id,"result":{"contract":"1.4.1","rpc":rpc,"instanceId":"i","pid":1}}),
                                )
                            } else {
                                reply(
                                    &mut w,
                                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"bad token","data":{"error":"E_UNAUTHORIZED","reason":"bad-token"}}}),
                                )
                            }
                        }
                        _ if !authed => reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"auth","data":{"error":"E_UNAUTHORIZED","reason":"auth-required"}}}),
                        ),
                        "echo" => {
                            reply(
                                &mut w,
                                json!({"jsonrpc":"2.0","method":"agent.activity","params":{}}),
                            );
                            reply(
                                &mut w,
                                json!({"jsonrpc":"2.0","id":id,"result":msg["params"]}),
                            )
                        }
                        "slow" => {
                            std::thread::sleep(Duration::from_millis(400));
                            reply(&mut w, json!({"jsonrpc":"2.0","id":id,"result":{}}))
                        }
                        _ => reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"nope","data":{"error":"E_INTERNAL","reason":"method-not-found"}}}),
                        ),
                    }
                }
            });
        }
    });
    p
}

#[test]
fn auth_call_and_notification_skipping() {
    let addr = fake_core("1.0.0");
    let mut c = Client::connect(&addr, TOKEN, ConnectOptions::default()).unwrap();
    assert_eq!(c.hello().contract, "1.4.1");
    assert_eq!(c.call("echo", json!({"x": 1})).unwrap(), json!({"x": 1}));
    match c.call("nope", json!({})) {
        Err(RpcError::Call { reason, .. }) => {
            assert_eq!(reason.as_deref(), Some("method-not-found"))
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn bad_token_and_version_mismatch() {
    let addr = fake_core("1.0.0");
    assert!(matches!(
        Client::connect(&addr, "d".repeat(64).as_str(), ConnectOptions::default()),
        Err(RpcError::Call { .. })
    ));
    let addr2 = fake_core("2.0.0");
    assert!(matches!(
        Client::connect(&addr2, TOKEN, ConnectOptions::default()),
        Err(RpcError::Version { .. })
    ));
}

#[test]
fn missing_socket_is_unavailable_fast_and_slow_call_times_out() {
    let t0 = Instant::now();
    let e = Client::connect(
        "/nonexistent/plur1bus/core.sock",
        TOKEN,
        ConnectOptions::default(),
    )
    .err()
    .unwrap();
    assert!(plur1bus_rpc::is_unavailable(&e), "{e}");
    assert!(t0.elapsed() < Duration::from_millis(300));
    let addr = fake_core("1.0.0");
    let mut c = Client::connect(
        &addr,
        TOKEN,
        ConnectOptions {
            call_timeout: Duration::from_millis(100),
            ..Default::default()
        },
    )
    .unwrap();
    let e = c.call("slow", json!({})).err().unwrap();
    assert!(
        matches!(&e, RpcError::Unavailable { reason, .. } if reason == "call-timeout"),
        "{e}"
    );
}
