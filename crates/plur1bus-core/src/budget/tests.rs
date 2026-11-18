//! The budget service, ported test for test from `packages/core/test/budget/{service,limits,l8,period,audit-b14,edges-b14,
//! status-breakdown,cache-read-weight,cache-report,concurrency}.test.ts`. The TypeScript is the spec, including where it
//! surprises; a test that differs says why.
use super::service::*;
use super::vectors::RuleZones;
use super::{BudgetError, Clock, StoreErrorCode};
use crate::budget::period::Period;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

pub(super) const T0: i64 = 1_791_288_000_000; // 2026-10-06T12:00:00Z
pub(super) const HOUR: i64 = 3_600_000;
pub(super) const DAY: i64 = 24 * HOUR;

pub(super) struct TestClock(pub AtomicI64);

impl TestClock {
    pub fn new(t: i64) -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(t)))
    }
    pub fn set(&self, t: i64) {
        self.0.store(t, Ordering::SeqCst);
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub(super) struct Rig {
    pub svc: BudgetService,
    pub clock: Arc<TestClock>,
    pub events: Arc<Mutex<Vec<BudgetEvent>>>,
    pub dir: tempfile::TempDir,
    pub path: PathBuf,
}

pub(super) fn open_in(
    dir: tempfile::TempDir,
    clock: Arc<TestClock>,
    tz: Option<&str>,
) -> Result<Rig, BudgetError> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let path = dir.path().join("state").join("budget.sqlite");
    let svc = BudgetService::open(BudgetServiceOptions {
        path: &path,
        clock: clock.clone(),
        zones: Arc::new(RuleZones),
        events: Some(Arc::new(move |e: &BudgetEvent| {
            sink.lock().unwrap().push(e.clone())
        })),
        secure_path: None,
        default_time_zone: tz,
        busy_timeout_ms: None,
    })?;
    Ok(Rig {
        svc,
        clock,
        events,
        dir,
        path,
    })
}

pub(super) fn rig() -> Rig {
    open_in(tempfile::tempdir().unwrap(), TestClock::new(T0), None).unwrap()
}

fn ev<'a>(agent: &'a str, model: &'a str, input: i64, output: i64) -> UsageEvent<'a> {
    UsageEvent {
        agent,
        model,
        input_tokens: input,
        output_tokens: output,
        ..Default::default()
    }
}

fn est(input: i64) -> UsageEstimate<'static> {
    UsageEstimate {
        input_tokens: input,
        ..Default::default()
    }
}

fn call(r: &Rig, agent: &str, input: i64, output: i64) {
    r.svc
        .record_usage(&ev(agent, "m-small", input, output))
        .unwrap();
}

fn key(scope: LimitScope, agent: Option<&str>, period: Period, metric: Metric) -> LimitKey {
    LimitKey {
        scope,
        agent_id: agent.map(str::to_owned),
        period,
        metric,
    }
}

fn set(r: &Rig, k: LimitKey, soft: Bound, hard: Bound) -> Option<Limit> {
    r.svc
        .set_limit(&BudgetLimitUpdate { key: k, soft, hard })
        .unwrap()
}

// --- recordUsage (service.test.ts) --------------------------------------------------------------------------------------

#[test]
fn records_token_counts_with_no_money_dimension() {
    let r = rig();
    let got = r
        .svc
        .record_usage(&UsageEvent {
            cache_read_tokens: Some(500),
            cache_write_tokens: Some(100),
            ..ev("a1", "m-small", 1000, 200)
        })
        .unwrap();
    assert_eq!(got, RecordResult { recorded: true });
    let s = r.svc.status(None).unwrap();
    let day = &s.periods[0];
    assert_eq!((day.key.as_str(), day.total.events), ("2026-10-06", 1));
    assert_eq!(
        (day.total.images, day.total.video_seconds),
        (0, 0),
        "a token call delivers no media units"
    );
    let m = &day.agents[0].models[0];
    assert_eq!(
        (
            m.model.as_str(),
            m.total.input_tokens,
            m.total.output_tokens,
            m.total.cache_read_tokens,
            m.total.cache_write_tokens
        ),
        ("m-small", 1000, 200, 500, 100)
    );
}

