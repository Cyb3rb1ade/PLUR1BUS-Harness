//! Transport acceptance with an explicitly injected engine; no production memory implementation is substituted.

// Tests fail immediately on invalid fixtures or failed cleanup; no unchecked values reach production.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};

use super::engine::FixtureEngine;
use super::layout::EngineLayout;
use super::lifeline::Lifeline;
use super::server::{serve_with_options, ServeError, ServerOptions};
use crate::contract::testing::FakeHost;
use crate::contract::{CaptureResult, Engine, RecallResult};

const CALL_TIMEOUT: Duration = Duration::from_secs(3);
const NOW: i64 = 1_700_000_000_042;
// serve installs process-wide signal handlers. Keep the two in-process lifetimes disjoint.
static SERVING: Mutex<()> = Mutex::new(());

fn recall_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/rpc-schema/fixtures/methods/engine.recall.json"
    ))
    .unwrap()
}

fn capture_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/rpc-schema/fixtures/methods/engine.capture.json"
    ))
    .unwrap()
}

fn capture_result_fixture() -> Value {
    serde_json::from_str::<Value>(include_str!(
        "../../../../packages/rpc-schema/fixtures/methods/engine.capture.wait.json"
    ))
    .unwrap()["result"]
        .clone()
}

struct Serving {
    home: tempfile::TempDir,
    layout: Arc<EngineLayout>,
    worker: Option<JoinHandle<Result<(), ServeError>>>,
    engine: Arc<FixtureEngine>,
}

impl Serving {
    fn start(recall: Value, capture: Value) -> Self {
        Self::configured(recall, capture, ServerOptions::default())
    }

    fn configured(recall: Value, capture: Value, options: ServerOptions) -> Self {
        let home = tempfile::Builder::new()
            .prefix("pr-")
            .tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap())
            .unwrap();
        let host = Arc::new(FakeHost::new(
            home.path().join("state"),
            serde_json::from_value(json!({})).unwrap(),
        ));
        host.set_now_ms(NOW);
        let recall: RecallResult = serde_json::from_value(recall).unwrap();
        let capture: CaptureResult = serde_json::from_value(capture).unwrap();
        let engine = Arc::new(FixtureEngine::new(host, recall, capture).unwrap());
        let layout = Arc::new(
            EngineLayout::new(home.path(), "00000000-0000-4000-8000-000000000082".into()).unwrap(),
        );
        let serving_layout = layout.clone();
        let serving_engine: Arc<dyn Engine> = engine.clone();
        let worker = thread::Builder::new()
            .name("test-engine-server".into())
            .spawn(move || {
                serve_with_options(serving_engine, &serving_layout, Lifeline::None, &options)
            })
            .unwrap();
        let server = Self {
            home,
            layout,
            worker: Some(worker),
            engine,
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        while !server.home.path().join("run/engine.pid").exists() {
            assert!(
                !server.worker.as_ref().unwrap().is_finished(),
                "injected engine server exited before publishing its identity"
            );
            assert!(
                Instant::now() < deadline,
                "engine server readiness timed out"
            );
            thread::sleep(Duration::from_millis(10));
        }
        server
    }

    fn connect(&self) -> Client {
        Client::connect_with_auth(
            &self.layout.address,
            json!({"token":self.layout.token(),"clientId":"injected-engine-acceptance"}),
            ConnectOptions {
                endpoint: Endpoint::Engine,
                expected_server_pid: Some(std::process::id()),
                connect_timeout: CALL_TIMEOUT,
                call_timeout: CALL_TIMEOUT,
            },
        )
        .unwrap()
    }

