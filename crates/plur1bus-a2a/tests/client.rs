#![allow(clippy::panic, clippy::unwrap_used, reason = "fixture assertions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_a2a::client::{Message, Operation, PushRequest};
use serde_json::Value;

fn operations() -> [Operation<'static>; 10] {
    let id = "task-example";
    let context = "context-example";
    let push = "push-example";
    let message = Message {
        id: "message-example",
        context: Some(context),
        task: Some(id),
        text: "Grüße 🌱",
        delegation: false,
    };
    [
        Operation::Send(message),
        Operation::Get {
            task: id,
            history: Some(2),
        },
        Operation::List {
            context: None,
            page_size: Some(50),
            page_token: None,
        },
        Operation::SendStream(message),
        Operation::Subscribe { task: id },
        Operation::SetPush(PushRequest {
            task: id,
            id: Some(push),
            url: "https://notifications.example.invalid/report",
        }),
        Operation::GetPush {
            task: id,
            config: push,
        },
        Operation::ListPush { task: id },
        Operation::DeletePush {
            task: id,
            config: push,
        },
        Operation::Cancel { task: id },
    ]
}

fn records() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/parity/a2a/client.json")).unwrap()
}

#[test]
fn outbound_requests_match_sdk_recording_bytes() {
    for (op, fixture) in operations()
        .into_iter()
        .zip(records()["cases"].as_array().unwrap())
    {
        let expected = STANDARD
            .decode(fixture["request"]["bodyBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            op.body("rpc-fixture").unwrap().as_bytes(),
            expected,
            "{}",
            fixture["method"]
        );
    }
}

use std::{
    cell::{Cell, RefCell},
    net::SocketAddr,
    rc::Rc,
    time::{Duration, Instant},
};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use plur1bus_a2a::{
    client::{
        Authorization, Call, Client, Error, Execution, Hop, Limits, Output, Peer, Policy, Purpose,
    },
    endpoint::Window,
    peer_card::{PublicKey, Verified},
};
use plur1bus_wire_fixtures::FakeServer;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::json;
use url::Url;

const KEY: &str = "fixture-a2a";
const KID: &str = "fixture-key";
const DISCOVERY: &str = "/.well-known/agent-card.json";
const ORIGIN: &str = "peer-wire.example.invalid";

fn pair() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ])
    .unwrap()
}

fn public() -> PublicKey {
    PublicKey::parse(&json!({
        "kty": "OKP", "crv": "Ed25519", "x": URL_SAFE_NO_PAD.encode(pair().public_key()),
    }))
    .unwrap()
}

fn origin(addr: SocketAddr) -> String {
    format!("http://{ORIGIN}:{}", addr.port())
}

fn signed_card(address: SocketAddr, endpoint: &str) -> Value {
    let mut card = json!({
        "name":"Public test agent",
        "supportedInterfaces": [{"url": format!("{}{endpoint}", origin(address)),
            "protocolBinding":"JSONRPC", "protocolVersion":"1.0"}],
    });
    let protected =
        URL_SAFE_NO_PAD.encode(json!({"alg":"EdDSA", "kid": KID, "typ":"JWT"}).to_string());
    let payload = URL_SAFE_NO_PAD.encode(plur1bus_canon::canonical_json(&card));
    let sig = pair().sign(format!("{protected}.{payload}").as_bytes());
    card["signatures"] =
        json!([{ "protected": protected, "signature": URL_SAFE_NO_PAD.encode(sig) }]);
    card
}

fn discovery(path: &str, response: Value) -> Value {
    let mut exchange = json!({ "request": { "method": "GET", "path": path } });
    exchange["response"] = response;
    exchange
}

fn operation(response: Value) -> Value {
    let mut exchange = json!({ "request": { "method": "POST", "path": "/rpc" } });
    exchange["response"] = response;
    exchange
}

