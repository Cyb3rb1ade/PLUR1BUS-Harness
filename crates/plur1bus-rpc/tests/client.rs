#![cfg(unix)]
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::time::{Duration, Instant};

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const MAX_LINE: usize = 4 * 1024 * 1024;

fn socket_path() -> (String, UnixListener) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let listener = UnixListener::bind(&path).unwrap();
    std::mem::forget(dir);
    (path.to_string_lossy().to_string(), listener)
}

fn raw(w: &mut dyn Write, bytes: &[u8]) {
    w.write_all(bytes).unwrap();
    w.flush().unwrap();
}
fn reply(w: &mut dyn Write, v: Value) {
    raw(
        w,
        format!("{}\n", serde_json::to_string(&v).unwrap()).as_bytes(),
    );
}

/// A response line of exactly `len` bytes (newline not counted) answering request `id`.
fn line_of_len(id: &Value, len: usize) -> Vec<u8> {
    let prefix = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"s\":\"");
    let suffix = "\"}}";
    let mut line = prefix.clone().into_bytes();
    line.extend(std::iter::repeat_n(b'x', len - prefix.len() - suffix.len()));
    line.extend_from_slice(suffix.as_bytes());
    assert_eq!(line.len(), len);
    line.push(b'\n');
    line
}

/// A fake core answering `core.auth` with `hello` (for a good token) and a set of scripted methods.
fn fake_core_with(hello: Value) -> String {
    let (p, listener) = socket_path();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = stream.unwrap();
            let mut w = stream.try_clone().unwrap();
            let r = BufReader::new(stream);
            let hello = hello.clone();
            let mut authed = false;
            std::thread::spawn(move || {
                for line in r.lines() {
                    let Ok(line) = line else { return };
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let id = msg["id"].clone();
                    match msg["method"].as_str().unwrap() {
                        "core.auth" => {
                            authed = msg["params"]["token"] == TOKEN;
                            if authed {
                                reply(&mut w, json!({"jsonrpc":"2.0","id":id,"result":hello}))
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
                        "big" => {
                            let len = msg["params"]["len"].as_u64().unwrap() as usize;
                            raw(&mut w, &line_of_len(&id, len))
                        }
                        "unparseable" => reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"invalid request","data":{"error":"E_INVALID_PARAMS","reason":"parse"}}}),
                        ),
                        "forget-extra" => reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"id":"m-1","archived":true,"tombstoneId":"t-1","alreadyForgotten":false,"addedInAFutureMinor":{"x":1}}}),
                        ),
                        "hollow" => reply(&mut w, json!({"jsonrpc":"2.0","id":id})),
                        "storage" => reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"shared copy refresh failed","data":{"error":"E_STORAGE","reason":"storage","detail":"refresh","ids":{"sourceId":"m-src","sharedId":"m-copy"}}}}),
                        ),
                        "badutf8" => {
                            let mut line =
                                format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":\"")
                                    .into_bytes();
                            line.extend_from_slice(&[0xff, 0xfe]); // not UTF-8
                            line.extend_from_slice(b"\"}\n");
                            raw(&mut w, &line)
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

fn fake_core(rpc: &str) -> String {
    fake_core_with(json!({"contract":"1.4.1","rpc":rpc,"instanceId":"i","pid":1}))
}

fn connect(addr: &str) -> Client {
    Client::connect(addr, TOKEN, ConnectOptions::default()).unwrap()
}

#[test]
fn auth_call_and_notification_skipping() {
    let addr = fake_core("1.0.0");
    let mut c = connect(&addr);
    assert_eq!(c.hello().contract, "1.4.1");
    assert_eq!(c.hello().instance_id, "i");
    assert_eq!(c.call("echo", json!({"x": 1})).unwrap(), json!({"x": 1}));
    match c.call("nope", json!({})) {
        Err(RpcError::Call { reason, .. }) => {
            assert_eq!(reason.as_deref(), Some("method-not-found"))
        }
        other => panic!("{other:?}"),
    }
    // A Call error is a clean line boundary: the client stays usable.
    assert_eq!(c.call("echo", json!({"y": 2})).unwrap(), json!({"y": 2}));
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
fn major_2_hello_with_a_different_shape_is_a_version_error_not_protocol() {
    let addr = fake_core_with(json!({"rpc":"2.0.0","somethingNew":true}));
    match Client::connect(&addr, TOKEN, ConnectOptions::default()) {
        Err(RpcError::Version { server }) => assert_eq!(server, "2.0.0"),
        Err(e) => panic!("expected Version, got {e:?}"),
        Ok(_) => panic!("expected Version, got a client"),
    }
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

#[test]
fn a_core_that_accepts_but_never_answers_fails_the_handshake_under_the_connect_timeout() {
    let (addr, listener) = socket_path();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for s in listener.incoming() {
            held.push(s.unwrap()); // accept, never read, never answer
        }
    });
    let t0 = Instant::now();
    let e = Client::connect(&addr, TOKEN, ConnectOptions::default())
        .err()
        .expect("handshake must fail");
    assert!(plur1bus_rpc::is_unavailable(&e), "{e}");
    assert!(
        t0.elapsed() < Duration::from_secs(1),
        "took {:?}",
        t0.elapsed()
    );
}

