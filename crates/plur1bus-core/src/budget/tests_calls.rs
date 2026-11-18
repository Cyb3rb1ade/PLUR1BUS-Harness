//! The call port (`budget/calls.ts`), the A2A peer budget (`budget/peer.ts`, ported from `peer.test.ts`) and the licence
//! ledger (`licences/*`, ported from `licences/ledger.test.ts`). The call port has no test file of its own in TypeScript (its
//! callers' tests exercise it); these tests follow the source's comments and `reservations.test.ts`.
use super::calls::*;
use super::licences::*;
use super::peer::*;
use super::service::Metric;
use super::tests::{rig, TestClock, DAY, HOUR, T0};
use super::vectors::RuleZones;
use super::{BudgetError, StoreErrorCode, UuidIds};
use crate::budget::period::CallPeriod;
use crate::rbac::audit::{AuditEvent, AuditSink};
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Events(Mutex<Vec<CallBudgetEvent>>);

impl BudgetEmitter for Events {
    fn emit(&self, e: &CallBudgetEvent) {
        self.0.lock().unwrap().push(e.clone());
    }
}

fn gate_at(
    path: &Path,
    clock: Arc<TestClock>,
    events: Option<Arc<Events>>,
    ttl: Option<i64>,
) -> CallBudget {
    CallBudget::open(CallBudgetOptions {
        path,
        clock,
        zones: Arc::new(RuleZones),
        ids: Arc::new(UuidIds),
        emitter: events.map(|e| e as Arc<dyn BudgetEmitter>),
        default_time_zone: None,
        secure_path: None,
        busy_timeout_ms: None,
        reservation_ttl_ms: ttl,
    })
    .unwrap()
}

fn req(tokens_in: i64, tokens_out: i64) -> CallRequest<'static> {
    CallRequest {
        principal: "u1",
        agent: "a1",
        project: "p1",
        model: "m",
        estimated_input_tokens: tokens_in,
        max_output_tokens: tokens_out,
        ..Default::default()
    }
}

fn user_limit(hard: i64, soft: Option<i64>) -> CallLimit {
    CallLimit {
        scope: CallScope::User,
        id: "u1".into(),
        period: CallPeriod::Day,
        metric: Metric::Tokens,
        hard,
        soft,
    }
}

fn allow(d: CallDecision) -> CallAllowance {
    match d {
        CallDecision::Allow(a) => a,
        CallDecision::Refuse(r) => panic!("refused: {r:?}"),
    }
}

fn refuse(d: CallDecision) -> CallRefusal {
    match d {
        CallDecision::Refuse(r) => r,
        CallDecision::Allow(a) => panic!("allowed: {a:?}"),
    }
}

fn used(input: i64, output: i64) -> ActualCallUsage {
    ActualCallUsage {
        input_tokens: input,
        output_tokens: output,
        ..Default::default()
    }
}

struct Fx {
    gate: CallBudget,
    clock: Arc<TestClock>,
    events: Arc<Events>,
    rig: super::tests::Rig,
}

fn fx(ttl: Option<i64>) -> Fx {
    let r = rig();
    let events = Arc::new(Events::default());
    let gate = gate_at(&r.path, r.clock.clone(), Some(events.clone()), ttl);
    Fx {
        gate,
        clock: r.clock.clone(),
        events,
        rig: r,
    }
}

// --- admission ----------------------------------------------------------------------------------------------------------

#[test]
fn a_call_that_lands_exactly_on_the_hard_limit_is_admitted_and_the_next_token_is_refused() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let a = allow(f.gate.check_before_call(&req(60, 40)).unwrap());
    assert_eq!(a.estimated_tokens, 100);
    let r = refuse(f.gate.check_before_call(&req(1, 0)).unwrap());
    assert_eq!(
        (r.scope, r.limit, r.used, r.estimate, r.id.as_str()),
        (CallScope::User, 100, 100, 1, "u1")
    );
    assert_eq!(r.resets_at, T0 - 12 * HOUR + DAY);
    assert!(matches!(
        f.events.0.lock().unwrap().last(),
        Some(CallBudgetEvent::Refuse(_))
    ));
}