    fn join(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.worker.as_ref().unwrap().is_finished() {
            assert!(
                Instant::now() < deadline,
                "engine close exceeded test deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
        self.worker
            .take()
            .expect("server thread was not joined yet")
            .join()
            .expect("server thread did not panic")
            .expect("server closed cleanly");
        for name in ["engine.token", "engine.pid"] {
            assert!(!self.home.path().join("run").join(name).exists());
        }
        #[cfg(unix)]
        assert!(!self.home.path().join("run/engine.sock").exists());
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            // Assertion unwinding must still unblock listeners and close every server worker.
            super::signals::request();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !worker.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}

struct WireClient {
    reader: BufReader<Box<dyn plur1bus_rpc::transport::Stream>>,
    notifications: Vec<Value>,
    next_id: u64,
}

impl WireClient {
    fn connect(server: &Serving) -> Self {
        let stream =
            plur1bus_rpc::transport::connect(&server.layout.address, CALL_TIMEOUT).unwrap();
        stream.set_read_timeout(Some(CALL_TIMEOUT)).unwrap();
        let mut client = Self {
            reader: BufReader::new(stream),
            notifications: Vec::new(),
            next_id: 0,
        };
        let auth = client.call(
            "engine.auth",
            json!({"token":server.layout.token(),"clientId":"capture-notification-acceptance"}),
        );
        assert_eq!(auth["result"]["pid"], std::process::id());
        client
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            self.reader.read_line(&mut line).unwrap() > 0,
            "unexpected engine EOF"
        );
        serde_json::from_str(&line).unwrap()
    }

    fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = json!({"jsonrpc":"2.0","id":id,"method":method});
        message["params"] = params;
        let writer = self.reader.get_mut();
        writer.write_all(message.to_string().as_bytes()).unwrap();
        writer.write_all(b"\n").unwrap();
        writer.flush().unwrap();
        id
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        loop {
            let message = self.read();
            if message.get("id").is_some() {
                assert_eq!(message["id"], id);
                return message;
            }
            self.notifications.push(message);
        }
    }

    fn capture_done(&mut self, id: &str) -> Value {
        loop {
            if let Some(index) = self.notifications.iter().position(|message| {
                message["method"] == "engine.capture.done" && message["params"]["id"] == id
            }) {
                return self.notifications.remove(index);
            }
            let message = self.read();
            assert!(
                message.get("id").is_none(),
                "unexpected pending reply: {message}"
            );
            self.notifications.push(message);
        }
    }
}

#[test]
fn status_recall_capture_roundtrip_over_the_socket() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let recall = recall_fixture();
    let capture = capture_result_fixture();
    let mut server = Serving::start(recall["result"].clone(), capture.clone());
    let mut client = server.connect();
    assert_eq!(client.endpoint(), Endpoint::Engine);
    let status = client.call("engine.status", json!({})).unwrap();
    assert_eq!(status["ready"], true);
    assert_eq!(status["contract"], client.hello()["contract"]);
    assert_eq!(status["pid"], std::process::id());
    assert_eq!(
        client
            .call("engine.recall", recall["params"].clone())
            .unwrap(),
        recall["result"]
    );
    let receipt = client
        .call("engine.capture", capture_fixture()["params"].clone())
        .unwrap();
    assert_eq!(receipt["acceptedAt"], NOW);
    assert!(receipt["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(
        client
            .call(
                "engine.capture.wait",
                json!({"id":receipt["id"],"timeoutMs":1000})
            )
            .unwrap(),
        capture
    );
    assert_eq!(
        client.call("engine.shutdown", json!({})).unwrap(),
        json!({})
    );
    server.join();
}

#[test]
fn capture_done_is_notified_and_wait_returns_the_result() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let capture = capture_result_fixture();
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture.clone());
    let mut client = WireClient::connect(&server);
    let receipt = client.call("engine.capture", capture_fixture()["params"].clone());
    let id = receipt["result"]["id"].as_str().unwrap();
    assert_eq!(receipt["result"]["acceptedAt"], NOW);
    // FixtureEngine completes immediately. Retain notifications that win the race with the receipt.
    let notification = client.capture_done(id);
    assert_eq!(notification["jsonrpc"], "2.0");
    assert!(notification.get("id").is_none());
    assert_eq!(notification["params"], json!({"id":id,"result":capture}));
    assert_eq!(
        client.call("engine.capture.wait", json!({"id":id,"timeoutMs":1000}))["result"],
        capture
    );
    for _ in 0..2 {
        assert_eq!(
            client.call(
                "engine.capture.abort",
                json!({"id":id,"reason":"acceptance-complete"})
            )["result"],
            json!({})
        );
    }
    let unknown = client.call(
        "engine.capture.wait",
        json!({"id":"private-missing-capture-marker","timeoutMs":0}),
    );
    assert_eq!(unknown["error"]["code"], -32000);
    assert_eq!(unknown["error"]["data"]["error"], "E_NOT_AVAILABLE");
    assert_eq!(unknown["error"]["data"]["reason"], "operation-unavailable");
    assert!(unknown.to_string().len() < 1024);
    assert!(!unknown
        .to_string()
        .contains("private-missing-capture-marker"));
    assert_eq!(
        client.call("engine.shutdown", json!({}))["result"],
        json!({})
    );
    server.join();
}

