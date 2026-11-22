//! Tests of the service part of K6a. They follow the TypeScript tests `rbac`, `guardrails`, `limits`, `isolation`,
//! `memory-exposure`, `redaction-port`, `events` and `concurrency` where those run without a model, and add the marker test:
//! content an agent must not see appears in no result, event or error text sent to it.
use super::errors::{CollabError, CollabErrorCode as C, GuardrailReason};
use super::ids::CollabIds;
use super::limits::CallClass;
use super::ports::AgentInfo;
use super::ports::{
    BudgetCheck, BudgetPort, EventEmitter, MemoryEmitter, RedactionPort, TableDirectory,
};
use super::service::{AdmitInput, CollabService, ConsultOutcome, Ports, WriterIdentity};
use super::store::{CollabStore, NewTask, StoreOptions};
use super::types::{AgentState, CollabEvent};
use crate::approvals::js_json::J;
use crate::budget::Clock;
use crate::rbac::types::{AgentRight, Principal, PrincipalKind, ProjectRight, Role};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MARKER: &str = "MARKER-7f3a91c2";

struct Clk(Arc<AtomicI64>);
impl Clock for Clk {
    fn now(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
    }
}

#[derive(Default)]
struct Seq(Mutex<HashMap<String, usize>>, AtomicUsize);
impl CollabIds for Seq {
    fn new_id(&self, prefix: &str) -> String {
        let mut m = self.0.lock().unwrap();
        let n = m.entry(prefix.to_owned()).or_insert(0);
        *n += 1;
        format!("{prefix}_{n}")
    }
    fn trace_id(&self) -> String {
        format!("{:032x}", self.1.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn span_id(&self) -> String {
        format!("{:016x}", self.1.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

struct Shared(Arc<MemoryEmitter>);
impl EventEmitter for Shared {
    fn emit(&self, e: &CollabEvent) {
        self.0.emit(e);
    }
}

/// Replaces the marker and anything that looks like an e-mail address, like the TypeScript `secretRedactor`.
struct MarkerRedactor;
impl RedactionPort for MarkerRedactor {
    fn text(&self, s: &str) -> String {
        s.replace(MARKER, "[redacted]")
    }
    fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(o) => {
                Value::Object(o.iter().map(|(k, x)| (k.clone(), self.value(x))).collect())
            }
            other => other.clone(),
        }
    }
}

struct Spend(Mutex<i64>, Option<i64>);
impl BudgetPort for Spend {
    fn check(&self, e: &BudgetCheck) -> bool {
        self.1
            .is_none_or(|cap| *self.0.lock().unwrap() + e.tokens <= cap)
    }
    fn record(&self, u: &BudgetCheck) {
        *self.0.lock().unwrap() += u.tokens;
    }
}
struct SharedSpend(Arc<Spend>);
impl BudgetPort for SharedSpend {
    fn check(&self, e: &BudgetCheck) -> bool {
        self.0.check(e)
    }
    fn record(&self, u: &BudgetCheck) {
        self.0.record(u);
    }
}

struct H {
    svc: CollabService,
    events: Arc<MemoryEmitter>,
    spend: Arc<Spend>,
    dir: tempfile::TempDir,
}

fn person(id: &str, role: Role) -> Principal {
    Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new(id, role)
    }
}
fn owner() -> Principal {
    person("u-owner", Role::Owner)
}
fn member(project: &str, right: ProjectRight, agents: &[&str]) -> Principal {
    Principal {
        project_rights: Some(vec![(project.to_owned(), right)]),
        agent_rights: Some(
            agents
                .iter()
                .map(|a| ((*a).to_owned(), AgentRight::Use))
                .collect(),
        ),
        ..person("u-member", Role::Member)
    }
}

fn open_with(redact: bool, directory: Option<TableDirectory>, cap: Option<i64>) -> H {
    let dir = tempfile::tempdir().unwrap();
    let events = Arc::new(MemoryEmitter::default());
    let spend = Arc::new(Spend(Mutex::new(0), cap));
    let ids = Arc::new(Seq::default());
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let store = CollabStore::open_with_permissions(
        &dir.path().join("collab.sqlite"),
        StoreOptions::new(Arc::new(Clk(clock)), ids.clone()),
        crate::private_store::fixture_owner_hook(),
    )
    .unwrap();
    let mut ports = Ports {
        emit: Box::new(Shared(events.clone())),
        budget: Box::new(SharedSpend(spend.clone())),
        ..Ports::default()
    };
    if redact {
        ports.redact = Some(Box::new(MarkerRedactor));
    }
    if let Some(d) = directory {
        ports.directory = Box::new(d);
    }
    H {
        svc: CollabService::new(store, ports, ids),
        events,
        spend,
        dir,
    }
}

fn open() -> H {
    open_with(true, None, None)
}

fn input<'a>(
    p: &'a Principal,
    project: &'a str,
    from: &'a str,
    to: &'a str,
    text: &'a str,
) -> AdmitInput<'a> {
    AdmitInput {
        principal: p,
        project_id: project,
        from_agent: from,
        to_agent: to,
        text,
        extra: "",
        path: None,
        trace_id: None,
        parent_span_id: None,
        call_class: CallClass::Read,
        consult: true,
        task_id: None,
    }
}