#[test]
fn a_refusal_names_the_limit_that_is_furthest_over_first() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    f.gate
        .set_limit(&CallLimit {
            scope: CallScope::Agent,
            id: "a1".into(),
            period: CallPeriod::Day,
            metric: Metric::Tokens,
            hard: 10,
            soft: None,
        })
        .unwrap();
    let r = refuse(f.gate.check_before_call(&req(50, 0)).unwrap());
    assert_eq!(
        (r.scope, r.limit),
        (CallScope::Agent, 10),
        "50 over 10 is further over than 50 under 100"
    );
}

#[test]
fn a_reservation_counts_until_it_settles_and_settling_replaces_the_estimate_with_the_actual() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let a = allow(f.gate.check_before_call(&req(60, 40)).unwrap());
    refuse(f.gate.check_before_call(&req(1, 0)).unwrap());
    let s = f.gate.settle(&a.reservation_id, &used(5, 5)).unwrap();
    assert!(s.recorded && s.overages.is_empty());
    allow(f.gate.check_before_call(&req(90, 0)).unwrap()); // 10 settled + 90
    let v = f.gate.reservation(&a.reservation_id).unwrap().unwrap();
    assert!(v.settled && v.tokens == 10 && !v.expired);
    let again = f.gate.settle(&a.reservation_id, &used(500, 500)).unwrap();
    assert!(
        !again.recorded && again.overages.is_empty(),
        "a second settlement is a no-op"
    );
    assert_eq!(
        f.gate
            .reservation(&a.reservation_id)
            .unwrap()
            .unwrap()
            .tokens,
        10
    );
}

#[test]
fn an_actual_over_the_limit_is_recorded_and_reported_as_an_overage() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let a = allow(f.gate.check_before_call(&req(10, 10)).unwrap());
    let s = f.gate.settle(&a.reservation_id, &used(150, 0)).unwrap();
    assert!(s.recorded);
    assert_eq!(s.overages.len(), 1);
    assert_eq!((s.overages[0].used, s.overages[0].limit), (150, 100));
    assert!(matches!(
        f.events
            .0
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|e| matches!(e, CallBudgetEvent::Settle { .. })),
        Some(CallBudgetEvent::Settle { tokens: 150, .. })
    ));
}

#[test]
fn release_unused_frees_the_capacity_of_an_unsettled_reservation_only() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let a = allow(f.gate.check_before_call(&req(100, 0)).unwrap());
    f.gate.release_unused(&a.reservation_id).unwrap();
    assert_eq!(f.gate.reservation(&a.reservation_id).unwrap(), None);
    let b = allow(f.gate.check_before_call(&req(100, 0)).unwrap());
    f.gate.settle(&b.reservation_id, &used(100, 0)).unwrap();
    f.gate.release_unused(&b.reservation_id).unwrap(); // a settled call is billed: it stays
    assert!(
        f.gate
            .reservation(&b.reservation_id)
            .unwrap()
            .unwrap()
            .settled
    );
    assert!(matches!(
        f.events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, CallBudgetEvent::Release { .. }))
            .count(),
        1
    ));
}

#[test]
fn settling_an_unknown_reservation_is_refused() {
    let f = fx(None);
    assert!(f.gate.settle("nope", &used(1, 1)).is_err());
}

// --- the TTL ------------------------------------------------------------------------------------------------------------

#[test]
fn a_pending_reservation_counts_across_the_rollover_until_its_ttl_then_stops() {
    let f = fx(Some(30 * 60_000));
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    f.clock.set(T0 - 12 * HOUR + DAY - 10 * 60_000); // 23:50
    allow(f.gate.check_before_call(&req(60, 0)).unwrap());
    f.clock.advance(20 * 60_000); // 00:10 the next day, 20 minutes old
    let r = refuse(f.gate.check_before_call(&req(50, 0)).unwrap());
    assert_eq!(
        r.used, 60,
        "the stalled request still holds capacity in the new period"
    );
    f.clock.advance(11 * 60_000); // 31 minutes old: past the TTL
    allow(f.gate.check_before_call(&req(50, 0)).unwrap());
}

