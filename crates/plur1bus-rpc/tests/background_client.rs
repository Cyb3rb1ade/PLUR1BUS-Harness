//! Persistent RPC behavior against real local sockets, including framing and cancellation.
#![cfg(unix)]

use plur1bus_rpc::client::{BackgroundClient, ClientEvent, MAX_LINE};
use plur1bus_rpc::{ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const BUDGET: Duration = Duration::from_secs(2);

fn request(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
    serde_json::from_str(&line).unwrap()
}

fn send(writer: &mut UnixStream, value: Value) {
    writeln!(writer, "{value}").unwrap();
}

fn fake_core(
    serve: impl FnOnce(BufReader<UnixStream>, UnixStream) + Send + 'static,
) -> (tempfile::TempDir, String, thread::JoinHandle<()>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let writer = stream.try_clone().unwrap();
        serve(BufReader::new(stream), writer);
    });
    (dir, path.to_str().unwrap().into(), server)
}

fn auth(reader: &mut BufReader<UnixStream>, writer: &mut UnixStream) {
    let message = request(reader);
    assert_eq!(message["method"], "core.auth");
    assert_eq!(message["params"], json!({"token": "test-secret"}));
    send(
        writer,
        json!({"jsonrpc":"2.0","id": message["id"], "result": {
            "contract":"1.8.0", "rpc":"1.7.0", "instanceId":"test", "pid":1
        }}),
    );
}

fn connect(address: &str) -> (BackgroundClient, mpsc::Receiver<ClientEvent>) {
    let (sender, receiver) = mpsc::channel();
    let client = BackgroundClient::connect_with_auth(
        address,
        json!({"token":"test-secret"}),
        ConnectOptions::default(),
        Arc::new(move |event| {
            let _ = sender.send(event);
        }),
    )
    .unwrap();
    (client, receiver)
}

fn notification(events: &mpsc::Receiver<ClientEvent>, expected: &str) {
    match events.recv_timeout(BUDGET).unwrap() {
        ClientEvent::Notification { method, params } => {
            assert_eq!(method, expected);
            assert_eq!(params, json!({"value":1}));
        }
        ClientEvent::Closed => panic!("connection closed before notification"),
    }
}

#[test]
fn one_authenticated_connection_delivers_idle_and_in_call_notifications() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        send(
            &mut writer,
            json!({"jsonrpc":"2.0", "method":"idle", "params":{"value":1}}),
        );
        for n in 0..3 {
            let message = request(&mut reader);
            assert_eq!(message["method"], "echo");
            send(
                &mut writer,
                json!({"jsonrpc":"2.0", "method":"during", "params":{"value":1}}),
            );
            send(
                &mut writer,
                json!({"jsonrpc":"2.0", "id":message["id"], "result":n}),
            );
        }
        let mut end = String::new();
        assert_eq!(reader.read_line(&mut end).unwrap(), 0);
    });
    let (client, events) = connect(&address);
    notification(&events, "idle");
    for n in 0..3 {
        assert_eq!(
            client.call("echo", json!({}), BUDGET, &|| false).unwrap(),
            n
        );
        notification(&events, "during");
    }
    client.close();
    assert!(client.is_closed());
    assert!(matches!(
        events.recv_timeout(BUDGET).unwrap(),
        ClientEvent::Closed
    ));
    drop(client);
    server.join().unwrap();
}

#[test]
fn concurrent_calls_receive_their_own_out_of_order_responses() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        let first = request(&mut reader);
        let second = request(&mut reader);
        for message in [second, first] {
            send(
                &mut writer,
                json!({"jsonrpc":"2.0", "id":message["id"], "result":message["params"]}),
            );
        }
    });
    let (client, _events) = connect(&address);
    thread::scope(|scope| {
        let one = scope.spawn(|| client.call("echo", json!(1), BUDGET, &|| false));
        let two = scope.spawn(|| client.call("echo", json!(2), BUDGET, &|| false));
        assert_eq!(one.join().unwrap().unwrap(), 1);
        assert_eq!(two.join().unwrap().unwrap(), 2);
    });
    server.join().unwrap();
}