#[test]
fn oversized_response_refuses_only_its_request_and_keeps_the_connection() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut recall = recall_fixture();
    recall["result"]["blocks"] = json!([{
        "name":"memory", "text":"x".repeat(plur1bus_rpc::client::MAX_LINE + 1),
        "chars":plur1bus_rpc::client::MAX_LINE + 1, "droppable":true
    }]);
    let mut server = Serving::start(recall["result"].clone(), capture_result_fixture());
    let mut client = WireClient::connect(&server);
    let response = client.call("engine.recall", recall["params"].clone());
    assert_eq!(response["error"]["data"]["error"], "E_INVALID_PARAMS");
    assert_eq!(response["error"]["data"]["reason"], "response-too-large");
    assert!(response.to_string().len() < 1024);
    assert_eq!(
        client.call("engine.status", json!({}))["result"]["ready"],
        true
    );
    assert_eq!(
        client.call("engine.shutdown", json!({}))["result"],
        json!({})
    );
    server.join();
}

#[test]
fn unauthenticated_non_auth_request_is_refused_and_closed() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture_result_fixture());
    let stream = plur1bus_rpc::transport::connect(&server.layout.address, CALL_TIMEOUT).unwrap();
    stream.set_read_timeout(Some(CALL_TIMEOUT)).unwrap();
    let mut reader = BufReader::new(stream);
    reader
        .get_mut()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"engine.status\",\"params\":{}}\n")
        .unwrap();
    reader.get_mut().flush().unwrap();
    let mut line = String::new();
    assert!(reader.read_line(&mut line).unwrap() > 0);
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["error"]["data"]["reason"],
        "auth-required"
    );
    line.clear();
    assert_eq!(reader.read_line(&mut line).unwrap(), 0);
    server.connect().call("engine.shutdown", json!({})).unwrap();
    server.join();
}

#[test]
fn a_transient_accept_failure_is_counted_and_the_listener_recovers() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::configured(
        recall_fixture()["result"].clone(),
        capture_result_fixture(),
        ServerOptions {
            accept_errors: 1,
            ..ServerOptions::default()
        },
    );
    let mut client = server.connect();
    assert_eq!(
        client.call("engine.status", json!({})).unwrap()["counters"]["acceptErrors"],
        1
    );
    assert!(client
        .call("engine.recall", recall_fixture()["params"].clone())
        .is_ok());
    client.call("engine.shutdown", json!({})).unwrap();
    server.join();
}

#[test]
fn request_thread_creation_failure_is_bounded_and_retryable() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::configured(
        recall_fixture()["result"].clone(),
        capture_result_fixture(),
        ServerOptions {
            fail_spawn: Some("engine-request"),
            ..ServerOptions::default()
        },
    );
    let mut client = WireClient::connect(&server);
    let response = client.call("engine.status", json!({}));
    assert_eq!(response["error"]["data"]["reason"], "engine-busy");
    assert!(response.to_string().len() < 1024);
    assert_eq!(
        client.call("engine.status", json!({}))["result"]["ready"],
        true
    );
    client.call("engine.shutdown", json!({}));
    server.join();
}

#[test]
fn the_ninth_in_flight_request_receives_engine_busy() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture_result_fixture());
    let gate = server.engine.block_recall();
    struct Release(Arc<super::engine::testkit::FixtureGate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    let release = Release(gate.clone());
    let mut client = WireClient::connect(&server);
    for _ in 0..8 {
        client.send("engine.recall", recall_fixture()["params"].clone());
    }
    assert!(gate.wait_entered(CALL_TIMEOUT));
    let response = client.call("engine.status", json!({}));
    assert_eq!(response["error"]["data"]["error"], "E_NOT_AVAILABLE");
    assert_eq!(response["error"]["data"]["reason"], "engine-busy");
    drop(release);
    server.connect().call("engine.shutdown", json!({})).unwrap();
    server.join();
}

#[test]
fn pending_captures_have_a_small_capacity_and_one_live_connection_survives() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture_result_fixture());
    server.engine.hold_captures();
    let mut client = WireClient::connect(&server);
    for _ in 0..128 {
        assert!(
            client.call("engine.capture", capture_fixture()["params"].clone())["result"]["id"]
                .is_string()
        );
    }
    let response = client.call("engine.capture", capture_fixture()["params"].clone());
    assert_eq!(response["error"]["data"]["reason"], "engine-busy");
    assert_eq!(
        client.call("engine.status", json!({}))["result"]["counters"]["capturesPending"],
        128
    );
    client.call("engine.shutdown", json!({"budgetMs":100}));
    server.join();
}