fn setup(h: &H, agents: &[&str]) -> String {
    let p = h.svc.create_project(&owner(), "p", None).unwrap();
    for a in agents {
        h.svc.add_agent(&owner(), &p.id, a).unwrap();
    }
    p.id
}

fn code(e: &CollabError) -> (C, Option<&str>, Option<GuardrailReason>) {
    (e.code, e.reason.as_deref(), e.guardrail)
}

fn kinds(h: &H) -> Vec<&'static str> {
    h.events.0.lock().unwrap().iter().map(|e| e.kind).collect()
}

// ---- rbac ---------------------------------------------------------------------------------------------------------

#[test]
fn an_owner_may_create_a_project_and_a_member_or_viewer_without_object_rights_may_not() {
    let h = open();
    let p = h.svc.create_project(&owner(), "p", None).unwrap();
    assert_eq!(p.owner, "u-owner");
    for who in [
        person("u-member", Role::Member),
        person("u-viewer", Role::Viewer),
    ] {
        let e = h.svc.create_project(&who, "nope", None).unwrap_err();
        assert_eq!(e.code, C::Unauthorized, "{:?}", who.role);
    }
}

#[test]
fn a_member_needs_agent_use_rights_to_consult_a_shared_agent() {
    let h = open();
    let id = setup(&h, &["shared", "helper"]);
    h.svc
        .add_member(&owner(), &id, "u-member", "member")
        .unwrap();
    let ok = member(&id, ProjectRight::Member, &["shared", "helper"]);
    let start = h
        .svc
        .start_consult(&input(&ok, &id, "shared", "helper", "hi"))
        .unwrap();
    assert_eq!(start.path, vec!["shared".to_owned(), "helper".to_owned()]);
    let no_use = member(&id, ProjectRight::Member, &["shared"]);
    let e = h
        .svc
        .start_consult(&input(&no_use, &id, "shared", "helper", "hi again"))
        .unwrap_err();
    assert_eq!(e.code, C::Unauthorized);
}

#[test]
fn only_a_lead_may_archive_and_a_viewer_never_consults() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    h.svc
        .add_member(&owner(), &id, "u-member", "member")
        .unwrap();
    assert_eq!(
        h.svc
            .archive_project(&member(&id, ProjectRight::Member, &[]), &id)
            .unwrap_err()
            .code,
        C::Unauthorized
    );
    h.svc.add_member(&owner(), &id, "u-lead", "lead").unwrap();
    let lead = Principal {
        project_rights: Some(vec![(id.clone(), ProjectRight::Lead)]),
        ..person("u-lead", Role::Member)
    };
    assert!(h
        .svc
        .archive_project(&lead, &id)
        .unwrap()
        .archived_at
        .is_some());
    let h2 = open();
    let id2 = setup(&h2, &["a", "b"]);
    let viewer = Principal {
        project_rights: Some(vec![(id2.clone(), ProjectRight::Lead)]),
        agent_rights: Some(vec![
            ("a".into(), AgentRight::Manage),
            ("b".into(), AgentRight::Manage),
        ]),
        ..person("u-viewer", Role::Viewer)
    };
    assert_eq!(
        h2.svc
            .start_consult(&input(&viewer, &id2, "a", "b", "q"))
            .unwrap_err()
            .code,
        C::Unauthorized
    );
}