#[test]
fn partial_frames_survive_idle_read_ticks_and_buffered_hello_bytes() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        let message = request(&mut reader);
        let hello = json!({"jsonrpc":"2.0", "id":message["id"], "result":{
            "contract":"1.8.0", "rpc":"1.7.0", "instanceId":"test", "pid":1
        }});
        // A single write makes the notification prefix eligible for the handshake's BufReader buffer.
        write!(
            writer,
            "{hello}\n{{\"jsonrpc\":\"2.0\",\"method\":\"partial\","
        )
        .unwrap();
        thread::sleep(Duration::from_millis(160));
        writer.write_all(b"\"params\":{\"value\":1}}\n").unwrap();
        let message = request(&mut reader);
        let response = format!(
            "{}\n",
            json!({"jsonrpc":"2.0", "id":message["id"], "result":"ok"})
        );
        writer.write_all(&response.as_bytes()[..12]).unwrap();
        thread::sleep(Duration::from_millis(160));
        writer.write_all(&response.as_bytes()[12..]).unwrap();
    });
    let (client, events) = connect(&address);
    notification(&events, "partial");
    assert_eq!(
        client.call("echo", json!({}), BUDGET, &|| false).unwrap(),
        "ok"
    );
    server.join().unwrap();
}

#[test]
fn eof_fails_a_pending_call_and_emits_closed_once() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        request(&mut reader);
    });
    let (client, events) = connect(&address);
    assert!(matches!(
        client.call("wait", json!({}), BUDGET, &|| false),
        Err(RpcError::Unavailable { .. })
    ));
    assert!(client.is_closed());
    assert!(matches!(
        events.recv_timeout(BUDGET).unwrap(),
        ClientEvent::Closed
    ));
    client.close();
    drop(client);
    assert!(events.try_recv().is_err());
    server.join().unwrap();
}

#[test]
fn timeout_and_cancellation_close_the_connection_and_bound_drop() {
    for cancel in [false, true] {
        let (_dir, address, server) = fake_core(|mut reader, mut writer| {
            auth(&mut reader, &mut writer);
            // EOF also covers cancellation before a request is sent.
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
        });
        let (client, _events) = connect(&address);
        let start = Instant::now();
        let result = client.call("wait", json!({}), Duration::from_millis(90), &|| {
            cancel && start.elapsed() >= Duration::from_millis(35)
        });
        let expected = if cancel { "cancelled" } else { "call-timeout" };
        assert!(matches!(result, Err(RpcError::Unavailable { reason, .. }) if reason == expected));
        assert!(client.is_closed());
        drop(client);
        assert!(start.elapsed() < Duration::from_millis(700));
        server.join().unwrap();
    }
}

#[test]
fn stalled_writes_and_writer_contention_respect_each_call_deadline() {
    let (release, held) = mpsc::channel();
    let (_dir, address, server) = fake_core(move |mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        held.recv_timeout(BUDGET).unwrap();
    });
    let (client, _events) = connect(&address);
    let start = Instant::now();
    thread::scope(|scope| {
        let large = scope.spawn(|| {
            client.call(
                "large",
                json!({"data":"x".repeat(MAX_LINE / 2)}),
                Duration::from_millis(180),
                &|| false,
            )
        });
        thread::sleep(Duration::from_millis(20));
        let short = client.call("short", json!({}), Duration::from_millis(70), &|| false);
        assert!(short.is_err());
        assert!(large.join().unwrap().is_err());
    });
    drop(client);
    assert!(start.elapsed() < Duration::from_millis(700));
    release.send(()).unwrap();
    server.join().unwrap();
}