#[test]
fn shutdown_deadline_bounds_uncooperative_recall_and_close_callbacks() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture_result_fixture());
    let recall_gate = server.engine.block_recall();
    let close_gate = server.engine.block_close();
    struct Release(Vec<Arc<super::engine::testkit::FixtureGate>>);
    impl Drop for Release {
        fn drop(&mut self) {
            for gate in &self.0 {
                gate.release();
            }
        }
    }
    let release = Release(vec![recall_gate.clone(), close_gate.clone()]);
    let mut client = WireClient::connect(&server);
    client.send("engine.recall", recall_fixture()["params"].clone());
    assert!(recall_gate.wait_entered(CALL_TIMEOUT));
    let started = Instant::now();
    server
        .connect()
        .call("engine.shutdown", json!({"budgetMs":100}))
        .unwrap();
    assert!(close_gate.wait_entered(CALL_TIMEOUT));
    server.join();
    assert!(
        started.elapsed() < CALL_TIMEOUT,
        "shutdown exceeded its bounded close window"
    );
    drop(release);
}

#[test]
fn oversized_embedding_batches_are_refused_before_provider_work() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture_result_fixture());
    let mut client = WireClient::connect(&server);
    let identity = client.call("engine.embedding.identities", json!({}))["result"][0].clone();
    for (method, params) in [
        (
            "engine.embedding.embed",
            json!({"texts":vec!["short";129],"kind":"query","identity":identity}),
        ),
        (
            "engine.embedding.rerank",
            json!({"query":"test","docs":vec!["short";129],"topN":1}),
        ),
    ] {
        let response = client.call(method, params);
        assert_eq!(
            response["error"]["data"]["reason"],
            "embedding-batch-too-large"
        );
    }
    assert_eq!(
        client.call("engine.status", json!({}))["result"]["ready"],
        true
    );
    client.call("engine.shutdown", json!({}));
    server.join();
}

#[test]
fn unauthenticated_frames_are_capped_before_full_json_parsing() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut server = Serving::start(recall_fixture()["result"].clone(), capture_result_fixture());
    let stream = plur1bus_rpc::transport::connect(&server.layout.address, CALL_TIMEOUT).unwrap();
    stream.set_read_timeout(Some(CALL_TIMEOUT)).unwrap();
    let mut reader = BufReader::new(stream);
    let mut frame = vec![b' '; 64 * 1024 + 2];
    frame.push(b'\n');
    let _ = reader.get_mut().write_all(&frame);
    let mut line = String::new();
    let result = reader.read_line(&mut line);
    assert!(
        matches!(result, Ok(0))
            || matches!(result, Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe))
    );
    server.connect().call("engine.shutdown", json!({})).unwrap();
    server.join();
}

#[test]
fn a_blocked_peer_writer_cannot_stall_other_capture_completions() {
    let _serial = SERVING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let gate = Arc::new(super::engine::testkit::FixtureGate::default());
    struct Release(Arc<super::engine::testkit::FixtureGate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    let expected = capture_result_fixture();
    let mut server = Serving::configured(
        recall_fixture()["result"].clone(),
        expected.clone(),
        ServerOptions {
            block_first_notification: Some(gate.clone()),
            ..ServerOptions::default()
        },
    );
    let release = Release(gate.clone());
    let mut stalled = WireClient::connect(&server);
    // This client stops reading after submitting its capture. The injected
    // writer proves the notification is blocked, independently of socket sizes.
    stalled.send("engine.capture", capture_fixture()["params"].clone());
    assert!(gate.wait_entered(CALL_TIMEOUT));
    let mut healthy = WireClient::connect(&server);
    let receipt = healthy.call("engine.capture", capture_fixture()["params"].clone());
    let id = receipt["result"]["id"].as_str().unwrap();
    assert_eq!(
        healthy.call("engine.capture.wait", json!({"id":id,"timeoutMs":1000}))["result"],
        expected
    );
    assert_eq!(healthy.capture_done(id)["params"]["result"], expected);
    assert_eq!(
        healthy.call("engine.status", json!({}))["result"]["counters"]["capturesPending"],
        0
    );
    drop(release);
    drop(stalled);
    healthy.call("engine.shutdown", json!({"budgetMs":1000}));
    server.join();
}
