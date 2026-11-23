#![allow(clippy::panic, clippy::unwrap_used, reason = "fixture assertions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_a2a::{
    card::AgentInfo,
    endpoint::{self, Action, Command, Config, Endpoint, Host, Output, Peer, Request, TaskScope},
};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[derive(Default)]
struct FixtureHost {
    calls: Cell<usize>,
    audit: RefCell<Vec<Audit>>,
}

impl Host for FixtureHost {
    fn now_ms(&self) -> u64 {
        0
    }

    fn agent(&self, agent: &str) -> Option<AgentInfo> {
        (agent == "sample").then(|| {
            serde_json::from_value(json!({
                "optIn": true, "displayName": "Example",
            }))
            .unwrap()
        })
    }

    fn task(&self, scope: TaskScope<'_>, op: Command, _: Window<'_>) -> Result<Output, RpcError> {
        assert_eq!(scope.peer, "fixture-reader");
        assert_eq!(scope.agent, "sample");
        self.calls.set(self.calls.get() + 1);
        assert!(matches!(op, Command::Get { ref id, .. } if id == "unassigned"));
        Err(RpcError::TaskNotFound)
    }

    fn audit(&self, event: Audit) {
        self.audit.borrow_mut().push(event);
    }
}

#[test]
fn loopback_endpoint_replays_typescript_wire_bodies_and_security_headers() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/endpoint.json")).unwrap();
    let host = FixtureHost::default();
    let endpoint = Endpoint::new(
        Config {
            base_url: fixture["base"].as_str().unwrap().into(),
            default_agent: Some("sample".into()),
            version: "fixture".into(),
            max_body_bytes: 256,
            ..Config::default()
        },
        vec![Peer::from_bearer(
            "fixture-reader",
            "fixture-only",
            BTreeMap::from([("sample".to_owned(), vec![Action::Card, Action::Read])]),
        )],
    )
    .unwrap();
    for test in fixture["cases"].as_array().unwrap() {
        let request = &test["request"];
        let mut headers = BTreeMap::new();
        if request["auth"] == true {
            headers.insert("authorization".into(), "Bearer fixture-only".into());
        }
        let body = request["body"].as_str();
        if let Some(body) = body {
            headers.insert(
                "content-type".into(),
                request["contentType"].as_str().unwrap().into(),
            );
            headers.insert("content-length".into(), body.len().to_string());
        }
        let called = Cell::new(false);
        let response = endpoint.handle(
            &host,
            Request {
                method: request["method"].as_str().unwrap(),
                path: request["path"].as_str().unwrap(),
                headers: &headers,
                remote: "127.0.0.1",
                window: Window {
                    deadline: Instant::now() + Duration::from_secs(1),
                    canceled: &|| false,
                },
            },
            |limit, _| {
                called.set(true);
                assert_eq!(limit, 256);
                Ok(body.unwrap_or_default().as_bytes().to_vec())
            },
        );
        let expected = &test["expected"];
        assert_eq!(
            response.status,
            expected["status"].as_u64().unwrap() as u16,
            "{}",
            test["name"]
        );
        let endpoint::Body::Text(text) = response.body else {
            panic!("expected JSON")
        };
        assert_eq!(
            text.as_bytes(),
            STANDARD
                .decode(expected["bodyBase64"].as_str().unwrap())
                .unwrap(),
            "{}",
            test["name"]
        );
        for (k, v) in expected["headers"].as_object().unwrap() {
            assert_eq!(
                response.headers.get(k.as_str()).unwrap(),
                v.as_str().unwrap()
            );
        }
        if response.status != 200 || body.is_none() {
            assert!(!called.get(), "{}", test["name"]);
        }
    }
    assert_eq!(host.calls.get(), 1);
}

use plur1bus_a2a::{
    endpoint::{listener_accepts, Audit, EventSource, RpcError, Window},
    events::{self, Role, State, TaskRef},
};
use plur1bus_providers::Json;
use std::{collections::VecDeque, rc::Rc};

