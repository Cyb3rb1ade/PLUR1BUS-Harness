use super::*;
use crate::{
    rbac::types::{Principal, PrincipalKind, Role},
    sessions::{
        Clock, CreateSessionInput, IdSource, ListFilter, RewindInput, RewindTarget, RewindTrigger,
        SessionKind,
    },
};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc,
    },
};

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}
struct Ids(AtomicUsize);
impl IdSource for Ids {
    fn next_id(&self) -> String {
        (self.0.fetch_add(1, Ordering::Relaxed) + 1).to_string()
    }
}
struct Rig {
    clock: Arc<TestClock>,
    enabled: Cell<bool>,
    allowed: Cell<bool>,
    log_ok: Cell<bool>,
    narrow_during_recall: Cell<bool>,
    receipts: RefCell<Vec<Value>>,
    effects: RefCell<Vec<Value>>,
    config: RefCell<Value>,
}
impl Default for Rig {
    fn default() -> Self {
        Self {
            clock: Arc::new(TestClock(AtomicI64::new(10_000))),
            enabled: Cell::new(true),
            allowed: Cell::new(true),
            log_ok: Cell::new(true),
            narrow_during_recall: Cell::new(false),
            receipts: RefCell::new(Vec::new()),
            effects: RefCell::new(Vec::new()),
            config: RefCell::new(json!({})),
        }
    }
}
impl Runtime for Rig {
    fn current(&self, subject: &Subject) -> Option<Subject> {
        self.enabled.get().then(|| subject.clone())
    }
    fn now(&self) -> i64 {
        self.clock.now()
    }
    fn agent_active(&self, agent: &str) -> bool {
        matches!(agent, "a" | "b")
    }
    fn provider_ready(&self, _: &str, _: Audience) -> bool {
        self.allowed.get()
    }
    fn config(&self) -> Value {
        self.config.borrow().clone()
    }
    fn audit(&self, _: AuditEvent) -> bool {
        self.log_ok.get()
    }
    fn notify(&self, event: &EventRecord, _: &SessionRecord) {
        self.receipts
            .borrow_mut()
            .push(json!([event.kind, event.seq]));
    }
}
impl Memory for Rig {
    fn recall(
        &self,
        scope: &MemoryScope<'_>,
        granted: ScopeAccess,
        query: &str,
        _: &AbortSignal,
    ) -> Option<String> {
        assert!(granted.workspace && granted.agent_private);
        self.effects.borrow_mut().push(json!([
            "recall",
            scope.audience,
            scope.agent_id,
            scope.session_id,
            scope.turn_id,
            scope.principal.principal.user_id,
            query
        ]));
        if self.narrow_during_recall.get() {
            assert!(granted.user);
            self.config.replace(
                json!({"agents":{"a":{"memoryExposure":{"mcp":{"recall":{"user":false}}}}}}),
            );
        }
        Some("scoped fixture memory".into())
    }
    fn capture(&self, scope: &MemoryScope<'_>, question: &str, answer: &str) {
        self.effects.borrow_mut().push(
            json!(["capture",scope.audience,scope.agent_id,scope.session_id,scope.turn_id,
            scope.principal.principal.user_id,{"question":question,"answer":answer}]),
        );
    }
}

fn store(rig: &Rig) -> SessionStore {
    SessionStore::open_memory(rig.clock.clone(), Arc::new(Ids(AtomicUsize::new(0)))).unwrap()
}
fn subject(audience: Audience) -> Subject {
    let mut who = Principal::new("person-a", Role::Owner);
    who.kind = Some(PrincipalKind::Person);
    Subject {
        exposure: ExposurePrincipal {
            principal: who,
            token_id: Some("fixture-caller".into()),
            binding: None,
        },
        audience: Some(audience),
        local_human: false,
    }
}
fn target(row: &Value) -> Target<'_> {
    Target {
        session_id: row["sessionId"].as_str(),
        turn_id: row["turnId"].as_str(),
        agent_id: row["agentId"].as_str(),
        audience: serde_json::from_value(row["audience"].clone()).unwrap(),
        token_id: row["tokenId"].as_str(),
    }
}
fn result(r: Result<Value, Error>) -> Value {
    r.unwrap_or_else(|e| json!(e))
}
fn begin() -> Start<'static> {
    Start {
        target: Target {
            agent_id: Some("a"),
            audience: Some(Audience::Mcp),
            ..Default::default()
        },
        message: "hello",
        attachments: &[],
    }
}