#[test]
fn exact_line_limit_is_accepted_and_overlong_frame_closes_the_connection() {
    for extra in [0, 1] {
        let (_dir, address, server) = fake_core(move |mut reader, mut writer| {
            auth(&mut reader, &mut writer);
            let message = request(&mut reader);
            let prefix = format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":\"",
                message["id"]
            );
            let mut frame = prefix.into_bytes();
            frame.resize(MAX_LINE + extra - 2, b'x');
            frame.extend_from_slice(b"\"}\n");
            let _ = writer.write_all(&frame);
        });
        let (client, _events) = connect(&address);
        let result = client.call("large", json!({}), BUDGET, &|| false);
        if extra == 0 {
            assert_eq!(
                result.unwrap().as_str().unwrap().len(),
                MAX_LINE - r#"{"jsonrpc":"2.0","id":2,"result":""}"#.len()
            );
        } else {
            assert!(
                matches!(result, Err(RpcError::Protocol(message)) if message == "line too long")
            );
            assert!(client.is_closed());
        }
        server.join().unwrap();
    }
}

#[test]
fn idle_eof_is_reported_without_requiring_a_call() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        auth(&mut reader, &mut writer);
    });
    let (client, events) = connect(&address);
    assert!(matches!(
        events.recv_timeout(BUDGET).unwrap(),
        ClientEvent::Closed
    ));
    assert!(client.is_closed());
    drop(client);
    server.join().unwrap();
}

#[test]
fn pending_calls_are_capped_and_close_releases_every_waiter() {
    let (received, ready) = mpsc::channel();
    let (_dir, address, server) = fake_core(move |mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        for _ in 0..64 {
            request(&mut reader);
        }
        received.send(()).unwrap();
        let mut end = String::new();
        assert_eq!(reader.read_line(&mut end).unwrap(), 0);
    });
    let (client, _events) = connect(&address);
    thread::scope(|scope| {
        let calls: Vec<_> = (0..64)
            .map(|_| scope.spawn(|| client.call("wait", json!({}), BUDGET, &|| false)))
            .collect();
        ready.recv_timeout(BUDGET).unwrap();
        assert!(
            matches!(client.call("overflow", json!({}), BUDGET, &|| false),
            Err(RpcError::Unavailable { reason, .. }) if reason == "busy")
        );
        assert!(!client.is_closed());
        client.close();
        for call in calls {
            assert!(call.join().unwrap().is_err());
        }
    });
    drop(client);
    server.join().unwrap();
}

#[test]
fn drop_is_bounded_when_a_user_callback_blocks() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        send(&mut writer, json!({"method":"block", "params":{}}));
        let mut end = String::new();
        assert_eq!(reader.read_line(&mut end).unwrap(), 0);
    });
    let (entered, started) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let blocked = std::sync::Mutex::new(blocked);
    let client = BackgroundClient::connect_with_auth(
        &address,
        json!({"token":"test-secret"}),
        ConnectOptions::default(),
        Arc::new(move |event| {
            if matches!(event, ClientEvent::Notification { .. }) {
                entered.send(()).unwrap();
                blocked.lock().unwrap().recv_timeout(BUDGET).unwrap();
            }
        }),
    )
    .unwrap();
    started.recv_timeout(BUDGET).unwrap();
    let start = Instant::now();
    drop(client);
    assert!(start.elapsed() < Duration::from_millis(700));
    release.send(()).unwrap();
    server.join().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn saturated_unix_backlog_cannot_outlive_the_connect_deadline() {
    use std::os::fd::AsRawFd;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backlog.sock");
    let listener = UnixListener::bind(&path).unwrap();
    // SAFETY: this is a live listening socket; zero backlog leaves one queued connection on Linux.
    assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
    let _queued = UnixStream::connect(&path).unwrap();
    let release = listener.try_clone().unwrap();
    // Always unblock the old blocking implementation, so RED fails by assertion rather than hanging.
    let releaser = thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        release.accept().unwrap();
    });
    let start = Instant::now();
    let connection =
        plur1bus_rpc::transport::connect(path.to_str().unwrap(), Duration::from_millis(70));
    let elapsed = start.elapsed();
    let rejected = connection.is_err();
    drop(connection);
    releaser.join().unwrap();
    assert!(
        rejected,
        "a saturated backlog must not yield an unconnected stream"
    );
    assert!(
        elapsed < Duration::from_millis(180),
        "connect exceeded its deadline: {elapsed:?}"
    );
}