const STAMP: &str = "2026-01-01T00:00:00.000Z";
const CONTEXT: &str = "fixture-context";
const HELD: TaskRef<'static> = TaskRef {
    id: "held-task",
    context_id: CONTEXT,
};
const REPLY: &str = "Antwort 🌱";

struct Source {
    events: VecDeque<Json>,
    dropped: Rc<Cell<usize>>,
}
impl EventSource for Source {
    fn next(&mut self, window: Window<'_>) -> Result<Option<Json>, RpcError> {
        assert!(window.active());
        Ok(self.events.pop_front())
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        self.dropped.set(self.dropped.get() + 1);
    }
}

#[derive(Default)]
struct Lifecycle {
    time: Cell<u64>,
    push: RefCell<Option<Json>>,
    canceled: Cell<bool>,
    dropped: Rc<Cell<usize>>,
    audits: RefCell<Vec<Audit>>,
}

impl Lifecycle {
    fn stream(&self, task: TaskRef<'_>, events: Vec<Json>) -> Output {
        Output::Stream {
            task_id: task.id.to_owned(),
            context_id: task.context_id.to_owned(),
            source: Box::new(Source {
                events: events.into(),
                dropped: self.dropped.clone(),
            }),
        }
    }
}

fn with_history(task: TaskRef<'_>, state: State, message: Json) -> Json {
    let mut out = events::task(task, state, STAMP);
    out.set("history", vec![message]);
    out
}
fn held(state: State) -> Json {
    with_history(
        HELD,
        state,
        events::message(HELD, Role::User, "hold", vec![events::text_part("Hold")]),
    )
}

impl Host for Lifecycle {
    fn now_ms(&self) -> u64 {
        self.time.get()
    }
    fn agent(&self, agent: &str) -> Option<AgentInfo> {
        (agent == "sample").then(|| serde_json::from_value(json!({"optIn":true})).unwrap())
    }
    fn audit(&self, event: Audit) {
        self.audits.borrow_mut().push(event);
    }