#[test]
fn accounts_per_agent_model_and_period_and_rolls_the_day_over_with_the_clock() {
    let r = rig();
    for (a, m) in [("a1", "m-small"), ("a1", "m-large"), ("a2", "m-small")] {
        r.svc.record_usage(&ev(a, m, 10, 10)).unwrap();
    }
    r.clock.advance(DAY);
    r.svc.record_usage(&ev("a1", "m-small", 5, 5)).unwrap();
    let s = r.svc.status(None).unwrap();
    let (day, month) = (&s.periods[0], &s.periods[1]);
    assert_eq!((day.key.as_str(), day.total.events), ("2026-10-07", 1));
    assert_eq!((month.key.as_str(), month.total.events), ("2026-10", 4));
    let agents: Vec<(String, Vec<String>)> = month
        .agents
        .iter()
        .map(|a| {
            (
                a.agent_id.clone(),
                a.models.iter().map(|m| m.model.clone()).collect(),
            )
        })
        .collect();
    assert_eq!(
        agents,
        vec![
            (
                "a1".to_owned(),
                vec!["m-large".to_owned(), "m-small".to_owned()]
            ),
            ("a2".to_owned(), vec!["m-small".to_owned()])
        ]
    );
    assert_eq!(r.svc.status(Some("a2")).unwrap().periods[1].total.events, 1);
}

#[test]
fn a_request_id_makes_a_retry_a_no_op() {
    let r = rig();
    let e = UsageEvent {
        request_id: Some("req-1"),
        ..ev("a1", "m-small", 10, 10)
    };
    assert!(r.svc.record_usage(&e).unwrap().recorded);
    assert!(!r.svc.record_usage(&e).unwrap().recorded);
    assert_eq!(r.svc.status(None).unwrap().periods[0].total.events, 1);
}

#[test]
fn any_model_is_counted_the_same_way() {
    let r = rig();
    assert!(
        r.svc
            .record_usage(&ev("a1", "mystery", 10, 10))
            .unwrap()
            .recorded
    );
    let t = r.svc.status(None).unwrap().periods[0].total;
    assert_eq!((t.input_tokens, t.output_tokens), (10, 10));
}

#[test]
fn malformed_events_are_refused_with_a_typed_error_and_nothing_is_written() {
    let r = rig();
    for bad in [
        ev("", "m", 1, 1),
        ev("a1", "", 1, 1),
        ev("a1", "m", -1, 1),
        ev("a1", "m", 1, -1),
        ev("a b", "m", 1, 1),
        ev("a1", "m", 1, 9_007_199_254_740_992),
        UsageEvent {
            cache_read_tokens: Some(-1),
            ..ev("a1", "m", 1, 1)
        },
        UsageEvent {
            cache_write_tokens: Some(-1),
            ..ev("a1", "m", 1, 1)
        },
        UsageEvent {
            ts: Some(-1),
            ..ev("a1", "m", 1, 1)
        },
        UsageEvent {
            request_id: Some(""),
            ..ev("a1", "m", 1, 1)
        },
        UsageEvent {
            request_id: Some("has space"),
            ..ev("a1", "m", 1, 1)
        },
    ] {
        let e = r.svc.record_usage(&bad).unwrap_err();
        assert!(
            matches!(e, BudgetError::Input(_) | BudgetError::Range(_)),
            "{bad:?}: {e}"
        );
    }
    assert_eq!(r.svc.status(None).unwrap().periods[1].total.events, 0);
}

// --- store (service.test.ts) --------------------------------------------------------------------------------------------

#[test]
fn the_store_is_migrated_persists_across_reopen_and_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let r = rig();
    r.svc.record_usage(&ev("a1", "m-small", 7, 3)).unwrap();
    r.svc.set_time_zone("Europe/Berlin").unwrap();
    let (path, clock) = (r.path.clone(), r.clock.clone());
    let dir = r.dir;
    drop(r.svc);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
        0
    );
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o077,
        0
    );
    let again = open_in(dir, clock, None).unwrap();
    assert_eq!(
        again.svc.status(None).unwrap().periods[1]
            .total
            .input_tokens,
        7
    );
    assert_eq!(again.svc.time_zone().unwrap(), "Europe/Berlin");
    let conn = plur1bus_store::rusqlite::Connection::open_with_flags(
        &again.path,
        plur1bus_store::rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let v: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, i64::from(super::store::SCHEMA_VERSION));
}