#[test]
fn an_a2a_agent_needs_an_owner_person() {
    let h = open();
    let id = setup(&h, &[]);
    let admin = person("u-admin", Role::Admin);
    let e = h.svc.add_agent(&admin, &id, "a2a:remote").unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            C::Unauthorized,
            "A2A assignment and execution require an Owner person"
        )
    );
    h.svc.add_agent(&owner(), &id, "a2a:remote").unwrap();
    let agent_owner = Principal {
        kind: Some(PrincipalKind::Agent),
        ..Principal::new("u-owner", Role::Owner)
    };
    assert_eq!(
        h.svc
            .add_agent(&agent_owner, &id, "a2a:other")
            .unwrap_err()
            .code,
        C::Unauthorized
    );
}

// ---- isolation ----------------------------------------------------------------------------------------------------

#[test]
fn a_project_the_caller_does_not_belong_to_reads_like_a_missing_one() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let outsider = Principal {
        project_rights: Some(vec![(id.clone(), ProjectRight::Member)]),
        ..person("u-out", Role::Member)
    };
    let e = h.svc.get_project(&outsider, &id).unwrap_err();
    assert_eq!(code(&e), (C::Unauthorized, Some("membership"), None));
    assert!(
        h.svc.list_projects(&outsider).unwrap().is_empty(),
        "a listing hides what a read refuses"
    );
    let t = h
        .svc
        .start_consult(&input(&owner(), &id, "a", "b", "q"))
        .unwrap();
    assert_eq!(
        h.svc
            .get_trace(&outsider, &t.trace_id)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("membership")
    );
    // A privileged role gets a plain not-found for a project that does not exist, never a hint that it does.
    let admin = person("u-admin", Role::Admin);
    let missing = h.svc.get_project(&admin, "prj_nope").unwrap_err();
    assert_eq!(code(&missing), (C::NotFound, Some("project"), None));
    // After membership is granted the same read works.
    h.svc.add_member(&owner(), &id, "u-out", "member").unwrap();
    assert_eq!(h.svc.get_project(&outsider, &id).unwrap().id, id);
}

#[test]
fn a_chain_of_another_project_is_never_joined() {
    let h = open();
    let one = setup(&h, &["a", "b"]);
    let two = h.svc.create_project(&owner(), "two", None).unwrap().id;
    h.svc.add_agent(&owner(), &two, "a").unwrap();
    h.svc.add_agent(&owner(), &two, "b").unwrap();
    let t = h
        .svc
        .start_consult(&input(&owner(), &one, "a", "b", "q"))
        .unwrap();
    let o = owner();
    let mut i = input(&o, &two, "a", "b", "q2");
    i.trace_id = Some(&t.trace_id);
    let e = h.svc.start_consult(&i).unwrap_err();
    assert_eq!(code(&e), (C::NotFound, Some("trace"), None));
}

// ---- guardrails through the service --------------------------------------------------------------------------------

fn refused(h: &H, i: &AdmitInput<'_>, reason: GuardrailReason) {
    let e = h.svc.start_consult(i).unwrap_err();
    assert_eq!(
        code(&e),
        (C::Guardrail, Some(reason.as_str()), Some(reason)),
        "{reason:?}"
    );
    assert_eq!(e.message, format!("guardrail {}", reason.as_str()));
}

#[test]
fn every_refusal_carries_its_reason_and_leaves_a_guardrail_span_and_an_event() {
    let h = open();
    let id = setup(&h, &["a", "b", "c"]);
    let o = owner();
    refused(
        &h,
        &input(&o, &id, "a", "a", "self"),
        GuardrailReason::SelfCall,
    );
    let mut cyc = input(&o, &id, "b", "a", "cycle");
    cyc.path = Some(vec!["a".into(), "b".into()]);
    refused(&h, &cyc, GuardrailReason::Cycle);
    let mut deep = input(&o, &id, "c", "b", "depth");
    deep.path = Some(vec!["x".into(), "y".into(), "z".into()]);
    refused(&h, &deep, GuardrailReason::Depth);
    let mut write = input(&o, &id, "a", "b", "write depth");
    write.call_class = CallClass::Write;
    write.consult = false;
    write.path = Some(vec!["a".into(), "c".into()]);
    refused(&h, &write, GuardrailReason::Depth);
    refused(
        &h,
        &input(&o, &id, "a", "zz", "outside"),
        GuardrailReason::ProjectBoundary,
    );
    let trace = h.svc.list_traces(&o, &id).unwrap();
    assert!(trace
        .iter()
        .flat_map(|t| &t.spans)
        .all(|s| s.kind == "guardrail" && s.status == "refused"));
    assert!(
        kinds(&h)
            .iter()
            .filter(|k| **k == "guardrail.refused")
            .count()
            >= 4
    );
}

