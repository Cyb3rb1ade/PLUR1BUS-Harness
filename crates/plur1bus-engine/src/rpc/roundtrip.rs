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
use super::server::{serve, ServeError};
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
}

impl Serving {
    fn start(recall: Value, capture: Value) -> Self {
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
        let engine: Arc<dyn Engine> = Arc::new(FixtureEngine::new(host, recall, capture).unwrap());
        let layout = Arc::new(
            EngineLayout::new(home.path(), "00000000-0000-4000-8000-000000000082".into()).unwrap(),
        );
        let serving_layout = layout.clone();
        let worker = thread::spawn(move || serve(engine, &serving_layout, Lifeline::None));
        let server = Self {
            home,
            layout,
            worker: Some(worker),
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
            let _ = worker.join();
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

    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = json!({"jsonrpc":"2.0","id":id,"method":method});
        message["params"] = params;
        let writer = self.reader.get_mut();
        writer.write_all(message.to_string().as_bytes()).unwrap();
        writer.write_all(b"\n").unwrap();
        writer.flush().unwrap();
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