#[test]
fn an_expired_reservation_is_reported_then_reconciled_with_an_expire_event() {
    let f = fx(Some(60_000));
    let a = allow(f.gate.check_before_call(&req(10, 0)).unwrap());
    assert_eq!(f.gate.pending_reservations().unwrap(), (1, 0));
    f.clock.advance(60_001);
    assert_eq!(f.gate.pending_reservations().unwrap(), (0, 1));
    assert!(
        f.gate
            .reservation(&a.reservation_id)
            .unwrap()
            .unwrap()
            .expired
    );
    assert_eq!(f.gate.reconcile_expired().unwrap(), 1);
    assert_eq!(f.gate.reservation(&a.reservation_id).unwrap(), None);
    assert!(matches!(
        f.events.0.lock().unwrap().last(),
        Some(CallBudgetEvent::Expire { tokens: 10, .. })
    ));
    assert_eq!(f.gate.reconcile_expired().unwrap(), 0);
}

#[test]
fn an_invalid_ttl_is_refused() {
    let r = rig();
    for ttl in [0, -1] {
        let e = CallBudget::open(CallBudgetOptions {
            path: &r.path,
            clock: r.clock.clone(),
            zones: Arc::new(RuleZones),
            ids: Arc::new(UuidIds),
            emitter: None,
            default_time_zone: None,
            secure_path: None,
            busy_timeout_ms: None,
            reservation_ttl_ms: Some(ttl),
        })
        .err()
        .expect("refused");
        assert_eq!(e.to_string(), "invalid reservation ttl");
    }
}

// --- weights, units, schema ---------------------------------------------------------------------------------------------

#[test]
fn a_settled_call_counts_its_cache_reads_with_the_weight_and_a_pending_one_its_estimate() {
    let f = fx(None);
    f.rig.svc.set_cache_read_weight(0.0).unwrap();
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let a = allow(f.gate.check_before_call(&req(100, 0)).unwrap());
    refuse(f.gate.check_before_call(&req(1, 0)).unwrap());
    f.gate
        .settle(
            &a.reservation_id,
            &ActualCallUsage {
                input_tokens: 100,
                cache_read_tokens: Some(90),
                ..Default::default()
            },
        )
        .unwrap();
    let r = refuse(f.gate.check_before_call(&req(91, 0)).unwrap());
    assert_eq!(
        r.used, 10,
        "90 of the 100 settled input tokens were cache reads, weight 0"
    );
    allow(f.gate.check_before_call(&req(90, 0)).unwrap());
}

#[test]
fn image_and_video_limits_count_units_and_a_delivery_beyond_the_reservation_is_an_overage() {
    let f = fx(None);
    f.gate
        .set_limit(&CallLimit {
            scope: CallScope::Global,
            id: String::new(),
            period: CallPeriod::Day,
            metric: Metric::Images,
            hard: 3,
            soft: None,
        })
        .unwrap();
    let a = allow(
        f.gate
            .check_before_call(&CallRequest {
                images: Some(2),
                ..req(1, 1)
            })
            .unwrap(),
    );
    assert_eq!(a.media.images, 2);
    let r = refuse(
        f.gate
            .check_before_call(&CallRequest {
                images: Some(2),
                ..req(1, 1)
            })
            .unwrap(),
    );
    assert_eq!(
        (r.metric, r.used, r.estimate, r.limit),
        (Metric::Images, 2, 2, 3)
    );
    let s = f
        .gate
        .settle(
            &a.reservation_id,
            &ActualCallUsage {
                input_tokens: 1,
                images: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(s.overages.len(), 1);
    assert_eq!(s.overages[0].used, 5);
}

#[test]
fn a_soft_limit_warns_once_a_period_at_admission() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, Some(10))).unwrap();
    allow(f.gate.check_before_call(&req(20, 0)).unwrap());
    allow(f.gate.check_before_call(&req(20, 0)).unwrap());
    let warns = f
        .events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, CallBudgetEvent::Warn { .. }))
        .count();
    assert_eq!(warns, 1);
}

fn warn_count(f: &Fx) -> usize {
    f.events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, CallBudgetEvent::Warn { .. }))
        .count()
}