#[test]
fn a_store_written_by_a_newer_core_is_refused_and_left_alone() {
    let r = rig();
    let (path, clock) = (r.path.clone(), r.clock.clone());
    drop(r.svc);
    {
        let c = plur1bus_store::rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(&format!(
            "PRAGMA user_version = {}",
            super::store::SCHEMA_VERSION + 1
        ))
        .unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let e = BudgetService::open(BudgetServiceOptions {
        path: &path,
        clock,
        zones: Arc::new(RuleZones),
        events: None,
        secure_path: None,
        default_time_zone: None,
        busy_timeout_ms: None,
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
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "the file is untouched"
    );
}

#[test]
fn a_version_1_store_is_migrated_to_2_in_one_step_and_keeps_its_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("budget.sqlite");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    {
        let c = plur1bus_store::rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(super::store::MIGRATIONS[0]).unwrap();
        c.execute_batch("PRAGMA user_version = 1").unwrap();
        c.execute(
            "INSERT INTO usage_event (ts, agent, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, price_version, request_id) VALUES (?1, 'a1', '', 'm', 40, 2, 0, 0, NULL, 'v0', NULL)",
            [T0],
        )
        .unwrap();
    }
    let r = open_in(dir, TestClock::new(T0), None).unwrap();
    assert_eq!(
        r.svc.status(None).unwrap().periods[0].total.input_tokens,
        40
    );
    let c = plur1bus_store::rusqlite::Connection::open(&r.path).unwrap();
    let v: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 2);
}

#[test]
fn the_schema_has_no_column_that_can_hold_content() {
    let r = rig();
    r.svc.record_usage(&ev("a1", "m-small", 1, 1)).unwrap();
    let c = plur1bus_store::rusqlite::Connection::open_with_flags(
        &r.path,
        plur1bus_store::rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let tables: Vec<String> = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        tables,
        ["budget_limit", "notice", "settings", "usage_event"]
    );
    let cols: Vec<String> = c
        .prepare("SELECT name || ':' || type FROM pragma_table_info('usage_event')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        cols,
        [
            "id:INTEGER",
            "ts:INTEGER",
            "agent:TEXT",
            "provider:TEXT",
            "model:TEXT",
            "input_tokens:INTEGER",
            "output_tokens:INTEGER",
            "cache_read_tokens:INTEGER",
            "cache_write_tokens:INTEGER",
            "cost_micros:INTEGER",
            "price_version:TEXT",
            "request_id:TEXT",
            "images:INTEGER",
            "video_seconds:INTEGER"
        ]
    );
}

// --- limits (limits.test.ts) --------------------------------------------------------------------------------------------

#[test]
fn soft_warns_once_per_period_hard_refuses_and_the_next_day_resets() {
    let r = rig();
    let a1 = key(LimitScope::Agent, Some("a1"), Period::Day, Metric::Tokens);
    set(&r, a1, Bound::Set(1000), Bound::Set(2000));
    let d = r.svc.check("a1", "m-small", &est(500)).unwrap();
    assert!(d.allowed && d.breaches.is_empty() && d.warnings.is_empty());
    call(&r, "a1", 900, 0);
    let d = r.svc.check("a1", "m-small", &est(200)).unwrap(); // 1100 > soft
    assert!(d.allowed);
    assert_eq!(d.warnings.len(), 1);
    assert!(d.warnings[0].notified);
    assert_eq!(
        r.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| (e.kind, e.limit))
            .collect::<Vec<_>>(),
        vec![(EventKind::Soft, 1000)]
    );
    assert!(
        !r.svc.check("a1", "m-small", &est(200)).unwrap().warnings[0].notified,
        "same period: not re-notified"
    );
    assert_eq!(r.events.lock().unwrap().len(), 1);

    call(&r, "a1", 1000, 0); // 1900 used
    match r.svc.enforce("a1", "m-small", &est(200)).unwrap_err() {
        BudgetError::Exceeded(e) => {
            assert!(e.message.contains("agent a1 daily tokens hard limit 2000 tokens would be exceeded (used 1900 tokens"), "{}", e.message);
            assert_eq!(e.decision.breaches[0].resets_at, T0 - 12 * HOUR + DAY);
        }
        other => panic!("{other}"),
    }
    assert!(
        r.svc.check("a1", "m-small", &est(100)).unwrap().allowed,
        "lands exactly on the limit: allowed"
    );

    r.clock.set(T0 - 12 * HOUR + DAY);
    assert!(r
        .svc
        .check("a1", "m-small", &est(1500))
        .unwrap()
        .breaches
        .is_empty());
    let d3 = r.svc.check("a1", "m-small", &est(1500)).unwrap();
    assert_eq!(d3.warnings.len(), 1);
    assert!(!d3.warnings[0].notified);
    assert_eq!(
        r.events.lock().unwrap().len(),
        2,
        "a new period notifies again"
    );
}