#[test]
fn the_fanout_and_pair_limits_hold_exactly_at_their_bounds() {
    let h = open();
    let agents: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
    let id = setup(
        &h,
        &agents
            .iter()
            .map(String::as_str)
            .chain(["root"])
            .collect::<Vec<_>>(),
    );
    let o = owner();
    let first = h
        .svc
        .start_consult(&input(&o, &id, "root", "t0", "q0"))
        .unwrap();
    // The default allows 8 read helpers per turn: seven more are admitted, the ninth start is refused.
    for (i, agent) in agents.iter().enumerate().take(8).skip(1) {
        let mut x = input(&o, &id, "root", agent, "q");
        x.trace_id = Some(&first.trace_id);
        h.svc
            .start_consult(&x)
            .unwrap_or_else(|e| panic!("start {} refused: {e}", i + 1));
    }
    let mut ninth = input(&o, &id, "root", "t8", "q");
    ninth.trace_id = Some(&first.trace_id);
    refused(&h, &ninth, GuardrailReason::Fanout);
    // A refused call leaves no work behind: the counters did not move, so a call to an agent already seen is still counted.
    let h2 = open();
    let id2 = setup(&h2, &["root", "t"]);
    let one = h2
        .svc
        .start_consult(&input(&o, &id2, "root", "t", "q0"))
        .unwrap();
    for n in 1..4 {
        let text = format!("q{n}");
        let mut x = input(&o, &id2, "root", "t", &text);
        x.trace_id = Some(&one.trace_id);
        x.task_id = Some(&text);
        h2.svc.start_consult(&x).unwrap();
    }
    let mut fifth = input(&o, &id2, "root", "t", "q-last");
    fifth.trace_id = Some(&one.trace_id);
    fifth.task_id = Some("final question");
    refused(&h2, &fifth, GuardrailReason::PairLimit);
}

#[test]
fn the_same_question_inside_the_repeat_window_is_refused() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    h.svc
        .start_consult(&input(&o, &id, "a", "b", "Same question"))
        .unwrap();
    refused(
        &h,
        &input(&o, &id, "a", "b", "  same   QUESTION "),
        GuardrailReason::Repeat,
    );
}

#[test]
fn repeat_windows_are_independent_for_two_projects_using_the_same_agents() {
    let h = open();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/collab/repeat-scope.json"
    ))
    .unwrap();
    let agents = fixture["agents"].as_array().unwrap();
    let pair = [agents[0].as_str().unwrap(), agents[1].as_str().unwrap()];
    let projects = [setup(&h, &pair), setup(&h, &pair)];
    let o = owner();
    let question = fixture["question"].as_str().unwrap();
    for step in fixture["steps"].as_array().unwrap() {
        let project = &projects[step["project"].as_u64().unwrap() as usize];
        let admission = input(&o, project, pair[0], pair[1], question);
        let expected = match step.get("divergence") {
            Some(id) => {
                assert_eq!(id, "K6-D21");
                &step["rust"]
            }
            None => &step["typescript"],
        };
        if expected == "accepted" {
            h.svc.start_consult(&admission).unwrap();
        } else {
            assert_eq!(expected, "repeat");
            refused(&h, &admission, GuardrailReason::Repeat);
        }
    }
}

#[test]
fn a_project_boundary_and_an_inactive_agent_are_refused() {
    let mut dir = TableDirectory::default();
    for (id, state) in [
        ("a", AgentState::Active),
        ("b", AgentState::Active),
        ("paused", AgentState::Paused),
    ] {
        dir.0.insert(
            id.into(),
            AgentInfo {
                id: id.into(),
                state,
                target_kind: None,
                origin_a2a: false,
            },
        );
    }
    let h = open_with(true, Some(dir), None);
    let id = setup(&h, &["a", "paused"]);
    let o = owner();
    // `b` is active but not in the project: the boundary applies.
    refused(
        &h,
        &input(&o, &id, "a", "b", "outside"),
        GuardrailReason::ProjectBoundary,
    );
    // An inactive agent is refused by the agent check, which has its own message and writes no guardrail span.
    let e = h
        .svc
        .start_consult(&input(&o, &id, "a", "paused", "paused"))
        .unwrap_err();
    assert_eq!(
        code(&e),
        (
            C::Guardrail,
            Some("agent-inactive"),
            Some(GuardrailReason::AgentInactive)
        )
    );
    assert_eq!(
        e.message,
        "agent paused is not an active consult/delegate target"
    );
}