#[test]
fn a_soft_limit_is_reached_at_the_bound_and_defaults_to_eighty_percent_of_hard() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, Some(10))).unwrap();
    allow(f.gate.check_before_call(&req(9, 0)).unwrap());
    assert_eq!(warn_count(&f), 0, "9 of 10");
    allow(f.gate.check_before_call(&req(1, 0)).unwrap());
    assert_eq!(
        warn_count(&f),
        1,
        "10 of 10 warns: the call port counts a soft limit as reached AT it"
    );

    let g = fx(None);
    g.gate.set_limit(&user_limit(100, None)).unwrap();
    allow(g.gate.check_before_call(&req(79, 0)).unwrap());
    assert_eq!(warn_count(&g), 0, "79 of floor(100 * 0.8)");
    allow(g.gate.check_before_call(&req(1, 0)).unwrap());
    assert_eq!(warn_count(&g), 1, "80 of 80");
}

#[test]
fn a_future_call_schema_is_refused_before_anything_changes() {
    let r = rig();
    let c = plur1bus_store::rusqlite::Connection::open(&r.path).unwrap();
    c.execute(
        "INSERT INTO settings VALUES ('budget_call_schema','999')",
        [],
    )
    .unwrap();
    drop(c);
    let e = CallBudget::open(CallBudgetOptions {
        path: &r.path,
        clock: r.clock.clone(),
        zones: Arc::new(RuleZones),
        ids: Arc::new(UuidIds),
        emitter: None,
        default_time_zone: None,
        secure_path: None,
        busy_timeout_ms: None,
        reservation_ttl_ms: None,
    })
    .err()
    .expect("refused");
    assert!(
        matches!(
            e,
            BudgetError::Store {
                code: StoreErrorCode::NewerSchema,
                ..
            }
        ),
        "{e}"
    );
    assert!(e.to_string().contains("unsupported"), "{e}");
    let c = plur1bus_store::rusqlite::Connection::open(&r.path).unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'budget_call'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "the call tables were not created");
}

#[test]
fn malformed_requests_are_refused_without_a_reservation() {
    let f = fx(None);
    for bad in [
        CallRequest {
            principal: "",
            ..req(1, 1)
        },
        CallRequest {
            agent: "a b",
            ..req(1, 1)
        },
        req(-1, 1),
        req(1, -1),
        CallRequest {
            images: Some(-1),
            ..req(1, 1)
        },
        CallRequest {
            turn: Some(""),
            ..req(1, 1)
        },
    ] {
        assert!(f.gate.check_before_call(&bad).is_err(), "{bad:?}");
    }
    assert_eq!(f.gate.pending_reservations().unwrap(), (0, 0));
}

// --- run ----------------------------------------------------------------------------------------------------------------

#[test]
fn run_settles_on_success_and_keeps_the_reservation_pending_on_failure() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let ok: Result<&str, RunError<()>> = f.gate.run(&req(10, 10), || Ok(("v", used(4, 4))));
    assert_eq!(ok.unwrap(), "v");
    assert_eq!(f.gate.pending_reservations().unwrap(), (0, 0));
    let bad: Result<&str, RunError<&str>> = f.gate.run(&req(10, 10), || Err("boom"));
    match bad.unwrap_err() {
        RunError::UsagePending {
            reservation_id,
            cause: RunCause::Call("boom"),
        } => {
            assert!(
                !f.gate
                    .reservation(&reservation_id)
                    .unwrap()
                    .unwrap()
                    .settled
            );
            assert_eq!(f.gate.pending_reservations().unwrap(), (1, 0));
            f.gate.settle(&reservation_id, &used(1, 1)).unwrap();
        }
        other => panic!("{other:?}"),
    }
    let refused: Result<&str, RunError<()>> = f.gate.run(&req(500, 0), || panic!("never called"));
    assert!(matches!(refused, Err(RunError::Refused(_))));
}