#[test]
fn a_refused_call_does_not_notify() {
    let r = rig();
    set(
        &r,
        key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        Bound::Set(10),
        Bound::Set(100),
    );
    set(
        &r,
        key(LimitScope::Agent, Some("a1"), Period::Day, Metric::Tokens),
        Bound::Keep,
        Bound::Set(50),
    );
    assert!(!r.svc.check("a1", "m-small", &est(60)).unwrap().allowed);
    assert!(r.events.lock().unwrap().is_empty());
}

#[test]
fn agent_and_global_limits_both_apply_and_refusals_sort_by_how_far_over() {
    let r = rig();
    set(
        &r,
        key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        Bound::Keep,
        Bound::Set(1000),
    );
    set(
        &r,
        key(LimitScope::Agent, Some("a1"), Period::Day, Metric::Tokens),
        Bound::Keep,
        Bound::Set(600),
    );
    call(&r, "a1", 500, 0);
    call(&r, "a2", 400, 0); // global 900
    let scopes = |agent: &str, n: i64| {
        r.svc
            .check(agent, "m-small", &est(n))
            .unwrap()
            .breaches
            .iter()
            .map(|b| b.scope)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        scopes("a1", 150),
        vec![LimitScope::Agent, LimitScope::Global]
    ); // 650 > 600, 1050 > 1000
    assert_eq!(scopes("a1", 100), vec![]); // exactly on both
    assert_eq!(scopes("a2", 150), vec![LimitScope::Global]);
    assert!(r.svc.check("a2", "m-small", &est(100)).unwrap().allowed);
}

#[test]
fn there_is_no_cost_metric() {
    assert_eq!(Metric::parse("cost"), None);
    let r = rig();
    // A cost limit left in the table by an older core is ignored, not read as a token limit.
    let c = plur1bus_store::rusqlite::Connection::open(&r.path).unwrap();
    c.execute("INSERT INTO budget_limit (scope, agent, period, metric, soft, hard) VALUES ('global', '', 'day', 'cost', NULL, 1)", []).unwrap();
    assert!(r.svc.check("a1", "m-small", &est(1000)).unwrap().allowed);
    assert!(
        r.svc.limits().unwrap().is_empty(),
        "the cost row is not a limit"
    );
}

#[test]
fn recording_usage_that_crosses_a_limit_emits_the_soft_and_the_hard_event_once() {
    let r = rig();
    set(
        &r,
        key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        Bound::Set(100),
        Bound::Set(200),
    );
    call(&r, "a1", 120, 0);
    call(&r, "a1", 10, 0);
    call(&r, "a1", 100, 0);
    call(&r, "a1", 1, 0);
    let kinds: Vec<_> = r
        .events
        .lock()
        .unwrap()
        .iter()
        .map(|e| (e.kind, e.limit, e.used >= e.limit))
        .collect();
    assert_eq!(
        kinds,
        vec![(EventKind::Soft, 100, true), (EventKind::Hard, 200, true)]
    );
}