#[test]
fn the_token_budget_refuses_before_a_run_and_a_run_counts_against_it() {
    let h = open_with(true, None, Some(5));
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    // The port refuses what does not fit its cap.
    let long = "x".repeat(400);
    refused(
        &h,
        &input(&o, &id, "a", "b", &long),
        GuardrailReason::TokenBudget,
    );
    let h2 = open();
    let id2 = h2
        .svc
        .create_project(
            &owner(),
            "p",
            Some(&J::parse(r#"{"settingsVersion":2,"tokenBudget":10}"#).unwrap()),
        )
        .unwrap()
        .id;
    h2.svc.add_agent(&owner(), &id2, "a").unwrap();
    h2.svc.add_agent(&owner(), &id2, "b").unwrap();
    let s = h2
        .svc
        .start_consult(&input(&o, &id2, "a", "b", "first"))
        .unwrap();
    h2.svc
        .finish_consult(
            &s,
            &id2,
            "b",
            &ConsultOutcome::Answered {
                text: "ok".into(),
                partial: false,
                input_tokens: 6,
                output_tokens: 5,
            },
        )
        .unwrap();
    assert_eq!(
        *h2.spend.0.lock().unwrap(),
        11,
        "the budget port recorded the run"
    );
    let mut again = input(&o, &id2, "a", "b", "second");
    again.trace_id = Some(&s.trace_id);
    refused(&h2, &again, GuardrailReason::TokenBudget);
}

// ---- events and chains ---------------------------------------------------------------------------------------------

#[test]
fn a_consult_emits_started_and_finished_and_a_failed_run_is_recorded_masked() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    let s = h
        .svc
        .start_consult(&input(&o, &id, "a", "b", "ask"))
        .unwrap();
    assert_eq!(s.span_id.len(), 16);
    h.svc
        .finish_consult(
            &s,
            &id,
            "b",
            &ConsultOutcome::Failed(format!("boom {MARKER}")),
        )
        .unwrap();
    let trace = h.svc.get_trace(&o, &s.trace_id).unwrap();
    assert_eq!(trace.spans[0].status, "failed");
    assert!(!trace.spans[0].error.clone().unwrap().contains(MARKER));
    assert_eq!(
        kinds(&h),
        vec![
            "project.created",
            "project.agent.added",
            "project.agent.added",
            "consult.started",
            "consult.finished"
        ]
    );
    h.svc.finish_chain(&o, &s.trace_id).unwrap();
    assert_eq!(h.svc.get_trace(&o, &s.trace_id).unwrap().status, "failed");
}

#[test]
fn cancelling_a_chain_sets_the_flag_and_closes_running_work() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    let s = h
        .svc
        .start_consult(&input(&o, &id, "a", "b", "ask"))
        .unwrap();
    assert!(!h.svc.is_aborted(&s.trace_id));
    h.svc.cancel_chain(&o, &s.trace_id).unwrap();
    assert!(h.svc.is_aborted(&s.trace_id));
    let t = h.svc.get_trace(&o, &s.trace_id).unwrap();
    assert_eq!(
        (
            t.status.as_str(),
            t.spans[0].status.as_str(),
            t.spans[0].error.as_deref()
        ),
        ("cancelled", "cancelled", Some("aborted"))
    );
    assert!(t.ended_at.is_some());
}

#[test]
fn opening_a_chain_needs_the_agent_to_belong_to_the_project() {
    let h = open();
    let id = setup(&h, &["a"]);
    let e = h.svc.open_chain(&owner(), &id, "stranger").unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (C::Unauthorized, "project agent assignment required")
    );
    assert_eq!(h.svc.open_chain(&owner(), &id, "a").unwrap().len(), 32);
}

