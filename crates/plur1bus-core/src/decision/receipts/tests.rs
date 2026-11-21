//! Tests of the receipts: format, marker test, store, rights, retention, replay, adoption.
use super::adopt::AdoptRequest;
use super::replay::{PortFault, ReplayGate};
use super::store::FILE_NAME;
use super::*;
use crate::approvals::js_json::J;
use crate::budget::{Clock as WallClockPort, IdSource};
use crate::decision::client::{DecisionClient, DecisionOptions};
use crate::decision::types::{
    BackendError, BackendName, Cancel, ChatContext, Clock as MonoClockPort, ConfidenceSource,
    DecisionBackend, DecisionConfig, DecisionContext, DecisionError, DecisionInput,
    DecisionRequest, DecisionSuccess, DecisionValue, Failure, Feature, UseCase,
};
use crate::decision::ChoiceOption;
use crate::rbac::audit::AuditEvent;
use crate::rbac::types::{Principal, PrincipalKind, Role, ROLES};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const DAY: i64 = 86_400_000;
// Identifier-shaped on purpose: the format check cannot catch these, only the absence of a copy can.
const M_STATE: &str = "MKSTATE9f3a1c";
const M_QUESTION: &str = "MKQUESTION4be72d";
const M_DESC: &str = "MKDESCRIPTION81c0aa";
const M_FEATURE: &str = "MKFEATURE5d19e3";
const M_LEVEL: &str = "MKLEVEL02b7f6";
const M_CHAT: &str = "MKCHAT7a6e44";
const MARKERS: [&str; 6] = [M_STATE, M_QUESTION, M_DESC, M_FEATURE, M_LEVEL, M_CHAT];