    fn task(&self, scope: TaskScope<'_>, op: Command, _: Window<'_>) -> Result<Output, RpcError> {
        assert_eq!((scope.peer, scope.agent), ("fixture-owner", "sample"));
        let state = if self.canceled.get() {
            State::Canceled
        } else {
            State::Working
        };
        let result = match op {
            Command::Start(start) => {
                assert_eq!(start.context_id.as_deref(), Some(CONTEXT));
                assert_eq!(start.task_id, None);
                assert!(start.push.is_none());
                let task = match start.message_id.as_str() {
                    "hold" => HELD,
                    "block" => TaskRef {
                        id: "blocked-task",
                        context_id: CONTEXT,
                    },
                    "stream" => TaskRef {
                        id: "streamed-task",
                        context_id: CONTEXT,
                    },
                    _ => panic!("unexpected message"),
                };
                let history =
                    events::message(task, Role::User, &start.message_id, start.message.parts);
                let artifact_id = format!("{}-reply", task.id);
                assert_eq!(
                    start.message.text,
                    match task.id {
                        "held-task" => "Hold",
                        "blocked-task" => "Block",
                        _ => "Stream",
                    }
                );
                if start.stream {
                    return Ok(self.stream(
                        task,
                        vec![
                            with_history(task, State::Submitted, history),
                            events::status(task, State::Working, STAMP, None, false),
                            events::artifact(task, &artifact_id, "reply", REPLY, false, false),
                            events::artifact(task, &artifact_id, "reply", "", true, true),
                            events::status(task, State::Completed, STAMP, None, true),
                        ],
                    ));
                }
                if start.blocking {
                    let mut snapshot = events::task(task, State::Completed, STAMP);
                    snapshot.set(
                        "artifacts",
                        vec![events::reply_artifact(
                            &artifact_id,
                            "reply",
                            vec![events::text_part(REPLY)],
                        )],
                    );
                    snapshot.set(
                        "history",
                        vec![
                            history,
                            events::message(
                                task,
                                Role::Agent,
                                "fixture-reply",
                                vec![events::text_part(REPLY)],
                            ),
                        ],
                    );
                    snapshot
                } else {
                    with_history(task, state, history)
                }
            }
            Command::Get { id, history_length } => {
                assert_eq!(id, HELD.id);
                assert_eq!(history_length, Some(0));
                events::task(HELD, state, STAMP)
            }
            Command::Cancel { id } => {
                assert_eq!(id, HELD.id);
                self.canceled.set(true);
                held(State::Canceled)
            }
            Command::Resubscribe { id } => {
                assert_eq!(id, HELD.id);
                return Ok(self.stream(HELD, vec![events::status(HELD, state, STAMP, None, true)]));
            }
            Command::SetPush { id, config } => {
                assert_eq!(id, HELD.id);
                assert_eq!(
                    config.url.as_str(),
                    "https://callbacks.example.invalid/fixture"
                );
                assert_eq!(config.id.as_deref(), Some("notification-example"));
                let response = Json::parse(r#"{"taskId":"held-task","pushNotificationConfig":{"url":"https://callbacks.example.invalid/fixture","id":"notification-example"}}"#).unwrap();
                self.push.replace(Some(response.clone()));
                response
            }
            Command::GetPush { id, config_id } => {
                assert_eq!(id, HELD.id);
                assert_eq!(config_id.as_deref(), Some("notification-example"));
                self.push.borrow().clone().unwrap()
            }
            Command::ListPush { id } => {
                assert_eq!(id, HELD.id);
                vec![self.push.borrow().clone().unwrap()].into()
            }
            Command::DeletePush { id, config_id } => {
                assert_eq!(id, HELD.id);
                assert_eq!(config_id, "notification-example");
                self.push.replace(None);
                Json::Null
            }
        };
        Ok(Output::Json(result))
    }
}

fn lifecycle_endpoint(config: Config) -> Endpoint {
    Endpoint::new(
        config,
        vec![Peer::from_bearer(
            "fixture-owner",
            "fixture-turn",
            BTreeMap::from([(
                "sample".to_owned(),
                vec![
                    Action::Card,
                    Action::Send,
                    Action::Read,
                    Action::Cancel,
                    Action::Push,
                ],
            )]),
        )],
    )
    .unwrap()
}

fn active() -> Window<'static> {
    Window {
        deadline: Instant::now() + Duration::from_secs(2),
        canceled: &|| false,
    }
}

fn pull(
    method: &str,
    params: &Value,
    endpoint: &Endpoint,
    host: &Lifecycle,
    window: Window<'_>,
) -> endpoint::Response {
    let fields = BTreeMap::from([
        ("content-type".into(), "application/json".into()),
        ("authorization".into(), "Bearer fixture-turn".into()),
    ]);
    let raw = json!({ "jsonrpc":"2.0", "id":"lifecycle-rpc", "method":method, "params":params })
        .to_string();
    endpoint.handle(
        host,
        Request {
            method: "POST",
            path: "/a2a/sample/",
            headers: &fields,
            remote: "127.0.0.1",
            window,
        },
        |_, _| Ok(raw.into_bytes()),
    )
}

#[test]
fn turn_stream_status_cancel_and_push_replay_the_typescript_http_server() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/lifecycle.json")).unwrap();
    let host = Lifecycle::default();
    let server = lifecycle_endpoint(Config::default());
    for test in fixture["cases"].as_array().unwrap() {
        let method = test["method"].as_str().unwrap();
        let response = pull(method, &test["params"], &server, &host, active());
        assert_eq!(response.status, 200);
        assert_eq!(
            response.headers["content-type"],
            test["expected"]["contentType"].as_str().unwrap()
        );
        let actual = match response.body {
            endpoint::Body::Text(text) => text,
            endpoint::Body::Stream(mut stream) => {
                let before = host.dropped.get();
                let mut wire = String::new();
                loop {
                    let frame = stream.next_frame(active()).unwrap().unwrap();
                    let closing = frame.contains(r#""final":true"#);
                    wire.push_str(&frame);
                    if closing {
                        assert_eq!(host.dropped.get(), before + 1);
                        assert!(stream.next_frame(active()).unwrap().is_none());
                        break;
                    }
                }
                wire
            }
        };
        assert_eq!(
            actual.as_bytes(),
            STANDARD
                .decode(test["expected"]["rawBase64"].as_str().unwrap())
                .unwrap(),
            "{method}"
        );
    }
    assert!(host.canceled.get());
    assert!(host.push.borrow().is_none());
    assert_eq!(host.dropped.get(), 2);
}

