use super::*;
use crate::rbac::audit::AuditEvent;
use crate::rbac::types::{PrincipalKind, Role};
use crate::toolcall::json::{parse, V};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

const NOW: i64 = 200;

struct Time;
impl Clock for Time {
    fn now(&self) -> i64 {
        NOW
    }
}

struct Ids(AtomicUsize);
impl IdSource for Ids {
    fn next_id(&self) -> String {
        format!("runner-{}", self.0.fetch_add(1, Ordering::Relaxed))
    }
}

fn person() -> Principal {
    Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new("ada", Role::Owner)
    }
}

struct Fixture<'a> {
    name: &'a str,
    rows: RefCell<Vec<V>>,
    lost: Cell<bool>,
}

fn session(value: &V) -> &V {
    value.get("session").unwrap()
}

impl Source for Fixture<'_> {
    fn current_person(&self, owner: &str) -> Option<Principal> {
        (owner == "ada" && self.name != "lost identity" && !self.lost.get()).then(person)
    }
    fn sessions(
        &self,
        _: &Target,
        _: Window,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<V>, Error> {
        if self.name == "source unavailable" {
            return Err(Error::Source);
        }
        Ok(self
            .rows
            .borrow()
            .iter()
            .skip(offset)
            .take(limit)
            .map(|t| session(t).clone())
            .collect())
    }
    fn may_read_target(&self, _target: &Target, _who: &Principal) -> bool {
        true
    }

    fn may_read(&self, _: &Target, _: &V, _: &Principal) -> bool {
        !self.lost.get()
    }
    fn transcript(&self, row: &V, _: Window) -> Result<V, Error> {
        self.rows
            .borrow()
            .iter()
            .find(|t| {
                session(t)
                    .get("id")
                    .unwrap()
                    .deep_equal(row.get("id").unwrap())
            })
            .cloned()
            .ok_or(Error::Source)
    }
}

struct ModelFixture<'a> {
    name: &'a str,
    attempt: usize,
    calls: Vec<Value>,
    revoke: Option<&'a Cell<bool>>,
}
impl Model for ModelFixture<'_> {
    fn route(&self, _: &Target, _: Stage) -> Result<Route, Error> {
        Ok(Route::Local)
    }
    fn complete(&mut self, route: Route, r: ModelRequest<'_>) -> Result<ModelResult, Error> {
        assert!(route == Route::Local && !r.abort.is_aborted());
        let data: Value = serde_json::from_str(r.data).unwrap();
        self.calls.push(json!({"stage":r.stage.as_str(),"modelClass":r.stage.model_class(),"maxOutputTokens":r.max_output_tokens,"data":data}));
        if self.name == "provider failure"
            || matches!(self.name, "resume" | "digest changed") && self.attempt == 0
        {
            return Err(Error::ProviderFailed);
        }
        if let Some(lost) = self.revoke {
            lost.set(true);
        }
        let id = data["data"]["messages"][0]["id"].as_str().unwrap();
        let text = if self.name == "invalid output" {
            "{invalid".into()
        } else {
            json!([{"kind":"knowledge","change":"add","text":"Scoped fixture observation","contentKey":"fixture","evidence":[{"source":"message","id":id}]}]).to_string()
        };
        Ok(ModelResult {
            text,
            model: "fixture-small".into(),
            input_tokens: if self.name == "unmeasured response" {
                -1
            } else {
                5
            },
            output_tokens: 2,
        })
    }
}

#[derive(Default)]
struct Counts(Vec<Value>);
impl Notice for Counts {
    fn finished(&mut self, _: &Run, pending: usize, waiting: usize) {
        self.0.push(json!({"pending":pending,"waitingH3":waiting}));
    }
}