#[test]
fn external_turns_replay_typescript_session_store_and_provider_boundary() {
    let f: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/external-turn/turn.json"
    ))
    .unwrap();
    for row in f {
        let name = row["name"].as_str().unwrap();
        let rig = Rig::default();
        rig.allowed.set(name != "unavailable");
        let mut store = store(&rig);
        let mut service = Service::new(&mut store);
        let mut who = subject(serde_json::from_value(row["audience"].clone()).unwrap());
        if name == "bound" {
            who.exposure.binding = Some(crate::exposure::types::TokenBinding {
                agent_id: "a".into(),
                ..Default::default()
            });
        }
        let ports = Ports {
            runtime: &rig,
            memory: &rig,
        };
        let mut requests = Vec::new();
        for op in row["ops"].as_array().unwrap() {
            let input = &op["input"];
            let method = op["method"].as_str().unwrap();
            let actual = match method {
                "start" => {
                    let params = Start {
                        target: target(input),
                        message: input["message"].as_str().unwrap(),
                        attachments: &[],
                    };
                    match service.start(&params, &who, &ports) {
                        Err(e) => json!(e),
                        Ok(started) => {
                            let work = service.prepare(started.ticket(), &ports).unwrap();
                            requests.push(json!(work));
                            if name == "provider failure" {
                                service
                                    .finish(started.ticket(), Completion::Failed, &ports)
                                    .unwrap()
                            } else {
                                service
                                    .record(started.ticket(), Chunk::Delta("Hello "), &ports)
                                    .unwrap();
                                if matches!(name, "busy" | "cancel") {
                                    started.running()
                                } else {
                                    service
                                        .record(started.ticket(), Chunk::Delta("fixture"), &ports)
                                        .unwrap();
                                    service
                                        .record(
                                            started.ticket(),
                                            Chunk::Usage {
                                                input: 10,
                                                output: 4,
                                            },
                                            &ports,
                                        )
                                        .unwrap();
                                    service
                                        .finish(started.ticket(), Completion::Completed, &ports)
                                        .unwrap()
                                }
                            }
                        }
                    }
                }
                "rewind" => {
                    let now = input["now"].as_i64().unwrap();
                    rig.clock.0.store(now, Ordering::Relaxed);
                    service
                        .store
                        .rewind_path(
                            input["sessionId"].as_str().unwrap(),
                            RewindInput {
                                to: RewindTarget::Seq(0),
                                lesson: "Keep the reply concise.".into(),
                                actor: "person-a".into(),
                                trigger: RewindTrigger::User,
                                expected_event_seq: None,
                                audit: None,
                                command_turn_id: None,
                                reservation: None,
                            },
                        )
                        .unwrap();
                    continue;
                }
                "events" => result(service.events(
                    &target(input),
                    input["afterSeq"].as_i64().unwrap(),
                    input["limit"].as_i64().unwrap(),
                    &who,
                    &ports,
                )),
                "get" => {
                    result(service.get(&target(input), input["messages"].as_i64(), &who, &ports))
                }
                "cancel" => result(service.cancel(&target(input), &who, &ports)),
                _ => panic!("unknown method"),
            };
            let mut want = op["result"].clone();
            if row["divergence"] == "fixed-provider-error" {
                if method == "start" {
                    want["error"] = json!("provider-failed");
                }
                if method == "events" {
                    want["events"][1]["data"]["error"] = json!("provider-failed");
                }
            }
            assert_eq!(actual, want, "{name}: {method}");
        }
        assert_eq!(json!(requests), row["requests"], "{name}");
        assert_eq!(
            json!(rig.receipts.into_inner()),
            row["deliveries"],
            "{name}"
        );
        assert_eq!(json!(rig.effects.into_inner()), row["memory"], "{name}");
    }
}