#[test]
fn the_month_resets_on_the_first_of_the_next_month_in_the_configured_zone() {
    let r = rig();
    r.svc.set_time_zone("Europe/Berlin").unwrap();
    set(
        &r,
        key(LimitScope::Global, None, Period::Month, Metric::Tokens),
        Bound::Keep,
        Bound::Set(100),
    );
    call(&r, "a1", 90, 0);
    let b = r.svc.check("a1", "m-small", &est(20)).unwrap().breaches;
    assert_eq!(
        b[0].resets_at, 1_793_487_600_000,
        "2026-11-01T00:00 Europe/Berlin (CET)"
    );
    r.clock.set(1_793_487_600_000 - 1);
    assert!(!r.svc.check("a1", "m-small", &est(20)).unwrap().allowed);
    r.clock.set(1_793_487_600_000);
    assert!(r.svc.check("a1", "m-small", &est(20)).unwrap().allowed);
}

#[test]
fn changing_the_time_zone_re_buckets_the_same_history() {
    let r = rig();
    r.clock.set(T0 + 10 * HOUR); // 2026-10-06T22:00Z = 07 Oct 00:00 in Berlin (CEST)
    call(&r, "a1", 10, 0);
    assert_eq!(r.svc.status(None).unwrap().periods[0].total.events, 1);
    r.clock.advance(HOUR); // 23:00Z, still 6 Oct in UTC
    r.svc.set_time_zone("Europe/Berlin").unwrap();
    let day = &r.svc.status(None).unwrap().periods[0];
    assert_eq!(day.key, "2026-10-07");
    assert_eq!(day.total.events, 1);
    r.svc.set_time_zone("UTC").unwrap();
    assert_eq!(r.svc.status(None).unwrap().periods[0].key, "2026-10-06");
}

#[test]
fn set_limit_merges_bounds_clears_and_validates() {
    let r = rig();
    let k = key(LimitScope::Global, None, Period::Day, Metric::Tokens);
    let l = set(&r, k.clone(), Bound::Set(10), Bound::Set(100)).unwrap();
    assert_eq!((l.soft, l.hard), (Some(10), Some(100)));
    let l = set(&r, k.clone(), Bound::Keep, Bound::Set(200)).unwrap();
    assert_eq!((l.soft, l.hard), (Some(10), Some(200)));
    let l = set(&r, k.clone(), Bound::Clear, Bound::Keep).unwrap();
    assert_eq!((l.soft, l.hard), (None, Some(200)));
    assert_eq!(
        set(&r, k.clone(), Bound::Clear, Bound::Clear),
        None,
        "no bound left removes the row"
    );
    assert!(r.svc.limits().unwrap().is_empty());
    for (soft, hard) in [
        (Bound::Set(10), Bound::Set(5)),
        (Bound::Set(-1), Bound::Keep),
        (Bound::Keep, Bound::Set(9_007_199_254_740_992)),
    ] {
        assert!(r
            .svc
            .set_limit(&BudgetLimitUpdate {
                key: k.clone(),
                soft,
                hard
            })
            .is_err());
    }
    assert!(
        r.svc
            .set_limit(&BudgetLimitUpdate {
                key: key(LimitScope::Agent, None, Period::Day, Metric::Tokens),
                soft: Bound::Keep,
                hard: Bound::Set(1)
            })
            .is_err(),
        "an agent limit needs an agent"
    );
    assert!(
        r.svc
            .set_limit(&BudgetLimitUpdate {
                key: key(LimitScope::Global, Some("a1"), Period::Day, Metric::Tokens),
                soft: Bound::Keep,
                hard: Bound::Set(1)
            })
            .is_err(),
        "a global limit has no agent"
    );
}

#[test]
fn status_reports_used_and_state_per_limit_and_states_reach_a_bound_at_it() {
    // The surprise the TypeScript has: `check` refuses only above a bound, but the status state is "soft" or "hard" AT it.
    let r = rig();
    set(
        &r,
        key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        Bound::Set(100),
        Bound::Set(200),
    );
    assert_eq!(r.svc.status(None).unwrap().limits[0].state, LimitState::Ok);
    call(&r, "a1", 99, 0);
    assert_eq!(r.svc.status(None).unwrap().limits[0].state, LimitState::Ok);
    call(&r, "a1", 1, 0);
    let l = &r.svc.status(None).unwrap().limits[0];
    assert_eq!((l.used, l.state), (100, LimitState::Soft));
    call(&r, "a1", 99, 0);
    assert_eq!(
        r.svc.status(None).unwrap().limits[0].state,
        LimitState::Soft
    );
    call(&r, "a1", 1, 0);
    let l = &r.svc.status(None).unwrap().limits[0];
    assert_eq!((l.used, l.state), (200, LimitState::Hard));
}