fn ready_fixture(response: Value) -> FakeServer {
    FakeServer::start_with(|addr| {
        json!({
            "transport": "http", "exchanges": [
                discovery(DISCOVERY, json!({ "status": 200, "body": signed_card(addr, "/rpc") })),
                operation(response),
            ],
        })
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Record {
    Admitted(Purpose),
    CredentialRead,
    Attempted,
    Settled(usize),
    Released,
    Confirmed,
}

struct Grant {
    addr: SocketAddr,
    token: &'static str,
    records: Rc<RefCell<Vec<Record>>>,
}

impl Authorization for Grant {
    fn pin(&self) -> SocketAddr {
        self.addr
    }
    fn bearer(&self) -> Option<&str> {
        self.records.borrow_mut().push(Record::CredentialRead);
        Some(self.token)
    }
    fn mark_attempted(&mut self) {
        self.records.borrow_mut().push(Record::Attempted);
    }
    fn settle(&mut self, bytes: usize) {
        self.records.borrow_mut().push(Record::Settled(bytes));
    }
}

impl Drop for Grant {
    fn drop(&mut self) {
        self.records.borrow_mut().push(Record::Released);
    }
}

struct PolicyFixture {
    addr: SocketAddr,
    token: &'static str,
    records: Rc<RefCell<Vec<Record>>>,
    trust: bool,
    current: Cell<bool>,
    revoke_during_admission: bool,
    permitted: bool,
    local_only: bool,
    cleartext_peer: Option<&'static str>,
    offset_pin: bool,
    custom_pin: Option<SocketAddr>,
}

impl PolicyFixture {
    fn new(addr: SocketAddr) -> Self {
        Self {
            addr,
            token: KEY,
            records: Default::default(),
            trust: true,
            current: Cell::new(true),
            revoke_during_admission: false,
            permitted: true,
            local_only: true,
            cleartext_peer: None,
            offset_pin: false,
            custom_pin: None,
        }
    }
}

impl Policy for PolicyFixture {
    fn current(&self, peer: &Peer, execution: &Execution<'_>) -> bool {
        self.current.get()
            && peer.revision() == "fixture-rev"
            && execution.person == "owner"
            && execution.agent == "origin-agent"
            && execution.session == "session"
            && execution.turn == "turn"
    }
    fn trusted_endpoint(&self, _: &Peer) -> Option<Url> {
        self.trust
            .then(|| Url::parse(&format!("{}/rpc", origin(self.addr))).unwrap())
    }
    fn local_only(&self, _: &str) -> bool {
        self.local_only
    }
    fn allow_cleartext(&self, peer: &Peer) -> bool {
        self.cleartext_peer == Some(peer.id())
    }

    fn confirm_trust(
        &self,
        peer: &Peer,
        card: &Verified,
        _: &Execution<'_>,
        window: Window<'_>,
    ) -> Result<(), Error> {
        assert!(window.active());
        assert_eq!(peer.fingerprint(), card.fingerprint);
        self.records.borrow_mut().push(Record::Confirmed);
        Ok(())
    }
    fn admit(&self, request: Hop<'_>, window: Window<'_>) -> Result<Box<dyn Authorization>, Error> {
        assert!(window.active());
        assert_eq!(request.peer.id(), "sample");
        assert_eq!(request.peer.credential_slot(), Some("a2a/sample/bearer"));
        assert_eq!(request.url.host_str(), Some(ORIGIN));
        if !self.permitted {
            return Err(Error::Denied);
        }
        self.records
            .borrow_mut()
            .push(Record::Admitted(request.purpose));
        if self.revoke_during_admission {
            self.current.set(false);
        }
        let mut addr = self.custom_pin.unwrap_or(self.addr);
        if self.offset_pin {
            addr.set_port(self.addr.port().wrapping_add(1));
        }
        Ok(Box::new(Grant {
            addr,
            token: self.token,
            records: self.records.clone(),
        }))
    }
}

fn peer(addr: SocketAddr) -> Peer {
    Peer::new(
        "sample",
        "fixture-rev",
        &format!("{}{DISCOVERY}", origin(addr)),
        KID,
        public(),
        Some("a2a/sample/bearer"),
    )
    .unwrap()
}

const EXECUTION: Execution<'static> = Execution {
    person: "owner",
    agent: "origin-agent",
    session: "session",
    turn: "turn",
    project: "project",
};

fn call(peer: &Peer) -> Call<'_> {
    Call {
        peer,
        execution: &EXECUTION,
        window: Window {
            deadline: Instant::now() + Duration::from_secs(3),
            canceled: &|| false,
        },
    }
}

fn success_task() -> Value {
    json!({ "id": "task-example", "contextId": "context-example", "status": { "state": "TASK_STATE_COMPLETED" } })
}

fn rpc_response(payload: Value) -> Value {
    let mut response = json!({ "status": 200, "body": { "jsonrpc": "2.0", "id": "rpc-fixture" } });
    response["body"]["result"] = payload;
    response
}

fn error(result: Result<Output<'_>, Error>) -> Error {
    result.err().unwrap()
}

#[test]
fn signed_peer_replays_ten_sdk_operations_over_the_pinned_socket() {
    let records = records();
    let scripts = records["cases"].as_array().unwrap();
    let fixture = FakeServer::start_with(|addr| {
        let mut exchanges = Vec::new();
        for case in scripts {
            exchanges.push(discovery(
                DISCOVERY,
                json!({ "status": 200, "body": signed_card(addr, "/rpc") }),
            ));
            exchanges.push(operation(json!({
                "status": 200, "headers": { "content-type": case["response"]["contentType"] },
                "chunksBase64": case["response"]["chunksBase64"],
            })));
        }
        json!({ "transport":"http", "exchanges":exchanges })
    });
    let policy = PolicyFixture::new(fixture.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let peer = peer(fixture.addr);
    for (op, case) in operations().into_iter().zip(scripts) {
        let response = client.perform(call(&peer), op, "rpc-fixture").unwrap();
        let chunks = case["response"]["chunksBase64"].as_array().unwrap();
        let decoded = chunks.iter().map(|raw| {
            let raw = STANDARD.decode(raw.as_str().unwrap()).unwrap();
            let text = std::str::from_utf8(&raw).unwrap();
            serde_json::from_str::<Value>(text.strip_prefix("data: ").unwrap_or(text).trim_end())
                .unwrap()["result"]
                .clone()
        });
        match response {
            Output::Json(actual) => {
                assert_eq!(actual.provenance.origin.system, "a2a");
                assert_eq!(actual.provenance.origin.principal, peer.id());
                assert_eq!(
                    actual.provenance.origin.trust,
                    plur1bus_providers::provenance::Trust::Untrusted
                );
                assert_eq!([actual.value], decoded.collect::<Vec<_>>().as_slice());
            }
            Output::Stream(mut wire) => {
                let actual: Vec<_> = std::iter::from_fn(|| wire.next_event().unwrap())
                    .map(|event| {
                        assert_eq!(event.provenance.origin.system, "a2a");
                        assert_eq!(
                            event.provenance.origin.trust,
                            plur1bus_providers::provenance::Trust::Untrusted
                        );
                        event.value
                    })
                    .collect();
                assert_eq!(actual, decoded.collect::<Vec<_>>());
            }
        }
    }
    let received = fixture.received();
    assert_eq!(received.len(), 20);
    for ([card, request], expected) in received.as_chunks::<2>().0.iter().zip(scripts) {
        assert_eq!(card["path"], DISCOVERY);
        assert_eq!(card["headers"]["authorization"], "Bearer fixture-a2a");
        assert_eq!(request["path"], expected["request"]["path"]);
        assert_eq!(request["bodyBase64"], expected["request"]["bodyBase64"]);
        for (name, value) in expected["request"]["headers"].as_object().unwrap() {
            assert_eq!(request["headers"][name], *value);
        }
    }
    let recorded = policy.records.borrow();
    assert_eq!(
        recorded
            .iter()
            .filter(|event| matches!(event, Record::Attempted))
            .count(),
        20
    );
    assert_eq!(
        recorded
            .iter()
            .filter(|event| matches!(event, Record::Settled(_)))
            .count(),
        20
    );
    assert_eq!(
        recorded
            .iter()
            .filter(|event| matches!(event, Record::Released))
            .count(),
        20
    );
}

#[test]
fn root_owner_scope_revocation_and_local_only_apply_before_writes() {
    let server = ready_fixture(rpc_response(success_task()));
    let peer = peer(server.addr);
    let op = Operation::Get {
        task: "task-example",
        history: None,
    };
    let mut policy = PolicyFixture::new(server.addr);
    policy.trust = false;
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&peer), op, "rpc-fixture")),
        Error::Untrusted
    );
    let impostor = Execution {
        person: "viewer",
        ..EXECUTION
    };
    assert_eq!(
        error(client.perform(
            Call {
                execution: &impostor,
                ..call(&peer)
            },
            op,
            "rpc-fixture"
        )),
        Error::Revoked
    );
    policy.trust = true;
    policy.permitted = false;
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&peer), op, "rpc-fixture")),
        Error::Denied
    );
    policy.permitted = true;
    policy.offset_pin = true;
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&peer), op, "rpc-fixture")),
        Error::Denied
    );
    policy.offset_pin = false;
    policy.custom_pin = Some(SocketAddr::new(
        "100.100.100.200".parse().unwrap(),
        server.addr.port(),
    ));
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&peer), op, "rpc-fixture")),
        Error::Denied
    );
    policy.custom_pin = None;
    policy.revoke_during_admission = true;
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&peer), op, "rpc-fixture")),
        Error::Revoked
    );
    assert!(server.received().is_empty());
    assert!(!policy.records.borrow().contains(&Record::Attempted));
}