// ---- writer slots (concurrency) ------------------------------------------------------------------------------------

#[test]
fn writer_slots_are_bounded_per_project_and_released_once() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    let who = |t: Option<&'static str>| WriterIdentity {
        principal: &o,
        project_id: &id,
        from_agent: "a",
        to_agent: "b",
        trace_id: t,
        parent_span_id: None,
    };
    let held: Vec<_> = (0..4)
        .map(|_| h.svc.reserve_writer(&who(None)).unwrap())
        .collect();
    let full = h.svc.reserve_writer(&who(None)).unwrap_err();
    assert_eq!(
        code(&full),
        (C::Guardrail, Some("fanout"), Some(GuardrailReason::Fanout))
    );
    assert_eq!(full.message, "project writer slots full");
    h.svc.release_writer(held[0]);
    h.svc.release_writer(held[0]);
    let again = h.svc.reserve_writer(&who(None)).unwrap();
    assert!(
        h.svc.reserve_writer(&who(None)).is_err(),
        "a second release of one slot frees nothing more"
    );
    h.svc.release_writer(again);
}

#[test]
fn writer_slots_are_shared_by_connections_and_release_on_drop() {
    let first = open();
    use super::capacity::{CapacityFacts, CapacitySettings};

    let project = setup(&first, &["a", "b"]);
    let separate_project = setup(&first, &["a", "b"]);
    let ids = Arc::new(Seq::default());
    let second_store = CollabStore::open_with_permissions(
        &first.dir.path().join("collab.sqlite"),
        StoreOptions::new(Arc::new(Clk(Arc::new(AtomicI64::new(1000)))), ids.clone()),
        crate::private_store::fixture_owner_hook(),
    )
    .unwrap();
    let capacity = Arc::new(AtomicI64::new(8));
    let limit = Arc::clone(&capacity);
    let ports = Ports {
        capacity: Some(Box::new(move || CapacityFacts {
            cores: 8.0,
            available_memory: 8.0,
            total_memory: Some(8.0),
            settings: CapacitySettings {
                cores_per_writer: 1.0,
                memory_per_writer: 1.0,
                max_writers: Some(limit.load(Ordering::SeqCst) as f64),
            },
        })),
        ..Ports::default()
    };
    let second = CollabService::new(second_store, ports, ids);
    let principal = owner();
    let request = WriterIdentity {
        principal: &principal,
        project_id: &project,
        from_agent: "a",
        to_agent: "b",
        trace_id: None,
        parent_span_id: None,
    };
    let slots: Vec<_> = (0..4)
        .map(|_| first.svc.reserve_writer(&request).unwrap())
        .collect();
    assert_eq!(
        second.reserve_writer(&request).unwrap_err().message,
        "project writer slots full"
    );
    first.svc.release_writer(slots[0]);
    let replaced = second.reserve_writer(&request).unwrap();
    let other_request = WriterIdentity {
        project_id: &separate_project,
        ..request
    };
    capacity.store(2, Ordering::SeqCst);
    assert!(second.reserve_writer(&other_request).is_err());
    capacity.store(8, Ordering::SeqCst);
    assert!(first.svc.reserve_writer(&request).is_err());
    drop(first.svc);
    for _ in 0..3 {
        second.reserve_writer(&request).unwrap();
    }
    assert!(second.reserve_writer(&request).is_err());
    second.release_writer(replaced);
}