#[test]
fn simultaneous_connections_reserve_under_a_write_lock_with_no_oversubscription() {
    let f = fx(None);
    f.gate.set_limit(&user_limit(100, None)).unwrap();
    let path = f.rig.path.clone();
    let clock = f.clock.clone();
    let allowed: usize = std::thread::scope(|s| {
        let hs: Vec<_> = (0..6)
            .map(|_| {
                let (p, c) = (path.clone(), clock.clone());
                s.spawn(move || {
                    let g = gate_at(&p, c, None, None);
                    usize::from(matches!(
                        g.check_before_call(&req(40, 0)).unwrap(),
                        CallDecision::Allow(_)
                    ))
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).sum()
    });
    assert_eq!(allowed, 2);
}

// --- the A2A peer budget (peer.test.ts) ---------------------------------------------------------------------------------

const ID: PeerBudgetIdentity<'static> = PeerBudgetIdentity {
    person: "person",
    agent: "main",
    session: "session",
    turn: "turn",
    peer: "peer",
};
const LIMITS: PeerBudgetLimits = PeerBudgetLimits {
    peer_calls: 2,
    turn_calls: 3,
    peer_tokens: 100,
    turn_tokens: 150,
};

fn peer_at(path: &Path, now: Arc<TestClock>) -> PeerCallBudget {
    PeerCallBudget::open(path, now, Arc::new(UuidIds)).unwrap()
}

fn is_allow(d: &PeerBudgetDecision) -> bool {
    matches!(d, PeerBudgetDecision::Allow(_))
}

fn allow_id(d: PeerBudgetDecision) -> String {
    match d {
        PeerBudgetDecision::Allow(id) => id,
        PeerBudgetDecision::Refuse => panic!("refused"),
    }
}

#[test]
fn peer_reserves_capacity_before_a_call_and_settles_accepted_counts_once() {
    let dir = tempfile::tempdir().unwrap();
    let b = peer_at(&dir.path().join("budget.sqlite"), TestClock::new(123));
    let first = allow_id(b.reserve(&ID, 70, &LIMITS).unwrap());
    assert!(!is_allow(&b.reserve(&ID, 40, &LIMITS).unwrap()));
    b.finish(&first, 30).unwrap();
    b.finish(&first, 30).unwrap();
    assert!(is_allow(&b.reserve(&ID, 70, &LIMITS).unwrap()));
    assert!(
        !is_allow(&b.reserve(&ID, 0, &LIMITS).unwrap()),
        "two admitted calls exhaust the per-peer call cap"
    );
}

#[test]
fn peer_and_shared_turn_ceilings_apply_without_crossing_identities() {
    let dir = tempfile::tempdir().unwrap();
    let b = peer_at(&dir.path().join("budget.sqlite"), TestClock::new(123));
    let other = PeerBudgetIdentity {
        peer: "other",
        ..ID
    };
    assert!(is_allow(&b.reserve(&ID, 80, &LIMITS).unwrap()));
    assert!(!is_allow(&b.reserve(&other, 80, &LIMITS).unwrap()));
    assert!(is_allow(&b.reserve(&other, 70, &LIMITS).unwrap()));
    assert!(
        !is_allow(
            &b.reserve(
                &PeerBudgetIdentity {
                    agent: "another-agent",
                    peer: "third",
                    ..ID
                },
                1,
                &LIMITS
            )
            .unwrap()
        ),
        "helpers cannot reset the shared turn budget"
    );
    assert!(is_allow(
        &b.reserve(
            &PeerBudgetIdentity {
                person: "another",
                ..ID
            },
            80,
            &LIMITS
        )
        .unwrap()
    ));
    assert!(is_allow(
        &b.reserve(&PeerBudgetIdentity { turn: "next", ..ID }, 80, &LIMITS)
            .unwrap()
    ));
}

#[test]
fn peer_reservations_persist_across_connections_and_only_proven_unused_requests_are_refunded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.sqlite");
    let first = {
        let b = peer_at(&path, TestClock::new(123));
        allow_id(b.reserve(&ID, 100, &LIMITS).unwrap())
    };
    let reopened = peer_at(&path, TestClock::new(456));
    assert!(!is_allow(&reopened.reserve(&ID, 1, &LIMITS).unwrap()));
    reopened.cancel(&first).unwrap();
    assert!(is_allow(&reopened.reserve(&ID, 100, &LIMITS).unwrap()));
}

#[test]
fn peer_refuses_invalid_identities_fractions_and_settlement_beyond_the_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let b = peer_at(&dir.path().join("budget.sqlite"), TestClock::new(123));
    for e in [
        b.reserve(&PeerBudgetIdentity { turn: "", ..ID }, 0, &LIMITS)
            .unwrap_err(),
        b.reserve(&ID, -1, &LIMITS).unwrap_err(),
    ] {
        assert_eq!(e.to_string(), "invalid peer budget input");
    }
    let accepted = allow_id(b.reserve(&ID, 20, &LIMITS).unwrap());
    assert_eq!(
        b.finish(&accepted, 21).unwrap_err().to_string(),
        "invalid peer budget input"
    );
    assert!(!is_allow(&b.reserve(&ID, 81, &LIMITS).unwrap()));
}