#[test]
fn authentication_has_one_deadline_across_trickled_bytes_and_notifications() {
    for notifications in [false, true] {
        for background in [false, true] {
            let (_dir, address, server) = fake_core(move |mut reader, mut writer| {
                request(&mut reader);
                let start = Instant::now();
                while start.elapsed() < Duration::from_millis(380) {
                    let bytes: &[u8] = if notifications {
                        b"{\"jsonrpc\":\"2.0\",\"method\":\"waiting\",\"params\":{}}\n"
                    } else {
                        b" "
                    };
                    if writer.write_all(bytes).is_err() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(15));
                }
            });
            let opts = ConnectOptions {
                connect_timeout: Duration::from_millis(70),
                ..Default::default()
            };
            let start = Instant::now();
            let result = if background {
                BackgroundClient::connect_with_auth(
                    &address,
                    json!({"token":"test-secret"}),
                    opts,
                    Arc::new(|_| {}),
                )
                .map(drop)
            } else {
                plur1bus_rpc::Client::connect_with_auth(
                    &address,
                    json!({"token":"test-secret"}),
                    opts,
                )
                .map(drop)
            };
            let elapsed = start.elapsed();
            server.join().unwrap();
            assert!(
                matches!(result, Err(RpcError::Unavailable { reason, .. }) if reason == "handshake-timeout")
            );
            assert!(
                elapsed < Duration::from_millis(300),
                "trickled auth exceeded its deadline: {elapsed:?}"
            );
        }
    }
}

#[test]
fn authentication_write_cannot_outlive_its_deadline_when_the_core_does_not_read() {
    let (_dir, address, server) = fake_core(|_reader, _writer| {
        thread::sleep(Duration::from_millis(400));
    });
    let start = Instant::now();
    let result = BackgroundClient::connect_with_auth(
        &address,
        json!({"token":"test-secret", "data":"x".repeat(MAX_LINE / 2)}),
        ConnectOptions {
            connect_timeout: Duration::from_millis(70),
            ..Default::default()
        },
        Arc::new(|_| {}),
    );
    let elapsed = start.elapsed();
    server.join().unwrap();
    assert!(
        matches!(result, Err(RpcError::Unavailable { reason, .. }) if reason == "handshake-timeout")
    );
    assert!(
        elapsed < Duration::from_millis(300),
        "stalled auth write exceeded deadline: {elapsed:?}"
    );
}

#[test]
fn synchronous_calls_use_one_deadline_across_unsolicited_notifications() {
    let (_dir, address, server) = fake_core(|mut reader, mut writer| {
        auth(&mut reader, &mut writer);
        request(&mut reader);
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(380) {
            if writer
                .write_all(b"{\"method\":\"waiting\",\"params\":{}}\n")
                .is_err()
            {
                break;
            }
            thread::sleep(Duration::from_millis(15));
        }
    });
    let mut client = plur1bus_rpc::Client::connect_with_auth(
        &address,
        json!({"token":"test-secret"}),
        ConnectOptions {
            call_timeout: Duration::from_millis(70),
            ..Default::default()
        },
    )
    .unwrap();
    let start = Instant::now();
    let result = client.call("wait", json!({}));
    let elapsed = start.elapsed();
    drop(client);
    server.join().unwrap();
    assert!(
        matches!(result, Err(RpcError::Unavailable { reason, .. }) if reason == "call-timeout")
    );
    assert!(elapsed < Duration::from_millis(300));
}