#[test]
fn scope_assertions_are_checked_against_live_identity_before_effects() {
    let rig = Rig::default();
    let mut store = store(&rig);
    let mut service = Service::new(&mut store);
    let who = subject(Audience::Mcp);
    let ports = Ports {
        runtime: &rig,
        memory: &rig,
    };
    for (target, reason) in [
        (
            Target {
                agent_id: Some("a"),
                token_id: Some("untrusted-assertion"),
                ..Default::default()
            },
            "token-mismatch",
        ),
        (
            Target {
                agent_id: Some("a"),
                audience: Some(Audience::A2a),
                ..Default::default()
            },
            "audience-mismatch",
        ),
    ] {
        assert_eq!(
            service
                .start(&Start { target, ..begin() }, &who, &ports)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some(reason)
        );
    }
    rig.log_ok.set(false);
    assert_eq!(
        service
            .start(&begin(), &who, &ports)
            .err()
            .unwrap()
            .reason
            .as_deref(),
        Some("audit-unavailable")
    );
    assert!(service
        .store
        .list_sessions(&ListFilter {
            owner: "ext:mcp:fixture-caller".into(),
            ..Default::default()
        })
        .unwrap()
        .sessions
        .is_empty());
    rig.log_ok.set(true);
    let first = service.start(&begin(), &who, &ports).unwrap();
    let mut other = who.clone();
    other.exposure.token_id = Some("different-authenticated-caller".into());
    let target = Target {
        session_id: Some(&first.session_id),
        ..Default::default()
    };
    assert_eq!(
        service
            .get(&target, Some(5), &other, &ports)
            .unwrap_err()
            .code,
        "E_NOT_FOUND"
    );
    let work = service.prepare(first.ticket(), &ports).unwrap();
    assert!(service.prepare(first.ticket(), &ports).is_err());
    rig.enabled.set(false);
    assert!(service
        .record(first.ticket(), Chunk::Delta("late output"), &ports)
        .is_err());
    assert!(work.signal.is_aborted());
    assert!(service
        .finish(first.ticket(), Completion::Completed, &ports)
        .is_err());
    assert_eq!(rig.effects.borrow().len(), 1);
}

#[test]
fn no_provider_attachments_internal_sessions_memory_scope_and_timeout_are_refused() {
    let rig = Rig::default();
    let mut store = store(&rig);
    let internal = store
        .create_session(&CreateSessionInput::new(SessionKind::Direct, "a", "local"))
        .unwrap();
    let mut service = Service::new(&mut store);
    let ports = Ports {
        runtime: &rig,
        memory: &rig,
    };
    let who = subject(Audience::Mcp);
    let mut owner = who.clone();
    owner.exposure.token_id = None;
    owner.audience = None;
    owner.local_human = true;
    let target = Target {
        session_id: Some(&internal.id),
        audience: Some(Audience::Mcp),
        ..Default::default()
    };
    assert_eq!(
        service.cancel(&target, &owner, &ports).unwrap_err().code,
        "E_NOT_FOUND"
    );
    rig.allowed.set(false);
    assert_eq!(
        service
            .start(&begin(), &who, &ports)
            .err()
            .unwrap()
            .reason
            .as_deref(),
        Some("no-provider")
    );
    assert!(service
        .store
        .list_sessions(&ListFilter {
            owner: "ext:mcp:fixture-caller".into(),
            ..Default::default()
        })
        .unwrap()
        .sessions
        .is_empty());
    rig.allowed.set(true);
    let attachments = ["opaque-fixture".to_owned()];
    assert!(service
        .start(
            &Start {
                attachments: &attachments,
                ..begin()
            },
            &who,
            &ports
        )
        .is_err());
    rig.config.replace(json!({"agents":{"a":{"memoryExposure":{"mcp":{"recall":{"agentPrivate":false},"capture":false}}}}}));
    let started = service.start(&begin(), &who, &ports).unwrap();
    let work = service.prepare(started.ticket(), &ports).unwrap();
    assert!(work.memory.is_empty());
    assert!(rig.effects.borrow().is_empty());
    rig.clock.0.store(10_000 + 300_000, Ordering::Relaxed);
    assert!(service
        .record(started.ticket(), Chunk::Delta("late output"), &ports)
        .is_err());
    assert!(work.signal.is_aborted());
    assert!(rig.effects.borrow().is_empty());
}

#[test]
fn memory_narrowing_and_stored_terminal_state_win_during_work() {
    let rig = Rig::default();
    let mut store = store(&rig);
    let mut service = Service::new(&mut store);
    let ports = Ports {
        runtime: &rig,
        memory: &rig,
    };
    let who = subject(Audience::Mcp);
    rig.narrow_during_recall.set(true);
    let started = service.start(&begin(), &who, &ports).unwrap();
    let work = service.prepare(started.ticket(), &ports).unwrap();
    assert!(work.memory.is_empty());
    assert_eq!(rig.effects.borrow().len(), 1);
    service
        .store
        .fail_turn(&started.turn_id, "fixture-closed", None)
        .unwrap();
    assert!(service
        .record(started.ticket(), Chunk::Delta("finished elsewhere"), &ports)
        .is_err());
    assert!(work.signal.is_aborted());
    assert!(service.active.is_empty());
}