#[test]
fn peer_reservations_from_independent_connections_serialise() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.sqlite");
    let (a, b) = (
        peer_at(&path, TestClock::new(123)),
        peer_at(&path, TestClock::new(123)),
    );
    assert!(is_allow(&a.reserve(&ID, 80, &LIMITS).unwrap()));
    assert!(!is_allow(&b.reserve(&ID, 21, &LIMITS).unwrap()));
    assert!(is_allow(&b.reserve(&ID, 20, &LIMITS).unwrap()));
    assert!(!is_allow(&a.reserve(&ID, 0, &LIMITS).unwrap()));
}

#[test]
fn peer_compacts_expired_rows_without_resetting_replayed_turn_quotas_or_refunding_orphans() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("budget.sqlite");
    let now = TestClock::new(1_000);
    let b = peer_at(&path, now.clone());
    let spent = allow_id(b.reserve(&ID, 40, &LIMITS).unwrap());
    b.finish(&spent, 20).unwrap();
    let cancelled = allow_id(b.reserve(&ID, 10, &LIMITS).unwrap());
    b.cancel(&cancelled).unwrap();
    assert!(is_allow(&b.reserve(&ID, 80, &LIMITS).unwrap())); // the orphan
    now.advance(31 * DAY);
    assert!(!is_allow(&b.reserve(&ID, 0, &LIMITS).unwrap()));
    let c = plur1bus_store::rusqlite::Connection::open_with_flags(
        &path,
        plur1bus_store::rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM a2a_peer_call", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
    drop(c);
    let reopened = peer_at(&path, now.clone());
    assert!(!is_allow(
        &reopened
            .reserve(
                &PeerBudgetIdentity {
                    peer: "other",
                    ..ID
                },
                51,
                &LIMITS
            )
            .unwrap()
    ));
    assert!(is_allow(
        &reopened
            .reserve(
                &PeerBudgetIdentity {
                    turn: "new-turn",
                    ..ID
                },
                100,
                &LIMITS
            )
            .unwrap()
    ));
    assert!(!is_allow(&reopened.reserve(&ID, 0, &LIMITS).unwrap()));
}

// --- the licence ledger (licences/ledger.test.ts) -----------------------------------------------------------------------

const MODEL: &str = "jinaai/jina-embeddings-v3";
const REVISION: &str = "68ed94909d564380f954be27ae2e133214c1adc9";

fn catalogue() -> NcCatalogue {
    NcCatalogue {
        licence: "CC BY-NC-4.0".into(),
        models: vec![NcModel {
            model: MODEL.into(),
            revision: REVISION.into(),
        }],
        superseded: vec![(
            "jinaai/jina-embeddings-v5-text-nano".into(),
            "use the pinned Jina v5 retrieval model".into(),
        )],
    }
}

#[derive(Clone, Default)]
struct Audit(Arc<Mutex<Vec<AuditEvent>>>);

impl AuditSink for Audit {
    fn append(&mut self, e: &AuditEvent) -> Result<(), String> {
        self.0.lock().unwrap().push(e.clone());
        Ok(())
    }
}

struct FailingAudit;

impl AuditSink for FailingAudit {
    fn append(&mut self, _: &AuditEvent) -> Result<(), String> {
        Err("disk-full".into())
    }
}