#[test]
fn confirmation_reauthorizes_every_card_hop_and_post_never_follows_a_redirect() {
    let fixture = FakeServer::start_with(|addr| {
        json!({ "transport":"http", "exchanges":[
            discovery(DISCOVERY, json!({ "status": 302, "headers": { "location": "/redirect-card" } })),
            discovery("/redirect-card", json!({ "status": 200, "body": signed_card(addr, "/rpc") })),
            discovery(DISCOVERY, json!({ "status": 200, "body": signed_card(addr, "/rpc") })),
            operation(json!({ "status": 307, "headers": { "location": "/second-rpc" } })),
        ]})
    });
    let policy = PolicyFixture::new(fixture.addr);
    let peer = peer(fixture.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let verified = client.confirm(call(&peer)).unwrap();
    assert_eq!(verified.endpoint.path(), "/rpc");
    assert!(policy.records.borrow().contains(&Record::Confirmed));
    assert_eq!(
        error(client.perform(
            call(&peer),
            Operation::Cancel {
                task: "task-example"
            },
            "rpc-fixture"
        )),
        Error::RequestFailed
    );
    assert_eq!(
        fixture
            .received()
            .iter()
            .map(|v| v["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [DISCOVERY, "/redirect-card", DISCOVERY, "/rpc"]
    );
    assert_eq!(
        policy
            .records
            .borrow()
            .iter()
            .filter(|record| **record == Record::Admitted(Purpose::Card))
            .count(),
        3
    );
    assert_eq!(policy.records.borrow().last(), Some(&Record::Released));
}

#[test]
fn a_changed_signed_endpoint_and_an_off_origin_redirect_leave_post_unsent() {
    let changed = FakeServer::start_with(|addr| {
        json!({ "transport":"http", "exchanges":[
            discovery(DISCOVERY, json!({ "status": 200, "body": signed_card(addr, "/new-rpc") })),
        ]})
    });
    let p = PolicyFixture::new(changed.addr);
    let c = Client::new(&p, Limits::default()).unwrap();
    let op = Operation::Get {
        task: "task-example",
        history: None,
    };
    let registration = peer(changed.addr);
    assert_eq!(
        error(c.perform(call(&registration), op, "rpc-fixture")),
        Error::Untrusted
    );
    assert_eq!(changed.received().len(), 1);
    let redirected = FakeServer::start(&json!({ "transport":"http", "exchanges":[
        discovery(DISCOVERY, json!({ "status": 302, "headers": { "location": "https://other.example.invalid/card" } })),
    ]}));
    let p = PolicyFixture::new(redirected.addr);
    let c = Client::new(&p, Limits::default()).unwrap();
    let registration = peer(redirected.addr);
    assert_eq!(
        error(c.perform(call(&registration), op, "rpc-fixture")),
        Error::Denied
    );
    assert_eq!(redirected.received().len(), 1);
}

#[test]
fn request_cap_precedes_even_discovery_and_decoded_replies_are_bounded() {
    let mut raw = success_task();
    raw["notes"] = json!("x".repeat(250));
    let exact = json!({ "jsonrpc":"2.0", "id":"rpc-fixture", "result": raw });
    let encoded = exact.to_string();
    let chunk = json!({ "status":200, "headers": { "content-type": "application/json" },
        "chunksBase64": [STANDARD.encode(&encoded)] });
    let server = ready_fixture(chunk.clone());
    let policy = PolicyFixture::new(server.addr);
    let peer = peer(server.addr);
    let op = Operation::Get {
        task: "task-example",
        history: None,
    };
    let low = Client::new(
        &policy,
        Limits {
            request_bytes: 10,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(
        error(low.perform(call(&peer), op, "rpc-fixture")),
        Error::TooLarge
    );
    assert!(server.received().is_empty());
    let client = Client::new(
        &policy,
        Limits {
            reply_bytes: encoded.len() - 1,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(
        error(client.perform(call(&peer), op, "rpc-fixture")),
        Error::TooLarge
    );
    let server = ready_fixture(chunk);
    let policy = PolicyFixture::new(server.addr);
    let client = Client::new(
        &policy,
        Limits {
            reply_bytes: encoded.len(),
            ..Limits::default()
        },
    )
    .unwrap();
    let registration = Peer::new(
        "sample",
        "fixture-rev",
        &format!("{}{DISCOVERY}", origin(server.addr)),
        KID,
        public(),
        Some("a2a/sample/bearer"),
    )
    .unwrap();
    assert!(matches!(
        client.perform(call(&registration), op, "rpc-fixture"),
        Ok(Output::Json(_))
    ));
}

#[test]
fn delegation_uses_the_production_envelope_recorded_from_the_typescript_peer_client() {
    let recordings = records();
    let recorded = &recordings["delegation"];
    let bytes = STANDARD
        .decode(recorded["requestBodyBase64"].as_str().unwrap())
        .unwrap();
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    let text = request["params"]["message"]["parts"][0]["text"]
        .as_str()
        .unwrap();
    let operation = Operation::Send(Message {
        id: "message-fixture",
        context: None,
        task: None,
        text,
        delegation: true,
    });
    assert_eq!(operation.body("rpc-fixture").unwrap().as_bytes(), bytes);
    let fixture = ready_fixture(rpc_response(
        json!({ "message": { "role": "ROLE_AGENT", "parts": [{ "text": "Antwort 🌱" }] } }),
    ));
    let p = PolicyFixture::new(fixture.addr);
    let client = Client::new(&p, Limits::default()).unwrap();
    let peer = peer(fixture.addr);
    let Output::Json(result) = client
        .perform(call(&peer), operation, "rpc-fixture")
        .unwrap()
    else {
        panic!("expected JSON")
    };
    assert_eq!(
        result.value["message"]["parts"][0]["text"],
        recorded["answer"]
    );
    assert_eq!(result.provenance.origin.system, recorded["origin"]);
    assert_eq!(recorded["targetKind"], "external");
    assert_eq!(
        result.provenance.origin.trust,
        plur1bus_providers::provenance::Trust::Untrusted
    );
}

#[test]
fn body_wait_uses_the_original_deadline_and_cancel_does_not_retry_a_write() {
    for cancel in [false, true] {
        let body = serde_json::to_vec(&rpc_response(success_task())["body"]).unwrap();
        let fixture = ready_fixture(
            json!({ "status": 200, "headers": { "content-type": "application/json" },
            "chunksBase64": [STANDARD.encode(&body[..1]), STANDARD.encode(&body[1..])], "chunkGapMs": 500 }),
        );
        let policy = PolicyFixture::new(fixture.addr);
        let client = Client::new(&policy, Limits::default()).unwrap();
        let peer = peer(fixture.addr);
        let start = Instant::now();
        let canceled = || cancel && start.elapsed() >= Duration::from_millis(100);
        let window = Window {
            deadline: start + Duration::from_millis(240),
            canceled: &canceled,
        };
        let outcome = client.perform(
            Call {
                window,
                ..call(&peer)
            },
            Operation::Cancel {
                task: "task-example",
            },
            "rpc-fixture",
        );
        assert_eq!(
            error(outcome),
            if cancel {
                Error::Aborted
            } else {
                Error::Deadline
            }
        );
        assert!(
            start.elapsed() < Duration::from_millis(420),
            "a stalled body changed the operation deadline"
        );
        assert_eq!(
            fixture
                .received()
                .iter()
                .filter(|r| r["method"] == "POST")
                .count(),
            1
        );
        let events = policy.records.borrow();
        assert_eq!(events.last(), Some(&Record::Released));
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Record::Settled(_)))
                .count(),
            1
        );
    }
}

fn frame(payload: &Value) -> String {
    format!(
        "data: {}\n\n",
        json!({ "jsonrpc":"2.0", "id":"rpc-fixture", "result":payload })
    )
}

#[test]
fn stream_rejects_wrong_task_and_eof_and_drops_lease_on_cancellation() {
    let expected = frame(
        &json!({ "statusUpdate": { "taskId":"task-example", "contextId":"context-example", "status": { "state":"TASK_STATE_WORKING" } } }),
    );
    let unrelated = frame(
        &json!({ "statusUpdate": { "taskId":"other-task", "contextId":"context-example", "status": { "state":"TASK_STATE_COMPLETED" } } }),
    );
    for mode in ["missing-terminal", "different-task", "canceled"] {
        let mut chunks = vec![STANDARD.encode(&expected)];
        if mode == "different-task" {
            chunks.push(STANDARD.encode(&unrelated));
        }
        let fixture = ready_fixture(
            json!({ "status":200, "headers": { "content-type":"text/event-stream" }, "chunksBase64":chunks }),
        );
        let policy = PolicyFixture::new(fixture.addr);
        let client = Client::new(&policy, Limits::default()).unwrap();
        let peer = peer(fixture.addr);
        let canceled = Cell::new(false);
        let check = || canceled.get();
        let op = Operation::Subscribe {
            task: "task-example",
        };
        let window = Window {
            canceled: &check,
            ..call(&peer).window
        };
        let Output::Stream(mut s) = client
            .perform(
                Call {
                    window,
                    ..call(&peer)
                },
                op,
                "rpc-fixture",
            )
            .unwrap()
        else {
            panic!("expected streaming")
        };
        assert!(s.next_event().unwrap().is_some());
        canceled.set(mode == "canceled");
        assert_eq!(
            s.next_event(),
            Err(if canceled.get() {
                Error::Aborted
            } else {
                Error::RequestFailed
            })
        );
        assert_eq!(s.next_event(), Ok(None));
        assert_eq!(policy.records.borrow().last(), Some(&Record::Released));
    }
}

#[test]
fn logs_hide_credentials_and_peer_diagnostics_and_results_mask_reflections() {
    use std::sync::{Arc, Mutex};

    const MARKER: &str = "synthetic-a2a-diagnostic";
    const TOKEN: &str = "synthetic-a2a-marker=/";
    const BEARER: &str = "synthetic-a2a-marker/=";
    struct Logger(Arc<Mutex<Vec<String>>>);
    impl log::Log for Logger {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }
    let log = Arc::new(Mutex::new(Vec::new()));
    plur1bus_wire_log::install(Logger(log.clone())).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    log::debug!(target: "plur1bus_a2a", "logging control");

    let mut result = success_task();
    let base64 = STANDARD.encode(BEARER);
    result["text"] = json!(format!("{BEARER} {base64} synthetic-a2a-marker%2F%3D"));
    result[BEARER] = json!("do not copy this property");
    let mut response = rpc_response(result);
    response["headers"]["server"] = json!(MARKER);
    let fixture = ready_fixture(response);
    let mut policy = PolicyFixture::new(fixture.addr);
    policy.token = BEARER;
    let peer = peer(fixture.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let op = Operation::Get {
        task: "task-example",
        history: None,
    };
    let Output::Json(result) = client.perform(call(&peer), op, "rpc-fixture").unwrap() else {
        panic!("expected JSON")
    };
    assert_eq!(
        result.value["text"],
        "[REDACTED:secret] [REDACTED:secret] [REDACTED:secret]"
    );
    assert!(result.value.get(BEARER).is_none());
    assert_eq!(
        result.provenance.transformed_by,
        [plur1bus_providers::provenance::Transformation::Redact]
    );
    let messages = log.lock().unwrap().join("\n");
    assert!(messages.contains("logging control"));
    for secret in [MARKER, BEARER, TOKEN] {
        assert!(!messages.contains(secret));
    }
}

#[test]
fn response_mode_rejects_unexpected_coding_and_caps_redaction_expansion() {
    for (token, reply, limit, expected) in [
        (
            KEY,
            json!({ "status":200, "headers": { "content-type":"application/json", "content-encoding":"gzip" }, "body":success_task() }),
            500,
            Error::RequestFailed,
        ),
        (
            "x",
            {
                let mut task = success_task();
                task["notes"] = json!("x".repeat(160));
                rpc_response(task)
            },
            500,
            Error::TooLarge,
        ),
    ] {
        let fixture = ready_fixture(reply);
        let mut policy = PolicyFixture::new(fixture.addr);
        policy.token = token;
        let client = Client::new(
            &policy,
            Limits {
                reply_bytes: limit,
                ..Limits::default()
            },
        )
        .unwrap();
        let peer = peer(fixture.addr);
        assert_eq!(
            error(client.perform(
                call(&peer),
                Operation::Get {
                    task: "task-example",
                    history: None
                },
                "rpc-fixture"
            )),
            expected
        );
    }
}

#[test]
fn json_and_sse_reply_ids_must_match_the_call() {
    let mut response = rpc_response(success_task());
    response["body"]["id"] = json!("previous-call");
    let server = ready_fixture(response);
    let policy = PolicyFixture::new(server.addr);
    let registration = peer(server.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let get = Operation::Get {
        task: "task-example",
        history: None,
    };
    assert_eq!(
        error(client.perform(call(&registration), get, "rpc-fixture")),
        Error::RequestFailed
    );

    let ordinary = frame(&json!({
        "statusUpdate": {"taskId":"task-example","contextId":"context-example","status":{"state":"TASK_STATE_WORKING"}}
    }));
    let mismatched = ordinary.replace("rpc-fixture", "previous-call");
    let server = ready_fixture(json!({
        "status": 200, "headers": {"content-type": "text/event-stream"}, "chunksBase64": [STANDARD.encode(mismatched)]
    }));
    let registration = peer(server.addr);
    let policy = PolicyFixture::new(server.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let subscribe = Operation::Subscribe {
        task: "task-example",
    };
    let Output::Stream(mut stream) = client
        .perform(call(&registration), subscribe, "rpc-fixture")
        .unwrap()
    else {
        panic!("expected SSE")
    };
    assert_eq!(stream.next_event(), Err(Error::RequestFailed));
    assert_eq!(stream.next_event(), Ok(None));
}

#[test]
fn sse_budget_counts_the_combined_length_of_regular_events() {
    let working = frame(&json!({
        "statusUpdate": {"taskId":"task-example","contextId":"context-example","status":{"state":"TASK_STATE_WORKING"}}
    }));
    let completed = frame(&json!({
        "statusUpdate": {"taskId":"task-example","contextId":"context-example","status":{"state":"TASK_STATE_COMPLETED"}}
    }));
    let total = working.len() + completed.len();
    for cap in [total, total - 1] {
        let fixture = ready_fixture(json!({
            "status": 200, "headers": {"content-type": "text/event-stream"},
            "chunksBase64": [STANDARD.encode(&working), STANDARD.encode(&completed)],
        }));
        let registration = peer(fixture.addr);
        let policy = PolicyFixture::new(fixture.addr);
        let client = Client::new(
            &policy,
            Limits {
                reply_bytes: cap,
                ..Limits::default()
            },
        )
        .unwrap();
        let operation = Operation::Subscribe {
            task: "task-example",
        };
        let Output::Stream(mut stream) = client
            .perform(call(&registration), operation, "rpc-fixture")
            .unwrap()
        else {
            panic!("expected SSE")
        };
        if cap == total {
            assert!(stream.next_event().unwrap().is_some());
            assert!(stream.next_event().unwrap().is_some());
        } else {
            let first = stream.next_event();
            let rejection = if matches!(first, Ok(Some(_))) {
                stream.next_event()
            } else {
                first
            };
            assert_eq!(rejection, Err(Error::TooLarge));
        }
        assert_eq!(stream.next_event(), Ok(None));
    }
}

#[test]
fn content_coding_is_checked_even_when_the_body_is_valid_json() {
    let mut response = rpc_response(success_task());
    response["headers"]["content-encoding"] = json!("fixture-format");
    let server = ready_fixture(response);
    let registration = peer(server.addr);
    let policy = PolicyFixture::new(server.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let op = Operation::Get {
        task: "task-example",
        history: None,
    };
    assert_eq!(
        error(client.perform(call(&registration), op, "rpc-fixture")),
        Error::RequestFailed
    );
}

#[test]
fn a_remote_http_pin_is_checked_before_reading_the_bearer() {
    let server = ready_fixture(rpc_response(success_task()));
    let registration = peer(server.addr);
    let mut policy = PolicyFixture::new(server.addr);
    policy.local_only = false;
    policy.custom_pin = Some(SocketAddr::new(
        "192.0.2.4".parse().unwrap(),
        server.addr.port(),
    ));
    // The deliberately different port guarantees the transport cannot dial.
    policy.offset_pin = true;
    let client = Client::new(&policy, Limits::default()).unwrap();
    let op = Operation::Get {
        task: "task-example",
        history: None,
    };
    assert_eq!(
        error(client.perform(call(&registration), op, "rpc-fixture")),
        Error::Denied
    );
    assert!(!policy.records.borrow().contains(&Record::CredentialRead));
    assert!(!policy.records.borrow().contains(&Record::Attempted));
    policy.records.borrow_mut().clear();
    policy.cleartext_peer = Some("another-peer");
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&registration), op, "rpc-fixture")),
        Error::Denied
    );
    assert!(!policy.records.borrow().contains(&Record::CredentialRead));

    policy.records.borrow_mut().clear();
    policy.cleartext_peer = Some("sample");
    let client = Client::new(&policy, Limits::default()).unwrap();
    assert_eq!(
        error(client.perform(call(&registration), op, "rpc-fixture")),
        Error::Denied
    );
    assert!(policy.records.borrow().contains(&Record::CredentialRead));
    assert!(!policy.records.borrow().contains(&Record::Attempted));
    assert!(server.received().is_empty());
}

#[test]
fn a_peer_204_cannot_complete_a_json_rpc_call() {
    let server = ready_fixture(json!({"status":204}));
    let policy = PolicyFixture::new(server.addr);
    let registration = peer(server.addr);
    let client = Client::new(&policy, Limits::default()).unwrap();
    let op = Operation::DeletePush {
        task: "task-example",
        config: "push-example",
    };
    assert_eq!(
        error(client.perform(call(&registration), op, "rpc-fixture")),
        Error::RequestFailed
    );
    assert_eq!(server.received().len(), 2);
    assert_eq!(
        policy
            .records
            .borrow()
            .iter()
            .filter(|r| matches!(r, Record::Settled(_)))
            .count(),
        1
    );
}