#[test]
fn external_turns_share_exact_session_schema_and_reopen_both_ways() {
    let tmp = tempfile::tempdir().unwrap();
    let ts = tmp.path().join("typescript.sqlite");
    let rust = tmp.path().join("rust.sqlite");
    let driver = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/core-parity/k6c-external-driver.ts");
    let invoke = |mode: &str, path: &std::path::Path, session: Option<&str>| {
        let mut command = std::process::Command::new("node");
        command
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(&driver)
            .arg(mode)
            .arg(path);
        if let Some(session) = session {
            command.arg(session);
        }
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice::<Value>(&result.stdout).unwrap()
    };
    let first = invoke("seed", &ts, None);
    let session = first["outcome"]["sessionId"].as_str().unwrap();
    assert_eq!(first["outcome"]["reply"], "TS result");
    assert_eq!(first["integrity"], "ok");

    let rig = Rig::default();
    let ports = Ports {
        runtime: &rig,
        memory: &rig,
    };
    let who = subject(Audience::Mcp);
    let mut result_sessions = Vec::new();
    for (path, existing) in [(&ts, Some(session)), (&rust, None)] {
        let mut store =
            SessionStore::open(path, rig.clock.clone(), Arc::new(Ids(AtomicUsize::new(0))))
                .unwrap();
        let mut service = Service::new(&mut store);
        let params = Start {
            target: Target {
                session_id: existing,
                ..begin().target
            },
            message: "Rust request",
            attachments: &[],
        };
        let started = service.start(&params, &who, &ports).unwrap();
        let work = service.prepare(started.ticket(), &ports).unwrap();
        if existing.is_some() {
            assert!(work
                .messages
                .iter()
                .any(|message| message.text == "TS result"));
        }
        service
            .record(started.ticket(), Chunk::Delta("Rust result"), &ports)
            .unwrap();
        service
            .finish(started.ticket(), Completion::Completed, &ports)
            .unwrap();
        result_sessions.push(started.session_id);
    }
    for (path, id) in [(&ts, &result_sessions[0]), (&rust, &result_sessions[1])] {
        let read = invoke("read", path, Some(id));
        assert_eq!(read["version"], first["version"]);
        assert_eq!(read["schema"], first["schema"]);
        assert_eq!(read["integrity"], "ok");
        assert_eq!(
            read["outcome"]["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["text"],
            "Rust result"
        );
    }
}

#[test]
fn dispatch_ticket_scope_and_output_bound_are_independent() {
    let rig = Rig::default();
    let mut first_store = store(&rig);
    let mut second_store = store(&rig);
    let mut first = Service::new(&mut first_store);
    let mut second = Service::new(&mut second_store);
    let ports = Ports {
        runtime: &rig,
        memory: &rig,
    };

    let mut who = subject(Audience::Mcp);
    who.exposure.binding = Some(crate::exposure::types::TokenBinding {
        agent_id: "a".into(),
        ..Default::default()
    });
    let away = Start {
        target: Target {
            agent_id: Some("b"),
            ..Default::default()
        },
        ..begin()
    };
    assert_eq!(
        first
            .start(&away, &who, &ports)
            .err()
            .unwrap()
            .reason
            .as_deref(),
        Some("agent-mismatch")
    );
    let own = first.start(&begin(), &who, &ports).unwrap();
    let other = second.start(&begin(), &who, &ports).unwrap();
    assert_eq!(own.turn_id, other.turn_id);
    assert!(second.prepare(own.ticket(), &ports).is_err());
    assert!(rig.effects.borrow().is_empty());
    let work = second.prepare(other.ticket(), &ports).unwrap();
    assert!(second
        .record(
            other.ticket(),
            Chunk::Delta(&"a".repeat(MAX_REPLY + 1)),
            &ports
        )
        .is_err());
    assert!(work.signal.is_aborted());
    let params = Target {
        session_id: Some(&other.session_id),
        ..Default::default()
    };
    let events = second.events(&params, 0, 20, &who, &ports).unwrap();
    assert_eq!(events["events"][1]["type"], "turn.failed");
    assert_eq!(events["events"][1]["data"]["error"], "output-limit");
    assert_eq!(events["running"], false);
    assert!(second
        .events(&params, 0, MAX_EVENTS + 1, &who, &ports)
        .is_err());
}