fn probed_model_attempt(
    route: Route,
    local_only: bool,
    max_tokens: i64,
) -> (Run, usize, Vec<String>) {
    struct Probe {
        route: Route,
        calls: usize,
    }
    impl Model for Probe {
        fn route(&self, _: &Target, _: Stage) -> Result<Route, Error> {
            Ok(self.route)
        }

        fn complete(&mut self, _: Route, _: ModelRequest<'_>) -> Result<ModelResult, Error> {
            self.calls += 1;
            Err(Error::ProviderFailed)
        }
    }

    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/runs.json"
    ))
    .unwrap();
    let row = fixture
        .iter()
        .find(|row| row["name"] == "completed")
        .unwrap();
    let mut config: Config = serde_json::from_value(row["config"].clone()).unwrap();
    config.local_only = local_only;
    config.max_tokens = max_tokens;
    let source = Fixture {
        name: "model admission",
        rows: RefCell::new(
            parse(row["snapshot"].as_str().unwrap())
                .unwrap()
                .as_arr()
                .unwrap()
                .to_vec(),
        ),
        lost: Cell::new(false),
    };
    let target = Target {
        scope: "agent".into(),
        owner: "ada".into(),
        agent_id: "alpha".into(),
        project_id: None,
    };
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    let mut model = Probe { route, calls: 0 };
    let mut events = Vec::new();
    let result = run(
        &Request {
            target: &target,
            who: &person(),
            window: Window { from: 1, to: 101 },
            config: &config,
            abort: &AbortSignal::new(),
        },
        &mut Ports {
            store: &store,
            source: &source,
            model: &mut model,
            read: None,
            cards: None,
            notice: None,
            clock: &Time,
            ids: &Ids(AtomicUsize::new(0)),
            audit: &mut |event: &AuditEvent| {
                events.push(event.action.clone());
                Ok(())
            },
        },
    )
    .unwrap();
    (result, model.calls, events)
}

#[test]
fn local_only_learning_never_sends_the_transcript_to_a_remote_route() {
    let (result, calls, audit) = probed_model_attempt(Route::Remote, true, 100_000);
    assert_eq!(calls, 0);
    assert!(audit.is_empty());
    assert_eq!(result.reason.as_deref(), Some("local-only"));
}

#[test]
fn learning_runner_replays_roles_budget_resume_and_notices() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/runs.json"
    ))
    .unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let config: Config = serde_json::from_value(row["config"].clone()).unwrap();
        let target = Target {
            scope: "agent".into(),
            owner: "ada".into(),
            agent_id: "alpha".into(),
            project_id: None,
        };
        let rows = parse(row["snapshot"].as_str().unwrap())
            .unwrap()
            .as_arr()
            .unwrap()
            .to_vec();
        let source = Fixture {
            name,
            rows: RefCell::new(rows),
            lost: Cell::new(false),
        };
        let mut model = ModelFixture {
            name,
            attempt: 0,
            calls: vec![],
            revoke: None,
        };
        let mut notices = Counts::default();
        let store = LearnStore::open(Path::new(":memory:")).unwrap();
        let clock = Time;
        let ids = Ids(AtomicUsize::new(0));
        let mut audit = |_: &AuditEvent| Ok(());
        let abort = AbortSignal::new();
        if name == "cancelled" {
            abort.abort();
        }
        let who = person();
        let request = Request {
            target: &target,
            who: &who,
            window: Window { from: 1, to: 101 },
            config: &config,
            abort: &abort,
        };
        let mut apply = |model: &mut ModelFixture<'_>| {
            run(
                &request,
                &mut Ports {
                    store: &store,
                    source: &source,
                    model,
                    read: None,
                    cards: None,
                    notice: Some(&mut notices),
                    clock: &clock,
                    ids: &ids,
                    audit: &mut audit,
                },
            )
            .unwrap()
        };
        let mut run = apply(&mut model);
        if matches!(name, "resume" | "digest changed" | "completed again") {
            model.attempt = 1;
            if name == "digest changed" {
                let mut borrowed = source.rows.borrow_mut();
                let mut updated = borrowed[0].as_obj().unwrap().clone();
                let mut message = updated.get("messages").unwrap().as_arr().unwrap()[0]
                    .as_obj()
                    .unwrap()
                    .clone();
                message.set("text", V::s("Changed statement"));
                updated.set("messages", V::Arr(vec![V::Obj(message)]));
                borrowed[0] = V::Obj(updated);
            }
            run = apply(&mut model);
        }
        let findings = store
            .findings(&run.id)
            .unwrap()
            .iter()
            .map(|v| serde_json::from_str::<Value>(&v.stringify()).unwrap())
            .collect::<Vec<_>>();
        let actual = json!({"run":run,"findings":findings,"calls":model.calls,"notices":notices.0});
        assert!(
            V::from_serde(&actual).deep_equal(&V::from_serde(&row["expected"])),
            "{name}\nactual {actual}\nexpected {}",
            row["expected"]
        );
    }
}