#[test]
fn a_line_of_exactly_4_mib_is_accepted_and_a_longer_one_is_a_protocol_error_that_poisons() {
    let addr = fake_core("1.0.0");
    let mut c = connect(&addr);
    let ok = c.call("big", json!({"len": MAX_LINE})).unwrap();
    let expected_s = MAX_LINE - r#"{"jsonrpc":"2.0","id":2,"result":{"s":""}}"#.len();
    assert_eq!(ok["s"].as_str().unwrap().len(), expected_s);
    match c.call("big", json!({"len": MAX_LINE + 1})) {
        Err(RpcError::Protocol(m)) => assert_eq!(m, "line too long"),
        other => panic!("{other:?}"),
    }
    match c.call("echo", json!({})) {
        Err(RpcError::Unavailable { reason, .. }) => assert_eq!(reason, "poisoned"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_call_error_keeps_reason_detail_and_ids() {
    let addr = fake_core("1.0.0");
    let mut c = connect(&addr);
    match c.call("storage", json!({})) {
        Err(e @ RpcError::Call { .. }) => {
            assert_eq!(e.code_name(), "E_STORAGE");
            let ids = e.ids().expect("ids survive");
            assert_eq!(ids.get("sourceId").map(String::as_str), Some("m-src"));
            assert_eq!(ids.get("sharedId").map(String::as_str), Some("m-copy"));
            let RpcError::Call { reason, detail, .. } = &e else {
                unreachable!()
            };
            assert_eq!(reason.as_deref(), Some("storage"));
            assert_eq!(detail.as_deref(), Some("refresh"));
        }
        other => panic!("{other:?}"),
    }
    // An error without ids has none.
    match c.call("nope", json!({})) {
        Err(e @ RpcError::Call { .. }) => assert!(e.ids().is_none()),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_null_id_error_surfaces_as_its_call_error_and_a_hollow_response_is_protocol() {
    let addr = fake_core("1.0.0");
    let mut c = connect(&addr);
    let t0 = Instant::now();
    match c.call("unparseable", json!({})) {
        Err(RpcError::Call {
            error,
            jsonrpc,
            reason,
            ..
        }) => {
            assert_eq!(error.to_string(), "E_INVALID_PARAMS");
            assert_eq!(jsonrpc, -32600);
            assert_eq!(reason.as_deref(), Some("parse"));
        }
        other => panic!("{other:?}"),
    }
    assert!(t0.elapsed() < Duration::from_secs(1));
    assert!(matches!(
        c.call("hollow", json!({})),
        Err(RpcError::Protocol(_))
    ));
}

#[test]
fn a_timeout_poisons_the_client() {
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
    assert!(c.call("slow", json!({})).is_err());
    std::thread::sleep(Duration::from_millis(400)); // the late answer arrives; it must not be read as the next call's
    match c.call("echo", json!({"x": 1})) {
        Err(RpcError::Unavailable { reason, .. }) => assert_eq!(reason, "poisoned"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn supports_is_true_without_capabilities_and_follows_the_map_with_them() {
    let addr = fake_core("1.0.0");
    let c = connect(&addr);
    assert!(
        c.supports("memory.propose"),
        "an older core with no capabilities answers for itself"
    );

    let addr2 = fake_core_with(json!({
        "contract": "1.6.0",
        "rpc": "1.1.0",
        "instanceId": "i",
        "pid": 1,
        "capabilities": {
            "methods": {"echo": {"stability": "stable", "since": "1.0.0"}},
            "notifications": {},
            "extensionPoints": {},
            "features": [],
        },
    }));
    let c2 = connect(&addr2);
    assert!(c2.supports("echo"));
    assert!(!c2.supports("memory.propose"));
}

/// ADR-016 §2: a client ignores result fields it does not know, so a newer 1.x core can add them.
#[test]
fn unknown_result_fields_are_ignored_in_the_hello_and_in_typed_results() {
    let addr = fake_core_with(json!({
        "contract": "1.6.0",
        "rpc": "1.2.0",
        "instanceId": "i",
        "pid": 1,
        "addedInAFutureMinor": true,
        "capabilities": {
            "methods": {"echo": {"stability": "stable", "since": "1.0.0", "futureAnnotation": 1}},
            "notifications": {},
            "extensionPoints": {},
            "features": [],
            "futureSection": {},
        },
    }));
    let mut c = connect(&addr);
    assert!(c.supports("echo"));
    assert!(!c.supports("memory.propose"));
    let r: plur1bus_rpc::types::MemoryForgetResult =
        c.call_typed("forget-extra", &json!({})).unwrap();
    assert_eq!(r.tombstone_id.as_deref(), Some("t-1"));
}

#[test]
fn invalid_utf8_from_the_core_is_a_protocol_error() {
    let addr = fake_core("1.0.0");
    let mut c = connect(&addr);
    assert!(matches!(
        c.call("badutf8", json!({})),
        Err(RpcError::Protocol(_))
    ));
}