// --- the cache-read weight (cache-read-weight.test.ts) -------------------------------------------------------------------

#[test]
fn the_cache_read_weight_changes_what_a_token_limit_counts_and_nothing_else() {
    let r = rig();
    set(
        &r,
        key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        Bound::Keep,
        Bound::Set(1000),
    );
    r.svc
        .record_usage(&UsageEvent {
            cache_read_tokens: Some(900),
            ..ev("a1", "m", 1000, 0)
        })
        .unwrap();
    assert!(
        !r.svc.check("a1", "m", &est(1)).unwrap().allowed,
        "weight 1: 1000 counted"
    );
    assert_eq!(r.svc.set_cache_read_weight(0.1).unwrap(), 0.1);
    let t = r.svc.status(None).unwrap();
    assert_eq!(t.periods[0].total.counted_tokens, 190);
    assert_eq!(
        (
            t.periods[0].total.input_tokens,
            t.periods[0].total.cache_read_tokens
        ),
        (1000, 900),
        "the ledger is not rewritten"
    );
    assert!(r.svc.check("a1", "m", &est(800)).unwrap().allowed);
    assert!(!r.svc.check("a1", "m", &est(811)).unwrap().allowed);
    assert!(r.svc.set_cache_read_weight(1.5).is_err());
    assert!(r.svc.set_cache_read_weight(f64::NAN).is_err());
    assert_eq!(
        r.svc.cache_read_weight().unwrap(),
        0.1,
        "a refused weight changes nothing"
    );
}

#[test]
fn a_cache_read_larger_than_the_input_counts_at_most_the_input() {
    let r = rig();
    r.svc.set_cache_read_weight(0.0).unwrap();
    r.svc
        .record_usage(&UsageEvent {
            cache_read_tokens: Some(5000),
            ..ev("a1", "m", 100, 7)
        })
        .unwrap();
    assert_eq!(
        r.svc.status(None).unwrap().periods[0].total.counted_tokens,
        7
    );
}

// --- the cache report (cache-report.test.ts) ----------------------------------------------------------------------------

#[test]
fn the_cache_report_groups_by_provider_agent_and_model_and_caps_ratios_at_one() {
    let r = rig();
    r.svc
        .record_usage(&UsageEvent {
            provider: Some("p"),
            cache_read_tokens: Some(50),
            cache_write_tokens: Some(0),
            ..ev("a1", "m", 100, 1)
        })
        .unwrap();
    r.svc
        .record_usage(&UsageEvent {
            provider: Some("p"),
            ..ev("a1", "m", 100, 1)
        })
        .unwrap();
    r.svc
        .record_usage(&UsageEvent {
            provider: Some("p"),
            cache_read_tokens: Some(500),
            ..ev("a2", "m", 10, 1)
        })
        .unwrap();
    let rows = r.svc.cache_usage(0, T0 + DAY, None).unwrap();
    assert_eq!(
        rows.iter()
            .map(|x| (x.agent_id.as_str(), x.calls, x.uncached_calls))
            .collect::<Vec<_>>(),
        vec![("a1", 2, 1), ("a2", 1, 0)]
    );
    assert!((rows[0].hit_ratio - 0.25).abs() < 1e-12);
    assert!((rows[0].hit_ratio_caching - 0.5).abs() < 1e-12);
    assert_eq!(rows[1].hit_ratio, 1.0, "capped");
    assert_eq!(r.svc.cache_usage(0, T0 + DAY, Some("a2")).unwrap().len(), 1);
    assert!(
        r.svc.cache_usage(T0 + DAY, T0, None).is_err()
            || r.svc.cache_usage(T0 + DAY, T0, None).unwrap().is_empty()
    );
}

// --- events after commit (audit-b14 / edges-b14) -----------------------------------------------------------------------