fn change() -> Vec<(String, serde_json::Value)> {
    vec![("engine.embedding.local.model".into(), json!(MODEL))]
}

#[test]
fn a_full_acceptance_is_audited_and_survives_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("licences.sqlite");
    let audit = Audit::default();
    let mut ledger =
        LicenceLedger::open(&path, Box::new(audit.clone()), TestClock::new(12_345)).unwrap();
    let cat = catalogue();
    assert!(check_memory_selection(&cat, &ledger, "owner", &change(), None).is_err());
    let m = cat.memory_model(MODEL).unwrap();
    let acceptance = ledger
        .confirm(
            "owner",
            &m.model,
            &m.licence,
            &m.revision,
            LicenceSource::Memory,
        )
        .unwrap();
    drop(ledger);
    let reopened =
        LicenceLedger::open(&path, Box::new(audit.clone()), TestClock::new(99_999)).unwrap();
    assert_eq!(reopened.list().unwrap(), vec![acceptance.clone()]);
    assert_eq!(
        (acceptance.who.as_str(), acceptance.at.as_str()),
        ("owner", "1970-01-01T00:00:12.345Z")
    );
    assert_eq!(
        (acceptance.revision.as_str(), acceptance.source.as_str()),
        (REVISION, "memory")
    );
    check_memory_selection(&cat, &reopened, "owner", &change(), None).unwrap();
    assert!(check_memory_selection(&cat, &reopened, "other", &change(), None).is_err());
    assert_eq!(audit.0.lock().unwrap()[0].action, "model.licence.confirmed");
}

#[test]
fn an_audit_failure_prevents_the_confirmation_from_persisting() {
    let dir = tempfile::tempdir().unwrap();
    let mut ledger = LicenceLedger::open(
        &dir.path().join("l.sqlite"),
        Box::new(FailingAudit),
        TestClock::new(1),
    )
    .unwrap();
    assert!(ledger
        .confirm(
            "owner",
            "model",
            "licence",
            "revision",
            LicenceSource::Voice
        )
        .is_err());
    assert!(ledger.list().unwrap().is_empty());
}

#[test]
fn a_confirmation_for_one_pinned_revision_cannot_authorise_another() {
    let dir = tempfile::tempdir().unwrap();
    let mut ledger = LicenceLedger::open(
        &dir.path().join("l.sqlite"),
        Box::new(Audit::default()),
        TestClock::new(1),
    )
    .unwrap();
    let cat = catalogue();
    let m = cat.memory_model(MODEL).unwrap();
    ledger
        .confirm(
            "owner",
            &m.model,
            &m.licence,
            &m.revision,
            LicenceSource::Memory,
        )
        .unwrap();
    let other_rev = vec![(
        "engine.embedding.local".to_owned(),
        json!({"model": MODEL, "revision": "other"}),
    )];
    assert!(check_memory_selection(&cat, &ledger, "owner", &other_rev, None).is_err());
    let rev_key = vec![("engine.embedding.local.revision".to_owned(), json!("other"))];
    let current = json!({"engine": {"embedding": {"local": {"model": MODEL}}}});
    assert!(check_memory_selection(&cat, &ledger, "owner", &rev_key, Some(&current)).is_err());
    assert!(
        cat.memory_model("jinaai/jina-embeddings-v5-text-nano")
            .is_err(),
        "a superseded model has no revision to pin"
    );
}

#[test]
fn a_repeated_confirmation_keeps_the_first_row_and_its_time() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::new(1_000);
    let mut ledger = LicenceLedger::open(
        &dir.path().join("l.sqlite"),
        Box::new(Audit::default()),
        clock.clone(),
    )
    .unwrap();
    let first = ledger
        .confirm("owner", "m", "l", "r", LicenceSource::Memory)
        .unwrap();
    clock.advance(5_000);
    let second = ledger
        .confirm("owner", "m", "l", "r", LicenceSource::Memory)
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(ledger.list().unwrap().len(), 1);
    assert!(ledger.has("owner", "m", "l", "r").unwrap());
    assert!(!ledger.has("owner", "m", "l", "r2").unwrap());
}