struct Wall(AtomicI64);
impl WallClockPort for Wall {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Mono(Mutex<f64>);
impl MonoClockPort for Mono {
    fn now(&self) -> f64 {
        *self.0.lock().unwrap()
    }
}

struct Queue(Mutex<VecDeque<String>>);
impl Queue {
    fn of(ids: &[&str]) -> Arc<Self> {
        Arc::new(Queue(Mutex::new(
            ids.iter().map(|s| (*s).to_owned()).collect(),
        )))
    }
}
impl IdSource for Queue {
    fn next_id(&self) -> String {
        static SPARE: AtomicUsize = AtomicUsize::new(0);
        let next = self.0.lock().unwrap().pop_front();
        next.unwrap_or_else(|| format!("spare{}", SPARE.fetch_add(1, Ordering::SeqCst)))
    }
}

struct Seq(AtomicUsize);
impl IdSource for Seq {
    fn next_id(&self) -> String {
        format!("r{}", self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

fn seq() -> Arc<Seq> {
    Arc::new(Seq(AtomicUsize::new(0)))
}

fn open_with(dir: &Path, wall: &Arc<Wall>, ids: Arc<dyn IdSource>, ret: Retention) -> ReceiptStore {
    ReceiptStore::open(ReceiptStoreOptions {
        path: dir.join(FILE_NAME),
        clock: wall.clone(),
        ids: Some(ids),
        retention: ret,
        secure_path: Some(Box::new(|_| true)),
    })
    .unwrap()
}

fn open(dir: &Path, wall: &Arc<Wall>) -> ReceiptStore {
    open_with(dir, wall, seq(), Retention::default())
}

fn wall(t: i64) -> Arc<Wall> {
    Arc::new(Wall(AtomicI64::new(t)))
}

fn draft(turn: &str, use_case: ReceiptUseCase, choice: Option<&str>) -> ReceiptDraft {
    ReceiptDraft {
        turn_id: turn.into(),
        session_id: "s1".into(),
        agent: "main".into(),
        message_id: Some(format!("m-{turn}")),
        use_case,
        backend: Some("laya".into()),
        model_revision: Some("rev-1".into()),
        calibration_version: 1,
        prompt_version: "p1".into(),
        candidates: vec!["a".into(), "b".into()],
        registry_hash: None,
        result: ReceiptResult {
            choice: choice.map(str::to_owned),
            distribution: vec![0.7, 0.3],
            confidence: Some(0.9),
        },
        validation: Validation::Accepted,
        fallback: None,
        duration_ms: 10,
        tokens_in: 100,
        tokens_out: 5,
    }
}

fn who(role: Role, kind: Option<PrincipalKind>) -> Principal {
    let mut p = Principal::new("u1", role);
    p.kind = kind;
    p
}

fn person(role: Role) -> Principal {
    who(role, Some(PrincipalKind::Person))
}

fn bytes_of(dir: &Path) -> Vec<u8> {
    let main = dir.join(FILE_NAME);
    let mut all = std::fs::read(&main).unwrap_or_default();
    for suffix in ["-wal", "-shm"] {
        let side = format!("{}{suffix}", main.display());
        all.extend(std::fs::read(side).unwrap_or_default());
    }
    all
}

/// The store file and its WAL, not the shared-memory index (a plain read changes that one).
fn stable_bytes(dir: &Path) -> Vec<u8> {
    let main = dir.join(FILE_NAME);
    let mut all = std::fs::read(&main).unwrap_or_default();
    all.extend(std::fs::read(format!("{}-wal", main.display())).unwrap_or_default());
    all
}

fn has(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

// ---- format ----

#[test]
fn a_draft_round_trips_and_the_format_refuses_what_is_not_an_identifier() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open(dir.path(), &wall(1000));
    let d = draft("t1", ReceiptUseCase::Routing, Some("a"));
    let WriteResult::Written(id) = s.write(&d, false).unwrap() else {
        panic!()
    };
    let r = s.get(&id).unwrap().unwrap();
    assert_eq!(
        (r.at, r.agent.as_str(), r.schema.as_str()),
        (1000, "main", "plur1bus.decisionreceipt/1")
    );
    assert_eq!(r.result.choice.as_deref(), Some("a"));
    let bad = |f: &dyn Fn(&mut ReceiptDraft)| {
        let mut d = draft("t9", ReceiptUseCase::Routing, Some("a"));
        f(&mut d);
        d.validate().is_err()
    };
    assert!(bad(&|d| d.agent = "has space".into()));
    assert!(bad(&|d| d.agent = String::new()));
    assert!(bad(&|d| d.agent = "x".repeat(129)));
    assert!(bad(&|d| d.result.choice = Some("zzz".into())));
    assert!(bad(&|d| d.result.distribution = vec![1.0]));
    assert!(bad(&|d| d.result.distribution = vec![0.5, 1.5]));
    assert!(bad(&|d| d.result.confidence = Some(f64::NAN)));
    assert!(bad(&|d| d.registry_hash = Some("ABC".into())));
    assert!(bad(&|d| d.backend = Some("openai".into())));
    assert!(bad(&|d| d.candidates = vec![]));
    assert!(bad(&|d| d.candidates = vec!["a".into(), "a".into()]));
    assert!(bad(&|d| d.fallback = Some(Fallback {
        role: None,
        rules: vec!["two words".into()]
    })));
    assert!(!bad(&|d| d.registry_hash = Some("0".repeat(64))));
}

#[test]
fn capture_makes_an_abstention_of_a_failed_decision() {
    let ctx = {
        let mut c = DecisionContext::new("main");
        c.session_id = Some("s1".into());
        c.turn_id = Some("t1".into());
        c
    };
    let input = DecisionInput {
        use_case: UseCase::Routing,
        state: "x".into(),
        question: "y".into(),
        features: None,
        options: Some(vec![
            ChoiceOption {
                id: "a".into(),
                description: "d".into(),
            },
            ChoiceOption {
                id: "b".into(),
                description: "d".into(),
            },
        ]),
        levels: None,
    };
    let failed = Err(DecisionError {
        request_id: "q".into(),
        elapsed_ms: 3.2,
        reason: Failure::LowConfidence,
        attempted: vec![BackendName::Kev],
    });
    let d = capture(&Decided {
        use_case: ReceiptUseCase::Routing,
        context: &ctx,
        input: &input,
        candidates: None,
        result: &failed,
        message_id: None,
        prompt_version: "p1",
        calibration_version: 2,
        registry_hash: None,
        validation: Validation::Rejected {
            reason: RejectReason::BelowFloor,
        },
        fallback: None,
        tokens: (1, 2),
    })
    .unwrap();
    assert_eq!(d.result.choice, None);
    assert_eq!(d.backend.as_deref(), Some("kev"));
    assert_eq!((d.duration_ms, d.candidates.len()), (3, 2));
    let mut no_session = ctx.clone();
    no_session.session_id = None;
    let e = capture(&Decided {
        context: &no_session,
        use_case: ReceiptUseCase::Routing,
        input: &input,
        candidates: None,
        result: &failed,
        message_id: None,
        prompt_version: "p1",
        calibration_version: 2,
        registry_hash: None,
        validation: Validation::Accepted,
        fallback: None,
        tokens: (0, 0),
    });
    assert_eq!(e.unwrap_err(), ReceiptError::Missing("sessionId"));
}

// ---- the marker test ----

#[test]
fn no_content_in_a_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open(dir.path(), &wall(5000));
    let mut ctx = DecisionContext::new("main");
    ctx.session_id = Some("s1".into());
    ctx.turn_id = Some("t1".into());
    ctx.principal = Some(M_CHAT.into());
    ctx.locale = Some(M_CHAT.into());
    ctx.chat = Some(ChatContext {
        principal: Some(M_CHAT.into()),
        project_id: Some(M_CHAT.into()),
        role: None,
        request: J::obj([("text", J::s(M_CHAT))]),
    });
    let input = DecisionInput {
        use_case: UseCase::Routing,
        state: M_STATE.into(),
        question: M_QUESTION.into(),
        features: Some(vec![(M_FEATURE.into(), Feature::Text(M_FEATURE.into()))]),
        options: Some(vec![
            ChoiceOption {
                id: "a".into(),
                description: M_DESC.into(),
            },
            ChoiceOption {
                id: "b".into(),
                description: M_DESC.into(),
            },
        ]),
        levels: Some(vec![M_LEVEL.into(), M_LEVEL.into()]),
    };
    let result = Ok(DecisionSuccess {
        request_id: "q1".into(),
        backend: BackendName::Laya,
        elapsed_ms: 12.4,
        model_revision: Some("rev-1".into()),
        value: DecisionValue::Choice {
            id: "a".into(),
            probabilities: vec![("a".into(), 0.7), ("b".into(), 0.3)],
        },
        confidence: 0.9,
        confidence_source: ConfidenceSource::Backend,
    });
    let d = capture(&Decided {
        use_case: ReceiptUseCase::Routing,
        context: &ctx,
        input: &input,
        candidates: None,
        result: &result,
        message_id: Some("m1"),
        prompt_version: "p1",
        calibration_version: 1,
        registry_hash: None,
        validation: Validation::Accepted,
        fallback: None,
        tokens: (10, 2),
    })
    .unwrap();
    let WriteResult::Written(id) = s.write(&d, false).unwrap() else {
        panic!()
    };
    s.record_outcome(
        &id,
        &Outcome {
            used: vec!["fs.read".into()],
            reloaded: vec![],
            tool_errors: vec![],
        },
    )
    .unwrap();
    let page = s.list(&person(Role::Owner), &ListQuery::default()).unwrap();
    // Every text the library can produce about this receipt, in its types and in its errors.
    let mut texts = format!("{d:?}{page:?}{:?}", s.get(&id).unwrap());
    let mut provoke = |e: ReceiptError| texts += &format!("{e}{e:?}");
    provoke(s.write(&d, false).unwrap_err());
    let mut bad = d.clone();
    bad.agent = format!("{M_STATE} {M_QUESTION} not an identifier");
    provoke(s.write(&bad, false).unwrap_err());
    provoke(
        s.record_outcome(
            "nope",
            &Outcome {
                used: vec![],
                reloaded: vec![],
                tool_errors: vec![],
            },
        )
        .unwrap_err(),
    );
    provoke(
        s.list(&who(Role::Viewer, None), &ListQuery::default())
            .unwrap_err(),
    );
    for m in MARKERS {
        assert!(!texts.contains(m), "{m} in a text");
        assert!(
            !has(&bytes_of(dir.path()), m),
            "{m} in the store file or its WAL"
        );
    }
    drop(s);
    for m in MARKERS {
        assert!(
            !has(&bytes_of(dir.path()), m),
            "{m} in the store file after close"
        );
    }
    // The input is read for option ids only: the same options with other text give the same draft.
    let mut other = input.clone();
    other.state = "other".into();
    other.question = "other".into();
    let again = capture(&Decided {
        use_case: ReceiptUseCase::Routing,
        context: &ctx,
        input: &other,
        candidates: None,
        result: &result,
        message_id: Some("m1"),
        prompt_version: "p1",
        calibration_version: 1,
        registry_hash: None,
        validation: Validation::Accepted,
        fallback: None,
        tokens: (10, 2),
    })
    .unwrap();
    assert_eq!(again, d);
}

// ---- store ----

#[test]
fn one_receipt_per_turn_and_use_case_and_no_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open(dir.path(), &wall(1));
    s.write(&draft("t1", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    let again = draft("t1", ReceiptUseCase::Routing, Some("b"));
    assert_eq!(s.write(&again, false), Err(ReceiptError::Duplicate));
    assert_eq!(
        s.get("r1").unwrap().unwrap().result.choice.as_deref(),
        Some("a")
    );
    s.write(&draft("t1", ReceiptUseCase::Triage, Some("a")), false)
        .unwrap();
    s.write(&draft("t2", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    assert_eq!(s.count().unwrap(), 3);
}

#[test]
fn an_incognito_session_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open(dir.path(), &wall(1));
    s.write(&draft("t0", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    let before = stable_bytes(dir.path());
    let out = s
        .write(&draft("t1", ReceiptUseCase::Routing, Some("a")), true)
        .unwrap();
    assert_eq!(out, WriteResult::Skipped);
    assert_eq!(s.count().unwrap(), 1);
    assert_eq!(
        stable_bytes(dir.path()),
        before,
        "not a byte changed, not even a row without fields"
    );
    // the same turn can be written later when it is not incognito: nothing was claimed
    s.write(&draft("t1", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
}

#[test]
fn a_newer_schema_is_refused_and_the_file_is_not_touched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    {
        let c = plur1bus_store::rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE future(x); PRAGMA user_version = 2;")
            .unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let r = ReceiptStore::open(ReceiptStoreOptions {
        path: path.clone(),
        clock: wall(1),
        ids: None,
        retention: Retention::default(),
        secure_path: Some(Box::new(|_| true)),
    });
    assert!(matches!(
        r,
        Err(ReceiptError::NewerSchema {
            found: 2,
            supported: 1
        })
    ));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!dir.path().join(format!("{FILE_NAME}-wal")).exists());
}

#[test]
fn a_fresh_store_is_version_1_and_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let w = wall(1);
    drop(open(dir.path(), &w));
    let s = open(dir.path(), &w);
    assert_eq!(s.db.user_version().unwrap(), 1);
}

#[test]
fn the_outcome_is_recorded_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open(dir.path(), &wall(1));
    s.write(&draft("t1", ReceiptUseCase::Tools, Some("a")), false)
        .unwrap();
    let o = Outcome {
        used: vec!["fs.read".into()],
        reloaded: vec!["web.fetch".into()],
        tool_errors: vec![ToolErrorCount {
            class: "timeout".into(),
            count: 2,
        }],
    };
    s.record_outcome("r1", &o).unwrap();
    assert_eq!(
        s.record_outcome("r1", &o),
        Err(ReceiptError::OutcomeAlready)
    );
    assert_eq!(
        s.record_outcome("zz", &o),
        Err(ReceiptError::UnknownReceipt)
    );
    assert_eq!(s.get("r1").unwrap().unwrap().outcome, Some(o));
    let dup = Outcome {
        used: vec!["a".into(), "a".into()],
        reloaded: vec![],
        tool_errors: vec![],
    };
    assert!(dup.validate().is_err());
    let zero = Outcome {
        used: vec![],
        reloaded: vec![],
        tool_errors: vec![ToolErrorCount {
            class: "x".into(),
            count: 0,
        }],
    };
    assert!(zero.validate().is_err());
}

#[test]
fn the_outcome_agrees_with_the_registry_counters() {
    // D2 golden test, as far as it is reachable without wiring: the same turn's events go into the registry the way the
    // dispatcher records them, and the counters equal what the receipt says.
    use crate::toolcall::json::parse;
    use crate::toolcall::registry::SqliteCapabilityRegistry;
    let dir = tempfile::tempdir().unwrap();
    let w = wall(1);
    let mut s = open(dir.path(), &w);
    let mut d = draft("t1", ReceiptUseCase::Tools, Some("fs.read"));
    d.candidates = vec!["fs.read".into(), "web.fetch".into()];
    s.write(&d, false).unwrap();
    let o = Outcome {
        used: vec!["fs.read".into()],
        reloaded: vec!["web.fetch".into()],
        tool_errors: vec![],
    };
    s.record_outcome("r1", &o).unwrap();
    let mut reg =
        SqliteCapabilityRegistry::open(&dir.path().join("cap.sqlite"), w.clone()).unwrap();
    for id in ["fs.read", "web.fetch"] {
        let entry = format!(
            r#"{{"id":"{id}","name":"{id}","description":"d","version":"1","source":"core","kind":"tool","effect":"read","risk":"low","category":"files.read"}}"#
        );
        reg.upsert(&parse(&entry).unwrap()).unwrap();
    }
    let r = s.get("r1").unwrap().unwrap();
    for id in &r.candidates {
        reg.record(id, "main", "offered").unwrap();
    }
    for id in &r.outcome.as_ref().unwrap().used {
        reg.record(id, "main", "used").unwrap();
    }
    for id in &r.outcome.as_ref().unwrap().reloaded {
        reg.record(id, "main", "foundBySearch").unwrap();
    }
    for id in &r.candidates {
        let st = reg.stats(id, "main").unwrap();
        let o = r.outcome.as_ref().unwrap();
        assert_eq!(st.offered, 1.0);
        assert_eq!(st.used, o.used.contains(id) as u8 as f64);
        assert_eq!(st.found_by_search, o.reloaded.contains(id) as u8 as f64);
    }
}

// ---- rights ----

#[test]
fn rights_by_role_and_kind() {
    let kinds = [
        None,
        Some(PrincipalKind::Agent),
        Some(PrincipalKind::Person),
    ];
    for role in ROLES {
        for kind in kinds {
            let p = who(role, kind);
            let staff = matches!(role, Role::Owner | Role::Admin);
            let human = kind == Some(PrincipalKind::Person);
            assert_eq!(rights::can_list(&p), staff, "list {role:?} {kind:?}");
            assert_eq!(
                rights::can_replay(&p),
                staff && human,
                "replay {role:?} {kind:?}"
            );
            assert_eq!(
                rights::can_adopt(&p),
                staff && human,
                "adopt {role:?} {kind:?}"
            );
        }
    }
    let mut anonymous = person(Role::Owner);
    anonymous.user_id = String::new();
    assert!(!rights::can_list(&anonymous));
    let mut scoped = person(Role::Admin);
    scoped.token_scopes = Some(vec!["decision.receipts.list".into()]);
    assert!(rights::can_list(&scoped) && !rights::can_replay(&scoped));
    scoped.token_scopes = Some(vec!["decision.*".into()]);
    assert!(rights::can_list(&scoped) && rights::can_replay(&scoped));
    scoped.token_scopes = Some(vec![]);
    assert!(!rights::can_list(&scoped));
}

#[test]
fn listing_is_for_owner_and_admin_and_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open(dir.path(), &wall(1));
    for i in 0..5 {
        s.write(
            &draft(&format!("t{i}"), ReceiptUseCase::Routing, Some("a")),
            false,
        )
        .unwrap();
    }
    for role in [Role::Operator, Role::Member, Role::Viewer] {
        for kind in [
            None,
            Some(PrincipalKind::Person),
            Some(PrincipalKind::Agent),
        ] {
            assert_eq!(
                s.list(&who(role, kind), &ListQuery::default()),
                Err(ReceiptError::Denied)
            );
        }
    }
    let admin = person(Role::Admin);
    let p1 = s
        .list(
            &admin,
            &ListQuery {
                limit: 2,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!((p1.receipts.len(), p1.next.is_some()), (2, true));
    let p2 = s
        .list(
            &admin,
            &ListQuery {
                limit: 2,
                after: p1.next,
                ..Default::default()
            },
        )
        .unwrap();
    let p3 = s
        .list(
            &admin,
            &ListQuery {
                limit: 2,
                after: p2.next,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        (p2.receipts.len(), p3.receipts.len(), p3.next),
        (2, 1, None)
    );
    assert_eq!(
        s.list(
            &admin,
            &ListQuery {
                session_id: Some("other".into()),
                ..Default::default()
            }
        )
        .unwrap()
        .receipts
        .len(),
        0
    );
}

// ---- retention ----

#[test]
fn the_defaults_are_thirty_days_and_twenty_thousand() {
    let r = Retention::default();
    assert_eq!((r.max_age_ms, r.max_count), (30 * DAY, 20_000));
    assert!(
        Retention::new(0, 5).is_err()
            && Retention::new(5, 0).is_err()
            && Retention::new(1, 1).is_ok()
    );
}

#[test]
fn age_is_kept_at_thirty_days_and_goes_one_millisecond_later() {
    let dir = tempfile::tempdir().unwrap();
    let w = wall(1_000_000);
    let mut s = open(dir.path(), &w);
    s.write(&draft("t1", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    w.0.store(1_000_000 + 30 * DAY, Ordering::SeqCst);
    assert_eq!(s.prune().unwrap(), 0, "age exactly thirty days stays");
    w.0.store(1_000_000 + 30 * DAY + 1, Ordering::SeqCst);
    assert_eq!(s.prune().unwrap(), 1);
    assert_eq!(s.count().unwrap(), 0);
}

#[test]
fn the_count_limit_drops_the_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open_with(
        dir.path(),
        &wall(1),
        seq(),
        Retention::new(30 * DAY, 3).unwrap(),
    );
    for i in 1..=3 {
        s.write(
            &draft(&format!("t{i}"), ReceiptUseCase::Routing, Some("a")),
            false,
        )
        .unwrap();
    }
    assert_eq!(s.prune().unwrap(), 0, "as many as allowed stay");
    s.write(&draft("t4", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    assert_eq!(s.prune().unwrap(), 1);
    assert!(s.get("r1").unwrap().is_none());
    assert!(s.get("r2").unwrap().is_some() && s.get("r4").unwrap().is_some());
}

#[test]
fn age_and_count_apply_independently() {
    let dir = tempfile::tempdir().unwrap();
    let w = wall(0);
    let mut s = open_with(dir.path(), &w, seq(), Retention::new(10, 2).unwrap());
    s.write(&draft("t1", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    w.0.store(8, Ordering::SeqCst);
    s.write(&draft("t2", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    s.write(&draft("t3", ReceiptUseCase::Routing, Some("a")), false)
        .unwrap();
    w.0.store(11, Ordering::SeqCst);
    assert_eq!(
        s.prune().unwrap(),
        1,
        "t1 is too old; two remain within the limit"
    );
    assert_eq!(s.count().unwrap(), 2);
}

// ---- replay ----

struct Fake {
    clock: Arc<Mono>,
    calls: AtomicUsize,
    confidence: f64,
    local: bool,
}

impl DecisionBackend for Fake {
    fn local(&self, _: &DecisionContext) -> Result<Option<bool>, BackendError> {
        Ok(Some(self.local))
    }
    fn has_eligible(&self) -> bool {
        true
    }
    fn run(&self, request: &DecisionRequest, _: &dyn Cancel) -> Result<J, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.clock.0.lock().unwrap() += 7.0;
        let options = request.input.options.as_ref().ok_or(BackendError::Other)?;
        let pick = usize::from(request.input.state.ends_with('b'));
        let mut probabilities = J::Obj(Vec::new());
        for (i, o) in options.iter().enumerate() {
            probabilities.set(&o.id, J::Num(if i == pick { 0.8 } else { 0.2 }));
        }
        Ok(J::obj([
            ("id", J::s(&options[pick].id)),
            ("probabilities", probabilities),
            ("confidence", J::Num(self.confidence)),
        ]))
    }
}

struct Cfg(Value);
impl DecisionConfig for Cfg {
    fn config(&self) -> Value {
        self.0.clone()
    }
}

struct Ids;
impl IdSource for Ids {
    fn next_id(&self) -> String {
        "q".into()
    }
}

fn client(backend: BackendName, confidence: f64, local: bool) -> (DecisionClient, Arc<Fake>) {
    let clock = Arc::new(Mono(Mutex::new(1000.0)));
    let fake = Arc::new(Fake {
        clock: clock.clone(),
        calls: AtomicUsize::new(0),
        confidence,
        local,
    });
    let c = DecisionClient::new(DecisionOptions {
        config: Arc::new(Cfg(json!({ "decision": { "backend": backend.as_str() } }))),
        backends: vec![(backend, fake.clone())],
        emit: None,
        clock,
        ids: Arc::new(Ids),
    });
    (c, fake)
}

struct Src {
    faulty: Vec<&'static str>,
}

impl CaseSource for Src {
    fn input(&self, r: &Receipt) -> Result<DecisionInput, PortFault> {
        if self.faulty.contains(&r.turn_id.as_str()) {
            return Err(PortFault);
        }
        let suffix = r.turn_id.chars().last().unwrap();
        Ok(DecisionInput {
            use_case: UseCase::Routing,
            state: format!("{M_STATE}{suffix}"),
            question: M_QUESTION.into(),
            features: None,
            options: Some(vec![
                ChoiceOption {
                    id: "a".into(),
                    description: M_DESC.into(),
                },
                ChoiceOption {
                    id: "b".into(),
                    description: M_DESC.into(),
                },
            ]),
            levels: None,
        })
    }
}

#[derive(Clone, Copy)]
struct Gate {
    jev: Result<bool, PortFault>,
    local_only: Result<bool, PortFault>,
    egress: Result<bool, PortFault>,
    budget: Result<bool, PortFault>,
}

impl Gate {
    fn open() -> Self {
        Gate {
            jev: Ok(true),
            local_only: Ok(false),
            egress: Ok(true),
            budget: Ok(true),
        }
    }
}

impl ReplayGate for Gate {
    fn jev_opted_in(&self) -> Result<bool, PortFault> {
        self.jev
    }
    fn local_only(&self) -> Result<bool, PortFault> {
        self.local_only
    }
    fn egress_allows(&self, _: BackendName) -> Result<bool, PortFault> {
        self.egress
    }
    fn budget_allows(&self, _: BackendName, _: usize) -> Result<bool, PortFault> {
        self.budget
    }
}

/// Four cases: the candidate picks `a` for turns ending in `a` and `b` for turns ending in `b`.
fn cases_store(dir: &Path, order: &[&str], ids: &[&str]) -> ReceiptStore {
    let mut s = open_with(dir, &wall(1), Queue::of(ids), Retention::default());
    for turn in order {
        let stored = match *turn {
            "t1a" => Some("a"), // agrees
            "t2b" => Some("a"), // differs
            "t3a" => None,      // abstained
            _ => Some("b"),     // t4b agrees
        };
        let mut d = draft(turn, ReceiptUseCase::Routing, stored);
        d.duration_ms = 20;
        s.write(&d, false).unwrap();
    }
    s
}

fn set(kind: CaseKind, ids: &[&str]) -> CaseSet {
    CaseSet {
        kind,
        receipt_ids: ids.iter().map(|s| (*s).to_owned()).collect(),
    }
}

fn run(
    s: &ReceiptStore,
    who: &Principal,
    gate: Option<&Gate>,
    c: &DecisionClient,
    backend: BackendName,
    ids: &[&str],
) -> Result<ReplayReport, ReceiptError> {
    let src = Src { faulty: vec![] };
    let ports = ReplayPorts {
        gate: gate.map(|g| g as &dyn ReplayGate),
        source: Some(&src),
    };
    replay(
        s,
        who,
        &ports,
        &set(CaseKind::Final, ids),
        &Candidate {
            label: "cand-1",
            backend,
            prompt_version: "p2",
            client: c,
        },
    )
}

#[test]
fn replay_counts_agreement_difference_abstention_and_time() {
    let dir = tempfile::tempdir().unwrap();
    let s = cases_store(
        dir.path(),
        &["t1a", "t2b", "t3a", "t4b"],
        &["r1", "r2", "r3", "r4"],
    );
    let (c, fake) = client(BackendName::Laya, 0.9, true);
    let r = run(
        &s,
        &person(Role::Owner),
        Some(&Gate::open()),
        &c,
        BackendName::Laya,
        &["r4", "r1", "r3", "r2"],
    )
    .unwrap();
    assert_eq!((r.agreements, r.disagreements, r.both_abstained), (2, 2, 0));
    assert_eq!(
        (
            r.baseline_abstentions,
            r.candidate_abstentions,
            r.fallback_cases
        ),
        (1, 0, 0)
    );
    assert_eq!((r.baseline_ms, r.candidate_ms), (80, 28));
    assert_eq!((r.baseline_tokens_in, r.baseline_tokens_out), (400, 20));
    assert_eq!(r.receipt_ids, ["r1", "r2", "r3", "r4"]);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 4);
    assert!(r.verifies());
}

#[test]
fn a_candidate_abstention_is_counted_and_not_a_hit() {
    let dir = tempfile::tempdir().unwrap();
    let s = cases_store(
        dir.path(),
        &["t1a", "t2b", "t3a", "t4b"],
        &["r1", "r2", "r3", "r4"],
    );
    let (c, _) = client(BackendName::Laya, 0.1, true);
    let r = run(
        &s,
        &person(Role::Admin),
        Some(&Gate::open()),
        &c,
        BackendName::Laya,
        &["r1", "r2", "r3", "r4"],
    )
    .unwrap();
    assert_eq!(
        (
            r.agreements,
            r.disagreements,
            r.both_abstained,
            r.candidate_abstentions
        ),
        (0, 3, 1, 4)
    );
    assert!(r.failed.is_empty());
}

#[test]
fn a_fallback_never_counts_as_a_hit_and_failed_cases_stay() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open_with(
        dir.path(),
        &wall(1),
        Queue::of(&["r1", "r2"]),
        Retention::default(),
    );
    let mut d = draft("t1a", ReceiptUseCase::Routing, Some("a"));
    d.fallback = Some(Fallback {
        role: Some("small".into()),
        rules: vec!["rule.timeout".into()],
    });
    s.write(&d, false).unwrap();
    s.write(&draft("t2b", ReceiptUseCase::Routing, Some("b")), false)
        .unwrap();
    let (c, _) = client(BackendName::Laya, 0.9, true);
    let src = Src {
        faulty: vec!["t2b"],
    };
    let ports = ReplayPorts {
        gate: Some(&Gate::open()),
        source: Some(&src),
    };
    let cand = Candidate {
        label: "c",
        backend: BackendName::Laya,
        prompt_version: "p2",
        client: &c,
    };
    let r = replay(
        &s,
        &person(Role::Owner),
        &ports,
        &set(CaseKind::Final, &["r1", "r2", "gone"]),
        &cand,
    )
    .unwrap();
    assert_eq!(
        (r.agreements, r.fallback_cases),
        (0, 1),
        "same choice, but a fallback decided"
    );
    let classes: Vec<(&str, &str)> = r
        .failed
        .iter()
        .map(|f| (f.receipt_id.as_str(), f.class.as_str()))
        .collect();
    assert_eq!(classes, [("gone", "missing"), ("r2", "source")]);
}

#[test]
fn the_offer_miss_rate_comes_from_the_outcomes() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = open_with(
        dir.path(),
        &wall(1),
        Queue::of(&["r1"]),
        Retention::default(),
    );
    let mut d = draft("t1a", ReceiptUseCase::Tools, Some("a"));
    d.candidates = (0..8).map(|i| format!("tool{i}")).collect();
    d.result.choice = Some("tool0".into());
    d.result.distribution = vec![];
    s.write(&d, false).unwrap();
    s.record_outcome(
        "r1",
        &Outcome {
            used: vec![],
            reloaded: vec!["tool1".into(), "tool2".into()],
            tool_errors: vec![],
        },
    )
    .unwrap();
    let (c, _) = client(BackendName::Laya, 0.9, true);
    let r = run(
        &s,
        &person(Role::Owner),
        Some(&Gate::open()),
        &c,
        BackendName::Laya,
        &["r1"],
    )
    .unwrap();
    assert_eq!(
        (r.offer_offered, r.offer_reloaded, r.offer_miss_per_mille),
        (8, 2, Some(250))
    );
}

#[test]
fn the_same_receipts_give_the_same_report_in_any_write_order() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    // The same turn gets the same receipt id in both stores; only the order of writing differs.
    let s1 = cases_store(
        d1.path(),
        &["t1a", "t2b", "t3a", "t4b"],
        &["r1", "r2", "r3", "r4"],
    );
    let s2 = cases_store(
        d2.path(),
        &["t4b", "t3a", "t2b", "t1a"],
        &["r4", "r3", "r2", "r1"],
    );
    let (c, _) = client(BackendName::Laya, 0.9, true);
    let p = person(Role::Owner);
    let g = Gate::open();
    let a = run(
        &s1,
        &p,
        Some(&g),
        &c,
        BackendName::Laya,
        &["r1", "r2", "r3", "r4"],
    )
    .unwrap();
    let a2 = run(
        &s1,
        &p,
        Some(&g),
        &c,
        BackendName::Laya,
        &["r1", "r2", "r3", "r4"],
    )
    .unwrap();
    let b = run(
        &s2,
        &p,
        Some(&g),
        &c,
        BackendName::Laya,
        &["r3", "r1", "r4", "r2"],
    )
    .unwrap();
    assert_eq!(a.to_json(), a2.to_json(), "byte equal on repetition");
    assert_eq!(
        a.to_json(),
        b.to_json(),
        "and for another order of writing and of asking"
    );
    assert_eq!(a.report_hash, b.report_hash);
}

#[test]
fn the_report_holds_no_text() {
    let dir = tempfile::tempdir().unwrap();
    let s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let (c, _) = client(BackendName::Laya, 0.9, true);
    let r = run(
        &s,
        &person(Role::Owner),
        Some(&Gate::open()),
        &c,
        BackendName::Laya,
        &["r1", "r2"],
    )
    .unwrap();
    let all = format!("{}{r:?}", r.to_json());
    for m in MARKERS {
        assert!(!all.contains(m), "{m} in the report");
        assert!(
            !has(&bytes_of(dir.path()), m),
            "{m} in the store after a replay"
        );
    }
    let mut edited = r.clone();
    edited.agreements += 1;
    assert!(!edited.verifies(), "an edited report does not verify");
}

#[test]
fn replay_follows_the_rules_of_the_live_path() {
    let dir = tempfile::tempdir().unwrap();
    let s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let p = person(Role::Owner);
    let ids = ["r1", "r2"];
    let (laya, laya_fake) = client(BackendName::Laya, 0.9, true);
    let (jev, jev_fake) = client(BackendName::Jev, 0.9, false);
    let (role, role_fake) = client(BackendName::Role, 0.9, true);
    let calls = || {
        laya_fake.calls.load(Ordering::SeqCst)
            + jev_fake.calls.load(Ordering::SeqCst)
            + role_fake.calls.load(Ordering::SeqCst)
    };
    // a missing port refuses
    assert_eq!(
        run(&s, &p, None, &laya, BackendName::Laya, &ids),
        Err(ReceiptError::Port("replay ports"))
    );
    let g = Gate::open();
    let no_source = ReplayPorts {
        gate: Some(&g),
        source: None,
    };
    let cand = Candidate {
        label: "c",
        backend: BackendName::Laya,
        prompt_version: "p2",
        client: &laya,
    };
    assert!(replay(&s, &p, &no_source, &set(CaseKind::Final, &ids), &cand).is_err());
    // a port that fails refuses
    for (name, gate) in [
        (
            "localOnly",
            Gate {
                local_only: Err(PortFault),
                ..g
            },
        ),
        (
            "budget",
            Gate {
                budget: Err(PortFault),
                ..g
            },
        ),
    ] {
        assert_eq!(
            run(&s, &p, Some(&gate), &laya, BackendName::Laya, &ids),
            Err(ReceiptError::Port(name))
        );
    }
    assert_eq!(
        run(
            &s,
            &p,
            Some(&Gate {
                jev: Err(PortFault),
                ..g
            }),
            &jev,
            BackendName::Jev,
            &ids
        ),
        Err(ReceiptError::Port("jevOptIn"))
    );
    assert_eq!(
        run(
            &s,
            &p,
            Some(&Gate {
                egress: Err(PortFault),
                ..g
            }),
            &jev,
            BackendName::Jev,
            &ids
        ),
        Err(ReceiptError::Port("egress"))
    );
    // the rules themselves
    assert_eq!(
        run(
            &s,
            &p,
            Some(&Gate {
                jev: Ok(false),
                ..g
            }),
            &jev,
            BackendName::Jev,
            &ids
        ),
        Err(ReceiptError::Refused("jev-opt-in"))
    );
    assert_eq!(
        run(
            &s,
            &p,
            Some(&Gate {
                egress: Ok(false),
                ..g
            }),
            &jev,
            BackendName::Jev,
            &ids
        ),
        Err(ReceiptError::Refused("egress"))
    );
    assert_eq!(
        run(
            &s,
            &p,
            Some(&Gate {
                budget: Ok(false),
                ..g
            }),
            &laya,
            BackendName::Laya,
            &ids
        ),
        Err(ReceiptError::Refused("budget"))
    );
    let local_only = Gate {
        local_only: Ok(true),
        ..g
    };
    assert_eq!(
        run(&s, &p, Some(&local_only), &jev, BackendName::Jev, &ids),
        Err(ReceiptError::Refused("local-only"))
    );
    assert_eq!(
        run(&s, &p, Some(&local_only), &role, BackendName::Role, &ids),
        Err(ReceiptError::Refused("local-only"))
    );
    assert_eq!(calls(), 0, "no backend was asked in any refused replay");
    // a local backend still runs under "only local models"; jev runs with its opt-in
    assert!(run(&s, &p, Some(&local_only), &laya, BackendName::Laya, &ids).is_ok());
    assert!(run(&s, &p, Some(&g), &jev, BackendName::Jev, &ids).is_ok());
    assert!(jev_fake.calls.load(Ordering::SeqCst) > 0);
}

#[test]
fn replay_is_for_persons_of_owner_and_admin() {
    let dir = tempfile::tempdir().unwrap();
    let s = cases_store(dir.path(), &["t1a"], &["r1"]);
    let (c, fake) = client(BackendName::Laya, 0.9, true);
    let g = Gate::open();
    for role in ROLES {
        for kind in [
            None,
            Some(PrincipalKind::Agent),
            Some(PrincipalKind::Person),
        ] {
            let r = run(
                &s,
                &who(role, kind),
                Some(&g),
                &c,
                BackendName::Laya,
                &["r1"],
            );
            let allowed =
                matches!(role, Role::Owner | Role::Admin) && kind == Some(PrincipalKind::Person);
            assert_eq!(r.is_ok(), allowed, "{role:?} {kind:?}");
            if !allowed {
                assert_eq!(r.unwrap_err(), ReceiptError::Denied);
            }
        }
    }
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        2,
        "only the two permitted runs asked the backend"
    );
    assert!(run(
        &s,
        &person(Role::Owner),
        Some(&g),
        &c,
        BackendName::Laya,
        &[]
    )
    .is_err());
    assert!(run(
        &s,
        &person(Role::Owner),
        Some(&g),
        &c,
        BackendName::Laya,
        &["bad id"]
    )
    .is_err());
}

// ---- adoption ----

struct Audit {
    log: Arc<Mutex<Vec<String>>>,
    fail: bool,
}

impl crate::rbac::audit::AuditSink for Audit {
    fn append(&mut self, e: &AuditEvent) -> Result<(), String> {
        if self.fail {
            return Err("disk full".into());
        }
        self.log
            .lock()
            .unwrap()
            .push(format!("audit:{}:{}", e.action, e.user));
        Ok(())
    }
}

/// A port that notes in the shared log when the record is written.
struct LoggedRecords {
    inner: MemoryCalibrationRecords,
    log: Arc<Mutex<Vec<String>>>,
}

impl CalibrationRecords for LoggedRecords {
    fn current(&self) -> Result<Option<CalibrationRecord>, PortFault> {
        self.inner.current()
    }
    fn versions(&self) -> Result<Vec<CalibrationRecord>, PortFault> {
        self.inner.versions()
    }
    fn append(&mut self, r: CalibrationRecord) -> Result<(), PortFault> {
        self.inner.append(r)?;
        self.log.lock().unwrap().push("append".into());
        Ok(())
    }
}

fn final_report(s: &ReceiptStore) -> ReplayReport {
    let (c, _) = client(BackendName::Laya, 0.9, true);
    run(
        s,
        &person(Role::Owner),
        Some(&Gate::open()),
        &c,
        BackendName::Laya,
        &["r1", "r2"],
    )
    .unwrap()
}

#[test]
fn adopting_writes_the_audit_line_first_and_a_new_version() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let report = final_report(&s);
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut audit = Audit {
        log: log.clone(),
        fail: false,
    };
    let old = CalibrationRecord {
        version: 1,
        backend: "role".into(),
        prompt_version: "p1".into(),
        report_hash: "0".repeat(64),
        adopted_by: "u0".into(),
        adopted_at: 1,
    };
    let mut records = LoggedRecords {
        inner: MemoryCalibrationRecords {
            list: vec![old.clone()],
            fail_append: false,
        },
        log: log.clone(),
    };
    let dev = vec!["d1".to_owned()];
    let req = AdoptRequest {
        who: &person(Role::Admin),
        report: &report,
        development_ids: &dev,
        host: "h1",
    };
    let new = s.adopt(&req, &mut records, &mut audit).unwrap();
    assert_eq!(
        (new.version, new.backend.as_str(), new.adopted_by.as_str()),
        (2, "laya", "u1")
    );
    assert_eq!(
        *log.lock().unwrap(),
        ["audit:decision.baseline.adopt:u1", "append"],
        "the audit line comes before the effect"
    );
    let versions = records.versions().unwrap();
    assert_eq!(versions[0], old, "the old baseline stays readable");
    assert_eq!(versions.len(), 2);
    assert_eq!(s.adoption_count().unwrap(), 1);
}

#[test]
fn without_its_audit_line_nothing_happens() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let report = final_report(&s);
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut audit = Audit {
        log: log.clone(),
        fail: true,
    };
    let mut records = MemoryCalibrationRecords::default();
    let dev = vec!["d1".to_owned()];
    let req = AdoptRequest {
        who: &person(Role::Owner),
        report: &report,
        development_ids: &dev,
        host: "h1",
    };
    assert_eq!(
        s.adopt(&req, &mut records, &mut audit),
        Err(ReceiptError::Port("audit"))
    );
    assert!(records.list.is_empty());
    assert_eq!(s.adoption_count().unwrap(), 0);
}

#[test]
fn an_interrupted_adoption_leaves_the_old_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let report = final_report(&s);
    let old = CalibrationRecord {
        version: 1,
        backend: "role".into(),
        prompt_version: "p1".into(),
        report_hash: "0".repeat(64),
        adopted_by: "u0".into(),
        adopted_at: 1,
    };
    let mut records = MemoryCalibrationRecords {
        list: vec![old.clone()],
        fail_append: true,
    };
    let mut audit = Audit {
        log: Arc::new(Mutex::new(Vec::new())),
        fail: false,
    };
    let dev = vec!["d1".to_owned()];
    let req = AdoptRequest {
        who: &person(Role::Owner),
        report: &report,
        development_ids: &dev,
        host: "h1",
    };
    assert_eq!(
        s.adopt(&req, &mut records, &mut audit),
        Err(ReceiptError::Port("calibration"))
    );
    assert_eq!(records.list, [old], "the old baseline is unchanged");
    assert_eq!(
        s.adoption_count().unwrap(),
        0,
        "the transaction was rolled back"
    );
    records.fail_append = false;
    assert!(
        s.adopt(&req, &mut records, &mut audit).is_ok(),
        "and a later try works"
    );
    assert_eq!(s.adoption_count().unwrap(), 1);
}

#[test]
fn adopting_is_for_persons_of_owner_and_admin() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let report = final_report(&s);
    let dev = vec!["d1".to_owned()];
    for role in ROLES {
        for kind in [
            None,
            Some(PrincipalKind::Agent),
            Some(PrincipalKind::Person),
        ] {
            let mut records = MemoryCalibrationRecords::default();
            let mut audit = Audit {
                log: Arc::new(Mutex::new(Vec::new())),
                fail: false,
            };
            let p = who(role, kind);
            let req = AdoptRequest {
                who: &p,
                report: &report,
                development_ids: &dev,
                host: "h1",
            };
            let r = s.adopt(&req, &mut records, &mut audit);
            let allowed =
                matches!(role, Role::Owner | Role::Admin) && kind == Some(PrincipalKind::Person);
            assert_eq!(r.is_ok(), allowed, "{role:?} {kind:?}");
            if !allowed {
                assert_eq!(r, Err(ReceiptError::Denied));
                assert!(
                    records.list.is_empty() && audit.log.lock().unwrap().is_empty(),
                    "denied before audit and effect"
                );
            }
        }
    }
}

#[test]
fn only_a_closing_comparison_on_other_cases_is_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = cases_store(dir.path(), &["t1a", "t2b"], &["r1", "r2"]);
    let report = final_report(&s);
    let mut records = MemoryCalibrationRecords::default();
    let mut audit = Audit {
        log: Arc::new(Mutex::new(Vec::new())),
        fail: false,
    };
    let owner = person(Role::Owner);
    let mut try_adopt = |report: &ReplayReport, dev: &[String]| {
        s.adopt(
            &AdoptRequest {
                who: &owner,
                report,
                development_ids: dev,
                host: "h1",
            },
            &mut records,
            &mut audit,
        )
    };
    let shared = vec!["r2".to_owned()];
    assert_eq!(
        try_adopt(&report, &shared),
        Err(ReceiptError::Refused("sets overlap"))
    );
    assert_eq!(
        try_adopt(&report, &[]),
        Err(ReceiptError::Refused("no cases"))
    );
    let mut development = report.clone();
    development.set = CaseKind::Development;
    development.report_hash = String::new();
    development.report_hash = {
        // re-sealed, so only the kind is wrong
        let mut x = development.clone();
        x.report_hash = String::new();
        let mut y = x.clone();
        y.report_hash = String::new();
        let t = serde_json::to_string(&y).unwrap();
        use sha2::{Digest, Sha256};
        Sha256::digest(t.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    assert!(development.verifies());
    assert_eq!(
        try_adopt(&development, &["d1".to_owned()]),
        Err(ReceiptError::Refused("not a final set"))
    );
    let mut forged = report.clone();
    forged.agreements = 99;
    assert_eq!(
        try_adopt(&forged, &["d1".to_owned()]),
        Err(ReceiptError::Invalid("report"))
    );
}