#[test]
fn a_sink_may_call_back_into_the_service_and_a_panicking_sink_does_not_fail_the_call() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("budget.sqlite");
    let clock = TestClock::new(T0);
    let seen = Arc::new(Mutex::new(Vec::<i64>::new()));
    let cell: Arc<Mutex<Option<Arc<BudgetService>>>> = Arc::new(Mutex::new(None));
    let (s2, c2) = (seen.clone(), cell.clone());
    let svc = Arc::new(
        BudgetService::open(BudgetServiceOptions {
            path: &path,
            clock: clock.clone(),
            zones: Arc::new(RuleZones),
            events: Some(Arc::new(move |e: &BudgetEvent| {
                if let Some(svc) = c2.lock().unwrap().as_ref() {
                    // Re-entry: the lock was released before the event went out.
                    let used = svc.status(None).unwrap().periods[0].total.input_tokens;
                    s2.lock().unwrap().push(used + e.limit);
                }
                if e.kind == EventKind::Hard {
                    panic!("a failing sink");
                }
            })),
            secure_path: None,
            default_time_zone: None,
            busy_timeout_ms: None,
        })
        .unwrap(),
    );
    *cell.lock().unwrap() = Some(svc.clone());
    svc.set_limit(&BudgetLimitUpdate {
        key: key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        soft: Bound::Set(10),
        hard: Bound::Set(20),
    })
    .unwrap();
    svc.record_usage(&ev("a1", "m", 15, 0)).unwrap();
    svc.record_usage(&ev("a1", "m", 15, 0)).unwrap(); // the hard event's sink panics; the record stands
    assert_eq!(svc.status(None).unwrap().periods[0].total.events, 2);
    assert_eq!(*seen.lock().unwrap(), vec![15 + 10, 30 + 20]);
    *cell.lock().unwrap() = None;
}

// --- time zone (period.test.ts) ----------------------------------------------------------------------------------------

#[test]
fn an_unknown_time_zone_is_refused_and_the_stored_one_is_kept() {
    let r = rig();
    assert!(r.svc.set_time_zone("Mars/Olympus").is_err());
    assert!(r.svc.set_time_zone("").is_err());
    assert_eq!(r.svc.time_zone().unwrap(), "UTC");
    assert_eq!(r.svc.set_time_zone("Asia/Kolkata").unwrap(), "Asia/Kolkata");
}

#[test]
fn prune_removes_rows_before_a_cut_and_nothing_else() {
    let r = rig();
    r.svc
        .record_usage(&UsageEvent {
            ts: Some(1000),
            ..ev("a1", "m", 1, 1)
        })
        .unwrap();
    r.svc
        .record_usage(&UsageEvent {
            ts: Some(2000),
            ..ev("a1", "m", 1, 1)
        })
        .unwrap();
    assert_eq!(r.svc.prune(2000).unwrap(), 1, "the cut is exclusive");
    assert_eq!(r.svc.cache_usage(0, 10_000, None).unwrap()[0].calls, 1);
}

// --- two writers (concurrency.test.ts) ----------------------------------------------------------------------------------

#[test]
fn two_connections_to_one_file_serialise_their_writes() {
    let r = rig();
    set(
        &r,
        key(LimitScope::Global, None, Period::Day, Metric::Tokens),
        Bound::Keep,
        Bound::Set(1_000_000),
    );
    let other = open_in_existing(&r);
    std::thread::scope(|s| {
        let h1 = s.spawn(|| (0..100).for_each(|_| call(&r, "a1", 1, 0)));
        let h2 = s.spawn(|| {
            (0..100).for_each(|_| {
                other.record_usage(&ev("a2", "m-small", 1, 0)).unwrap();
            })
        });
        h1.join().unwrap();
        h2.join().unwrap();
    });
    let b = r.svc.status(None).unwrap();
    assert_eq!(b.periods[0].total.events, 200);
    assert_eq!(b.periods[0].total.input_tokens, 200);
}

fn open_in_existing(r: &Rig) -> BudgetService {
    BudgetService::open(BudgetServiceOptions {
        path: &r.path,
        clock: r.clock.clone(),
        zones: Arc::new(RuleZones),
        events: None,
        secure_path: None,
        default_time_zone: None,
        busy_timeout_ms: None,
    })
    .unwrap()
}