#[test]
fn stream_disconnect_releases_subscription_and_preserves_the_original_deadline() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/a2a/lifecycle.json")).unwrap();
    let input = fixture["cases"].as_array().unwrap().last().unwrap();
    let host = Lifecycle::default();
    let endpoint = lifecycle_endpoint(Config::default());
    let response = pull(
        "message/stream",
        &input["params"],
        &endpoint,
        &host,
        active(),
    );
    let endpoint::Body::Stream(mut stream) = response.body else {
        panic!("expected SSE")
    };
    assert!(stream.next_frame(active()).unwrap().is_some());
    let canceled = Window {
        canceled: &|| true,
        ..active()
    };
    assert!(stream.next_frame(canceled).unwrap().is_none());
    assert_eq!(host.dropped.get(), 1);
    assert!(!host.canceled.get());
    let deadline = Instant::now() + Duration::from_millis(30);
    let response = pull(
        "message/stream",
        &input["params"],
        &endpoint,
        &host,
        Window {
            deadline,
            ..active()
        },
    );
    let endpoint::Body::Stream(mut stream) = response.body else {
        panic!("expected SSE")
    };
    std::thread::sleep(
        deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
    );
    assert!(stream.next_frame(active()).unwrap().is_none());
    assert_eq!(host.dropped.get(), 2);
}

#[test]
fn loopback_host_and_early_body_gates_refuse_without_reading() {
    let local = "127.0.0.1".parse().unwrap();
    assert!(listener_accepts(
        local,
        4210,
        "localhost:4210",
        "/a2a/sample/"
    ));
    assert!(!listener_accepts(
        local,
        4210,
        "host.example.invalid:4210",
        "/a2a/sample/"
    ));
    assert!(!listener_accepts(
        local,
        4210,
        "localhost:4210",
        "http://localhost:4210/a2a/sample/"
    ));
    assert!(!listener_accepts(
        "192.0.2.1".parse().unwrap(),
        4210,
        "localhost:4210",
        "/a2a/sample/"
    ));
    let host = Lifecycle::default();
    let endpoint = lifecycle_endpoint(Config {
        max_body_bytes: 8,
        ..Config::default()
    });
    for (auth, expected) in [("Bearer unknown", 401), ("Bearer fixture-turn", 413)] {
        let fields = BTreeMap::from([
            ("authorization".into(), auth.into()),
            ("content-type".into(), "application/json".into()),
            ("content-length".into(), "9".into()),
        ]);
        let response = endpoint.handle(
            &host,
            Request {
                method: "POST",
                path: "/a2a/sample/",
                headers: &fields,
                remote: "127.0.0.1",
                window: active(),
            },
            |_, _| panic!("must not read"),
        );
        assert_eq!(response.status, expected);
    }
    let fields = BTreeMap::from([
        ("authorization".into(), "Bearer fixture-turn".into()),
        ("content-type".into(), "application/json".into()),
    ]);
    let response = endpoint.handle(
        &host,
        Request {
            method: "POST",
            path: "/a2a/sample/",
            headers: &fields,
            remote: "127.0.0.1",
            window: active(),
        },
        |limit, _| {
            assert_eq!(limit, 8);
            Ok(vec![b'a'; 9])
        },
    );
    assert_eq!(response.status, 413);
}