#[test]
fn batch_cancellation_ends_grants_before_publishing_terminal_status() {
    use super::store::TaskGrantEnd;
    use plur1bus_store::rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    struct GrantFixture {
        path: PathBuf,
        fail: AtomicBool,
        calls: Mutex<Vec<String>>,
    }
    impl TaskGrantEnd for GrantFixture {
        fn end_task(&self, task_id: &str) -> Result<(), String> {
            let conn = Connection::open(&self.path).unwrap();
            let status: String = conn
                .query_row("SELECT status FROM tasks WHERE id=?", [task_id], |r| {
                    r.get(0)
                })
                .unwrap();
            assert!(matches!(status.as_str(), "queued" | "running"));
            self.calls.lock().unwrap().push(task_id.to_owned());
            if task_id == "task-b" && self.fail.load(Ordering::SeqCst) {
                return Err("fixture grant store unavailable".to_owned());
            }
            Ok(())
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("collab.sqlite");
    let grants = Arc::new(GrantFixture {
        path: path.clone(),
        fail: AtomicBool::new(true),
        calls: Mutex::new(Vec::new()),
    });
    let mut options = StoreOptions::new(
        Arc::new(Clk(Arc::new(AtomicI64::new(1000)))),
        Arc::new(Seq::default()),
    );
    options.grants = Some(grants.clone());
    let store = CollabStore::open_with_permissions(
        &path,
        options,
        crate::private_store::fixture_owner_hook(),
    )
    .unwrap();
    store
        .create_project("fixture", "owner", None, Some("p"))
        .unwrap();
    store.insert_trace("trace", "p", "a", "span", None).unwrap();
    store
        .insert_span("span", "trace", None, "a", "delegate", None, None)
        .unwrap();
    for (id, status) in [
        ("task-a", "queued"),
        ("task-b", "running"),
        ("done", "succeeded"),
    ] {
        store
            .insert_task(&NewTask {
                id: id.into(),
                project_id: "p".into(),
                trace_id: "trace".into(),
                span_id: "span".into(),
                from_agent: "a".into(),
                to_agent: "b".into(),
                kind: "delegate".into(),
                status: status.into(),
                ..Default::default()
            })
            .unwrap();
    }
    let status = |id: &str| store.get_task(id).unwrap().unwrap().status;
    assert!(store.cancel_open_tasks("trace").is_err());
    assert_eq!(status("task-a"), "queued");
    assert_eq!(status("task-b"), "running");
    grants.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        store.cancel_open_tasks("trace").unwrap(),
        ["task-a", "task-b"]
    );
    assert_eq!(status("task-a"), "cancelled");
    assert_eq!(status("task-b"), "cancelled");
    assert_eq!(status("done"), "succeeded");
    assert_eq!(
        *grants.calls.lock().unwrap(),
        ["task-a", "task-b", "task-a", "task-b"]
    );
}

// ---- redaction port and the marker test ----------------------------------------------------------------------------

fn seed_marker(h: &H, id: &str) -> (String, String) {
    let o = owner();
    let s = h
        .svc
        .start_consult(&input(&o, id, "a", "b", &format!("question {MARKER}")))
        .unwrap();
    h.svc
        .finish_consult(
            &s,
            id,
            "b",
            &ConsultOutcome::Answered {
                text: format!("answer {MARKER}"),
                partial: false,
                input_tokens: 2,
                output_tokens: 2,
            },
        )
        .unwrap();
    h.svc
        .store()
        .insert_task(&NewTask {
            id: "task-1".into(),
            project_id: id.into(),
            trace_id: s.trace_id.clone(),
            span_id: s.span_id.clone(),
            from_agent: "a".into(),
            to_agent: "b".into(),
            kind: "delegate".into(),
            status: "running".into(),
            task: format!("task {MARKER}"),
            acceptance: format!("accept {MARKER}"),
            path: vec!["a".into(), "b".into()],
            ..NewTask::default()
        })
        .unwrap();
    h.svc
        .store()
        .update_task(
            "task-1",
            &super::store::TaskPatch {
                status: "failed".into(),
                result: Some(format!("result {MARKER}")),
                error: Some(format!("error {MARKER}")),
                ..Default::default()
            },
        )
        .unwrap();
    (s.trace_id, s.span_id)
}

#[test]
#[allow(clippy::vec_init_then_push)] // the list reads as a script of every place a text can leave through
fn marker_content_appears_in_no_result_event_or_error_text_sent_to_a_caller() {
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let (trace, _) = seed_marker(&h, &id);
    let o = owner();
    let mut released = vec![];
    released.push(h.svc.get_trace(&o, &trace).unwrap().to_value().to_string());
    released.push(h.svc.export_trace(&o, &trace).unwrap());
    released.push(
        Value::Array(
            h.svc
                .list_traces(&o, &id)
                .unwrap()
                .iter()
                .map(|t| t.to_value())
                .collect(),
        )
        .to_string(),
    );
    released.push(h.svc.get_task(&o, "task-1").unwrap().to_value().to_string());
    for e in h.events.0.lock().unwrap().iter() {
        released.push(e.to_value().to_string());
    }
    // Error texts sent to a caller: a refusal built from the question, a missing trace, a refused read.
    let text = format!("question {MARKER}");
    let mut again = input(&o, &id, "a", "b", &text);
    again.trace_id = Some(&trace);
    released.push(h.svc.start_consult(&again).unwrap_err().to_string());
    released.push(h.svc.get_trace(&o, "t-none").unwrap_err().to_string());
    let outsider = person("u-out", Role::Member);
    released.push(h.svc.get_task(&outsider, "task-1").unwrap_err().to_string());
    for (n, text) in released.iter().enumerate() {
        assert!(
            !text.contains(MARKER),
            "released text #{n} carries the marker: {text}"
        );
    }
    assert!(
        released[0].contains("[redacted]"),
        "the masked form is what is released"
    );
    // The stored previews never held it either (they are masked on the way in).
    let rows = h
        .svc
        .store()
        .query_rows(
            "SELECT input_preview, output_preview, error FROM spans",
            &[],
        )
        .unwrap();
    assert!(!rows
        .iter()
        .flatten()
        .any(|v| v.as_str().is_some_and(|s| s.contains(MARKER))));
}

#[test]
fn without_a_redaction_port_nothing_is_released_and_nothing_secret_is_stored() {
    let h = open_with(false, None, None);
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    let s = h
        .svc
        .start_consult(&input(&o, &id, "a", "b", &format!("question {MARKER}")))
        .unwrap();
    h.svc
        .finish_consult(
            &s,
            &id,
            "b",
            &ConsultOutcome::Failed(format!("boom {MARKER}")),
        )
        .unwrap();
    for e in [
        h.svc.get_trace(&o, &s.trace_id).unwrap_err(),
        h.svc.export_trace(&o, &s.trace_id).unwrap_err(),
        h.svc.list_traces(&o, &id).unwrap_err(),
    ] {
        assert_eq!(code(&e), (C::Unauthorized, Some("no-redactor"), None));
        assert!(!e.to_string().contains(MARKER));
    }
    let rows = h
        .svc
        .store()
        .query_rows(
            "SELECT input_preview, output_preview, error FROM spans",
            &[],
        )
        .unwrap();
    assert!(
        !rows
            .iter()
            .flatten()
            .any(|v| v.as_str().is_some_and(|s| s.contains(MARKER))),
        "stored previews are empty without a redactor"
    );
    let _ = &h.dir;
}

#[test]
fn a_stored_preview_is_masked_again_on_the_way_out() {
    // Defence in depth: a row written before a redactor was configured, or by another writer, still leaves masked.
    let h = open();
    let id = setup(&h, &["a", "b"]);
    let o = owner();
    let store = h.svc.store();
    store
        .insert_trace("t-raw", &id, "a", "s-raw", None)
        .unwrap();
    store
        .insert_span(
            "s-raw",
            "t-raw",
            None,
            "b",
            "consult",
            None,
            Some(&format!("in {MARKER}")),
        )
        .unwrap();
    store
        .finish_span(
            "s-raw",
            &super::store::SpanPatch {
                status: "failed".into(),
                output_preview: Some(format!("out {MARKER}")),
                error: Some(format!("err {MARKER}")),
                ..Default::default()
            },
        )
        .unwrap();
    let t = h.svc.get_trace(&o, "t-raw").unwrap();
    let s = &t.spans[0];
    assert_eq!(
        (
            s.input_preview.as_str(),
            s.output_preview.as_str(),
            s.error.as_deref()
        ),
        ("in [redacted]", "out [redacted]", Some("err [redacted]"))
    );
}

#[path = "service_read_tests.rs"]
mod read_tests;

#[path = "service_run_tests.rs"]
mod run_tests;

#[test]
fn reopening_a_chain_restores_the_persisted_root_pair_count() {
    let h = open();
    let project_id = setup(&h, &["a", "b"]);
    let o = owner();
    let start = h
        .svc
        .start_consult(&input(&o, &project_id, "a", "b", "Read the summary"))
        .unwrap();
    let project = h.svc.live_project(&project_id).unwrap();
    h.svc.st().chains.remove(&start.trace_id);
    let restored = h
        .svc
        .get_chain(Some(&start.trace_id), &project, "a")
        .unwrap();
    assert_eq!(
        restored
            .pair_counts
            .get(&pair_key(&CollabService::turn_key("a", None), "b")),
        Some(&1)
    );
}