#[test]
fn revocation_after_the_port_refuses_its_checkpoint_and_keeps_the_budget() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/runs.json"
    ))
    .unwrap();
    let row = fixture.iter().find(|r| r["name"] == "completed").unwrap();
    let config: Config = serde_json::from_value(row["config"].clone()).unwrap();
    let target = Target {
        scope: "agent".into(),
        owner: "ada".into(),
        agent_id: "alpha".into(),
        project_id: None,
    };
    let source = Fixture {
        name: "revocation",
        rows: RefCell::new(
            parse(row["snapshot"].as_str().unwrap())
                .unwrap()
                .as_arr()
                .unwrap()
                .to_vec(),
        ),
        lost: Cell::new(false),
    };
    let mut model = ModelFixture {
        name: "revocation",
        attempt: 0,
        calls: vec![],
        revoke: Some(&source.lost),
    };
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    let mut audit = |_: &AuditEvent| Ok(());
    let run = run(
        &Request {
            target: &target,
            who: &person(),
            window: Window { from: 1, to: 101 },
            config: &config,
            abort: &AbortSignal::new(),
        },
        &mut Ports {
            store: &store,
            source: &source,
            model: &mut model,
            read: None,
            cards: None,
            notice: None,
            clock: &Time,
            ids: &Ids(AtomicUsize::new(0)),
            audit: &mut audit,
        },
    )
    .unwrap();
    assert_eq!(model.calls.len(), 1);
    assert_eq!(run.reason.as_deref(), Some("rights-changed"));
    assert!(run.tokens > MAX_OUTPUT);
    assert!(store.payload(&run.id, "extract:one").unwrap().is_none());
    assert!(store.findings(&run.id).unwrap().is_empty());
}

#[test]
fn an_agent_management_grant_alone_cannot_start_a_learning_job() {
    use crate::rbac::types::AgentRight;

    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/runs.json"
    ))
    .unwrap();
    let row = fixture.iter().find(|r| r["name"] == "completed").unwrap();
    let config: Config = serde_json::from_value(row["config"].clone()).unwrap();
    let target = Target {
        scope: "agent".into(),
        owner: "ada".into(),
        agent_id: "alpha".into(),
        project_id: None,
    };
    let source = Fixture {
        name: "agent-only grant",
        rows: RefCell::new(
            parse(row["snapshot"].as_str().unwrap())
                .unwrap()
                .as_arr()
                .unwrap()
                .to_vec(),
        ),
        lost: Cell::new(false),
    };
    let who = Principal {
        kind: Some(PrincipalKind::Person),
        agent_rights: Some(vec![("alpha".into(), AgentRight::Manage)]),
        ..Principal::new("ada", Role::Member)
    };
    let mut model = ModelFixture {
        name: "agent-only grant",
        attempt: 0,
        calls: vec![],
        revoke: None,
    };
    let mut audit = |_: &AuditEvent| Ok(());
    let store = LearnStore::open(Path::new(":memory:")).unwrap();
    let result = run(
        &Request {
            target: &target,
            who: &who,
            window: Window { from: 1, to: 101 },
            config: &config,
            abort: &AbortSignal::new(),
        },
        &mut Ports {
            store: &store,
            source: &source,
            model: &mut model,
            read: None,
            cards: None,
            notice: None,
            clock: &Time,
            ids: &Ids(AtomicUsize::new(0)),
            audit: &mut audit,
        },
    );
    assert!(result.is_err());
    assert!(model.calls.is_empty());
    assert!(store.runs("ada", Some(&target)).unwrap().is_empty());
}