#[test]
fn rate_buckets_distinguish_address_peer_and_auth_and_preserve_partial_refill() {
    let host = Lifecycle::default();
    let endpoint = lifecycle_endpoint(Config {
        peer_per_minute: 2,
        address_per_minute: 20,
        failed_auth_per_minute: 1,
        ..Config::default()
    });
    let request = |remote, bearer: &str| {
        let fields = BTreeMap::from([("authorization".into(), format!("Bearer {bearer}"))]);
        endpoint.handle(
            &host,
            Request {
                method: "GET",
                path: "/a2a/sample/.well-known/agent-card.json",
                headers: &fields,
                remote,
                window: active(),
            },
            |_, _| panic!("card never reads body"),
        )
    };
    assert_eq!(request("127.0.0.1", "fixture-turn").status, 200);
    assert_eq!(request("127.0.0.2", "fixture-turn").status, 200);
    host.time.set(15_000);
    let hold = request("127.0.0.1", "fixture-turn");
    assert_eq!(hold.status, 429);
    assert_eq!(hold.headers["retry-after"], "15");
    host.time.set(30_000);
    assert_eq!(request("127.0.0.1", "fixture-turn").status, 200);
    assert_eq!(request("127.0.0.3", "other").status, 401);
    assert_eq!(request("127.0.0.3", "fixture-turn").status, 429);
    assert!(host.audits.borrow().contains(&Audit::RatePeer));
    assert!(host.audits.borrow().contains(&Audit::RateAuth));
    let one = lifecycle_endpoint(Config {
        address_per_minute: 1,
        ..Config::default()
    });
    let fields = BTreeMap::new();
    let unauth = || {
        one.handle(
            &host,
            Request {
                method: "GET",
                path: "/a2a/sample/.well-known/agent-card.json",
                headers: &fields,
                remote: "127.0.0.4",
                window: active(),
            },
            |_, _| panic!("card never reads body"),
        )
    };
    assert_eq!(unauth().status, 401);
    assert_eq!(unauth().status, 429);
    assert!(host.audits.borrow().contains(&Audit::RateAddress));
}

#[test]
fn http_entrypoint_rejects_other_authorities_and_rpc_diagnostics_bound_echoed_ids() {
    let checked = "127.0.0.1:4210".parse().unwrap();
    let host = Lifecycle::default();
    let endpoint = lifecycle_endpoint(Config::default());
    let request_headers = |authority: &str| {
        BTreeMap::from([
            ("host".into(), authority.into()),
            ("authorization".into(), "Bearer fixture-turn".into()),
            ("content-type".into(), "application/json".into()),
        ])
    };
    let request = |headers| Request {
        method: "POST",
        path: "/a2a/sample/",
        headers,
        remote: "127.0.0.1",
        window: active(),
    };
    let other_headers = request_headers("other.example.invalid:4210");
    let local_headers = request_headers("localhost:4210");
    let other = endpoint.handle_http(checked, &host, request(&other_headers), |_, _| {
        panic!("must not read body for another authority")
    });
    assert_eq!(other.status, 421);
    let unsupported_marker = "synthetic-unsupported-part";
    for n in [128, 129] {
        let id = "i".repeat(n);
        let raw = json!({ "jsonrpc":"2.0", "id":id, "method":"message/send",
            "params":{"message":{"messageId":"example","role":"user","parts":[{"kind":unsupported_marker}]}}
        }).to_string();
        let response = endpoint.handle_http(checked, &host, request(&local_headers), |_, _| {
            Ok(raw.into_bytes())
        });
        let endpoint::Body::Text(body) = response.body else {
            panic!("expected JSON")
        };
        assert!(!body.contains(unsupported_marker));
        let value: Value = serde_json::from_str(&body).unwrap();
        if n == 128 {
            assert_eq!(value["id"], id);
            assert_eq!(value["error"]["code"], -32005);
        } else {
            assert!(value["id"].is_null());
            assert_eq!(value["error"]["code"], -32600);
        }
    }
}
