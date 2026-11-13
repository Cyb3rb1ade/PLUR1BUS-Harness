//! Ports of `test/doctor-report.test.ts` (the parts that need no `guardMethods`: RBAC is the injected [`DoctorAccess`])
//! with an injected clock.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::*;
use crate::metrics::metrics::{MemoryUsage, Metrics, MetricsOptions, TurnTelemetry};
use serde_json::json;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicUsize, Ordering};

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Role {
    Viewer,
    Operator,
    ScopedOperator,
}

pub(super) struct Access(pub Mutex<Role>);

impl DoctorAccess for Access {
    fn authenticate(&self, _ctx: &CallContext) -> Result<(), RpcErr> {
        Ok(())
    }
    fn may_refresh(&self, _ctx: &CallContext, _now: i64) -> bool {
        *lock(&self.0) == Role::Operator
    }
}

struct DenyAll;
impl DoctorAccess for DenyAll {
    fn authenticate(&self, _ctx: &CallContext) -> Result<(), RpcErr> {
        Err(RpcErr::new("E_UNAUTHORIZED", "no identity", None))
    }
    fn may_refresh(&self, _ctx: &CallContext, _now: i64) -> bool {
        false
    }
}

pub(super) struct Host(pub HostEvalGate);
impl HostEval for Host {
    fn gate(&self, _d: &[ModelRef], _h: &Path, _n: i64) -> HostEvalGate {
        self.0.clone()
    }
}

pub(super) fn sandbox(
    available: bool,
    backend: &str,
    mechanism: TaskMechanism,
) -> SandboxDetection {
    SandboxDetection {
        backend: backend.into(),
        strength: "partial".into(),
        available,
        tasks: SandboxTasks {
            mechanism,
            reason: "fixture reason".into(),
            hint: None,
        },
        reason: "fixture".into(),
        hint: None,
    }
}

pub(super) fn probe(checks: Value) -> CheckFn {
    Arc::new(move || Ok(json!({"schema": "1staid.check/1", "checks": checks.clone()})))
}

struct Fixture {
    now: Arc<AtomicI64>,
    role: Arc<Access>,
    initial: Arc<Mutex<Option<StartFn>>>,
}

fn clock(now: &Arc<AtomicI64>) -> Clock {
    let n = now.clone();
    Arc::new(move || n.load(Ordering::SeqCst))
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "a test helper that takes its fixtures by value"
)]
pub(super) fn base(
    home: &str,
    now: Arc<AtomicI64>,
    role: Arc<Access>,
    check: CheckFn,
) -> DoctorDeps {
    let mut d = DoctorDeps::new(
        home,
        clock(&now),
        role,
        Arc::new(|_| sandbox(true, "bubblewrap", TaskMechanism::NamespaceLimit)),
        Arc::new(Host(HostEvalGate {
            passed: true,
            models: vec![],
        })),
        Arc::new(|| None),
    );
    d.check = Some(check);
    d.user_home = Some("/nobody".into());
    d.linux = Some(true);
    d
}

fn fixture(
    deps: impl FnOnce(DoctorDeps) -> DoctorDeps,
    check: CheckFn,
) -> (DoctorMethods, Fixture) {
    let now = Arc::new(AtomicI64::new(1000));
    let role = Arc::new(Access(Mutex::new(Role::Viewer)));
    let initial: Arc<Mutex<Option<StartFn>>> = Arc::new(Mutex::new(None));
    let mut d = deps(base("/fixture", now.clone(), role.clone(), check));
    if d.schedule_initial.is_none() {
        let slot = initial.clone();
        d.schedule_initial = Some(Box::new(move |s| *lock(&slot) = Some(s)));
    }
    let m = DoctorMethods::new(d).unwrap();
    (m, Fixture { now, role, initial })
}

fn ctx() -> CallContext {
    CallContext::new("request", "connection")
}

fn read(m: &DoctorMethods) -> Result<Report, DoctorError> {
    m.report(&DoctorParams::default(), &ctx())
}

fn refresh(m: &DoctorMethods) -> Result<Report, DoctorError> {
    m.report(
        &DoctorParams {
            refresh: Some(true),
        },
        &ctx(),
    )
}

fn code(e: &DoctorError) -> &'static str {
    e.rpc().code
}

fn find<'a>(r: &'a Report, id: &str) -> Option<&'a Check> {
    r.checks().find(|c| c.id == id)
}

fn start(f: &Fixture) -> Result<Report, DoctorError> {
    let s = lock(&f.initial).clone().unwrap();
    s()
}

#[test]
fn projects_checks_removes_private_paths_shares_refresh_and_rate_limits() {
    let runs = Arc::new(AtomicU32::new(0));
    let r = runs.clone();
    let now = Arc::new(AtomicI64::new(1000));
    let role = Arc::new(Access(Mutex::new(Role::Viewer)));
    let check: CheckFn = Arc::new(move || {
        r.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"schema": "1staid.check/1", "checks": [{"id": "models.cache", "status": "ok",
            "summary": "models in /private/home/example/models", "detail": "must not escape", "hint": "plur1bus setup"}]}),
        )
    });
    // The default start: the snapshot begins at once on its own thread and the first read waits for it.
    let d = base("/private/home/example", now.clone(), role.clone(), check);
    let m = DoctorMethods::new(d).unwrap();
    let first = read(&m).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    let text = first.to_value().to_string();
    assert!(!text.contains("/private/home/example"));
    assert!(!text.contains("must not escape"));
    assert!(text.contains("[home]/models"));
    assert_eq!(code(&refresh(&m).unwrap_err()), "E_DENIED");
    *lock(&role.0) = Role::Operator;
    let e = refresh(&m).unwrap_err();
    assert_eq!(code(&e), "E_CONFLICT");
    assert_eq!(e.rpc().reason.as_deref(), Some("refresh-rate-limit"));
    now.fetch_add(30_000, Ordering::SeqCst);
    refresh(&m).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn the_internal_snapshot_can_be_deferred_until_the_core_is_ready() {
    let runs = Arc::new(AtomicU32::new(0));
    let r = runs.clone();
    let check: CheckFn = Arc::new(move || {
        r.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"schema": "1staid.check/1", "checks": []}))
    });
    let (_m, f) = fixture(|d| d, check);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    assert!(lock(&f.initial).is_some());
    start(&f).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn redacts_complete_text_before_clipping() {
    let family = ["s", "k", "-"].concat();
    let text = format!("{}{}{}", " ".repeat(4088), family, "fixture".repeat(20));
    let (m, f) = fixture(
        |d| d,
        probe(json!([{"id": "models.cache", "status": "warn", "summary": text}])),
    );
    start(&f).unwrap();
    let out = read(&m).unwrap().to_value().to_string();
    assert!(!out.contains(&family));
}

#[test]
fn a_read_only_scoped_operator_cannot_request_a_fresh_check() {
    let (m, f) = fixture(|d| d, probe(json!([])));
    start(&f).unwrap();
    *lock(&f.role.0) = Role::ScopedOperator;
    read(&m).unwrap();
    f.now.fetch_add(30_000, Ordering::SeqCst);
    assert_eq!(code(&refresh(&m).unwrap_err()), "E_DENIED");
}

#[test]
fn an_unauthenticated_call_is_refused_before_anything_else() {
    let now = Arc::new(AtomicI64::new(1000));
    let mut d = base(
        "/fixture",
        now,
        Arc::new(Access(Mutex::new(Role::Viewer))),
        probe(json!([])),
    );
    d.access = Arc::new(DenyAll);
    d.schedule_initial = Some(Box::new(|_| {}));
    let m = DoctorMethods::new(d).unwrap();
    assert_eq!(code(&read(&m).unwrap_err()), "E_UNAUTHORIZED");
    assert_eq!(code(&refresh(&m).unwrap_err()), "E_UNAUTHORIZED");
}

#[test]
fn macos_acp_refusal_is_independent_of_ordinary_seatbelt_availability() {
    let (m, f) = fixture(
        |mut d| {
            d.linux = Some(false);
            d.detect_sandbox = Arc::new(|_| sandbox(true, "seatbelt", TaskMechanism::ForkDenied));
            d.external_agent_refusal = Arc::new(|| {
                Some(ExternalAgentRefusal {
                    reason: "sandbox-unavailable".into(),
                    cause: Some("macos-acceptance-pending".into()),
                })
            });
            d
        },
        probe(json!([])),
    );
    start(&f).unwrap();
    let r = read(&m).unwrap();
    let acp = find(&r, "external.agents.sandbox").unwrap();
    assert_eq!(acp.status, Status::Fail);
    assert!(acp
        .summary
        .contains("sandbox-unavailable (macos-acceptance-pending)"));
    assert_eq!(find(&r, "tools.sandbox").unwrap().status, Status::Warn);
    assert_eq!(find(&r, "tools.sandbox.tasks").unwrap().status, Status::Ok);
}

#[test]
fn linux_acp_needs_namespace_enforcement_and_a_positive_task_limit() {
    for (mechanism, max, status) in [
        (TaskMechanism::None, 512.0, Status::Fail),
        (TaskMechanism::NamespaceLimit, 0.0, Status::Fail),
        (TaskMechanism::NamespaceLimit, 1.0, Status::Ok),
        (TaskMechanism::NamespaceLimit, 512.0, Status::Ok),
    ] {
        let (m, f) = fixture(
            |mut d| {
                d.sandbox_max_tasks = Some(Arc::new(move || max));
                d.detect_sandbox = Arc::new(move |_| sandbox(true, "bubblewrap", mechanism));
                d
            },
            probe(json!([])),
        );
        start(&f).unwrap();
        let r = read(&m).unwrap();
        let acp = find(&r, "external.agents.sandbox").unwrap();
        assert_eq!(acp.status, status, "{mechanism:?}, maxTasks={max}");
        assert!(acp.summary.contains(if status == Status::Ok {
            "sandbox available"
        } else {
            "sandbox-unavailable"
        }));
        if max == 0.0 {
            assert_eq!(
                find(&r, "tools.sandbox.tasks").unwrap().status,
                Status::Warn
            );
        }
    }
}

#[test]
fn a_non_linux_host_does_not_need_the_namespace_mechanism() {
    let (m, f) = fixture(
        |mut d| {
            d.linux = Some(false);
            d.detect_sandbox = Arc::new(|_| sandbox(true, "seatbelt", TaskMechanism::None));
            d
        },
        probe(json!([])),
    );
    start(&f).unwrap();
    let r = read(&m).unwrap();
    assert_eq!(
        find(&r, "external.agents.sandbox").unwrap().status,
        Status::Ok
    );
}

fn summary_of(home: &str, summary: &str, hint: Option<&str>) -> String {
    let mut item = json!({"id": "models.cache", "status": "warn", "summary": summary});
    if let Some(h) = hint {
        item["hint"] = json!(h);
    }
    let now = Arc::new(AtomicI64::new(1000));
    let mut d = base(
        home,
        now,
        Arc::new(Access(Mutex::new(Role::Viewer))),
        probe(json!([item])),
    );
    d.schedule_initial = Some(Box::new(|_| {}));
    let slot: Arc<Mutex<Option<StartFn>>> = Arc::new(Mutex::new(None));
    let s2 = slot.clone();
    d.schedule_initial = Some(Box::new(move |s| *lock(&s2) = Some(s)));
    let m = DoctorMethods::new(d).unwrap();
    let s = lock(&slot).clone().unwrap();
    s().unwrap();
    read(&m).unwrap().to_value().to_string()
}

#[test]
fn an_empty_or_root_home_does_not_shred_the_summary() {
    for home in ["", "/"] {
        let out = summary_of(home, "cache /var/lib/x is stale", None);
        assert!(
            out.contains("cache /var/lib/x is stale"),
            "home {home:?}: {out}"
        );
    }
}

#[test]
fn other_persons_homes_and_email_addresses_are_masked() {
    let out = summary_of(
        "/srv/plur1bus",
        "cannot open /home/bob/notes.txt and C:\\Users\\Carol\\x.db and /Users/anna/Library/foo",
        Some("mail anna@example.org about /home/dave/.cache"),
    );
    for leak in ["bob", "Carol", "anna", "dave"] {
        assert!(!out.contains(leak), "{leak}: {out}");
    }
}

#[test]
fn a_check_that_fails_with_something_else_surfaces_as_not_available_without_its_message() {
    let check: CheckFn = Arc::new(|| {
        Err(CheckError::Other(
            "spawn /home/bob/bin/plur1bus failed".into(),
        ))
    });
    let (m, f) = fixture(|d| d, check);
    assert!(start(&f).is_err());
    let e = read(&m).unwrap_err();
    assert_eq!(code(&e), "E_NOT_AVAILABLE");
    assert!(!format!("{:?}", e.rpc()).contains("bob"));
    assert_eq!(e.rpc().reason.as_deref(), Some("firstaid-unavailable"));
}

#[test]
fn a_failed_startup_snapshot_is_retried_once_the_window_has_passed() {
    let runs = Arc::new(AtomicU32::new(0));
    let r = runs.clone();
    let check: CheckFn = Arc::new(move || {
        if r.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(CheckError::Other("not yet".into()));
        }
        Ok(json!({"schema": "1staid.check/1", "checks": []}))
    });
    let (m, f) = fixture(|d| d, check);
    assert!(start(&f).is_err());
    assert_eq!(code(&read(&m).unwrap_err()), "E_NOT_AVAILABLE");
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "no retry inside the rate-limit window"
    );
    f.now.fetch_add(30_000, Ordering::SeqCst);
    let report = read(&m).unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 2);
    assert_eq!(report.groups[0].id, "provisioning");
}

#[test]
fn a_refresh_inside_a_failed_runs_window_is_rate_limited() {
    let check: CheckFn = Arc::new(|| Err(CheckError::Other("x".into())));
    let (m, f) = fixture(|d| d, check);
    *lock(&f.role.0) = Role::Operator;
    assert!(start(&f).is_err());
    assert_eq!(code(&refresh(&m).unwrap_err()), "E_CONFLICT");
}

#[test]
fn a_refused_probe_passes_its_own_refusal_through() {
    let check: CheckFn =
        Arc::new(|| Err(CheckError::Rpc(firstaid::unavailable("firstaid-invalid"))));
    let (m, f) = fixture(|d| d, check);
    assert!(start(&f).is_err());
    f.now.fetch_add(30_000, Ordering::SeqCst);
    let e = read(&m).unwrap_err();
    assert_eq!(e.rpc().reason.as_deref(), Some("firstaid-invalid"));
}

#[test]
fn a_probe_that_panics_is_a_refusal_not_a_hang() {
    let check: CheckFn = Arc::new(|| panic!("boom"));
    let (m, f) = fixture(|d| d, check);
    assert_eq!(code(&start(&f).unwrap_err()), "E_INTERNAL");
    f.now.fetch_add(30_000, Ordering::SeqCst);
    assert!(read(&m).is_err());
}

#[test]
fn concurrent_callers_share_one_run() {
    let runs = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (r, g) = (runs.clone(), gate.clone());
    let check: CheckFn = Arc::new(move || {
        r.fetch_add(1, Ordering::SeqCst);
        let mut open = lock(&g.0);
        while !*open {
            open = g.1.wait(open).unwrap();
        }
        Ok(json!({"schema": "1staid.check/1", "checks": []}))
    });
    let now = Arc::new(AtomicI64::new(1000));
    let role = Arc::new(Access(Mutex::new(Role::Operator)));
    let m = Arc::new(DoctorMethods::new(base("/fixture", now, role, check)).unwrap());
    // The initial run holds the probe; readers join it, a refresh is a conflict.
    while runs.load(Ordering::SeqCst) == 0 {
        std::thread::yield_now();
    }
    assert_eq!(code(&refresh(&m).unwrap_err()), "E_CONFLICT");
    let readers: Vec<_> = (0..3)
        .map(|_| {
            let m = m.clone();
            std::thread::spawn(move || read(&m).is_ok())
        })
        .collect();
    std::thread::sleep(std::time::Duration::from_millis(50));
    *lock(&gate.0) = true;
    gate.1.notify_all();
    for r in readers {
        assert!(r.join().unwrap());
    }
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn the_tool_use_summary_is_live_and_does_not_rerun_the_probe() {
    let metrics = Arc::new(
        Metrics::new(&MetricsOptions {
            methods: vec![],
            connections: Arc::new(|| 0.0),
            memory_usage: Arc::new(|| MemoryUsage {
                rss: 1.0,
                heap_total: 1.0,
                heap_used: 1.0,
                external: 1.0,
                array_buffers: 1.0,
            }),
            health: None,
        })
        .unwrap(),
    );
    let runs = Arc::new(AtomicU32::new(0));
    let r = runs.clone();
    let check: CheckFn = Arc::new(move || {
        r.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"schema": "1staid.check/1", "checks": []}))
    });
    let m2 = metrics.clone();
    let (m, f) = fixture(
        move |mut d| {
            d.turn_telemetry = Some(Arc::new(move || Some(m2.turn_telemetry_summary())));
            d
        },
        check,
    );
    start(&f).unwrap();
    // Nothing observed yet: a summary with zero turns is still a summary.
    let _ = read(&m).unwrap();
    metrics.turn_telemetry(&TurnTelemetry {
        rounds: 2.0,
        tool_calls: 0.0,
        meta_search: 1.0,
        meta_skill_load: 1.0,
        meta_skill_read: 0.0,
        skills_injected: 1.0,
        skills_loaded: 1.0,
        tool_choice_status: "unsupported".into(),
        tool_choice_forced: false,
        tool_need_detected: true,
        tool_need_reasons: vec!["path".into()],
        errors_returned: 1.0,
        end_reason: "completed".into(),
        triage_duration_ms: Some(40.0),
    });
    let r = read(&m).unwrap();
    let c = find(&r, "tools.turn-usage").unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(c.status, Status::Warn);
    for part in [
        "1 turns, 2 rounds, 0 tool calls",
        "1 loaded skills; 1 errors returned",
        "Triage p50 40 ms, p95 40 ms (1 recent samples).",
        "1 needed tools unused, 1 unsupported",
        "1 need detected",
        "ends completed=1.",
        "meta search/load/read 1/1/0",
    ] {
        assert!(c.summary.contains(part), "{part}: {}", c.summary);
    }
}

#[test]
fn an_absent_skill_artifact_queue_is_not_reported_as_enabled() {
    let (m, f) = fixture(
        |mut d| {
            d.mining_status = Some(Arc::new(|| Some(MiningStatus { available: false })));
            d
        },
        probe(json!([])),
    );
    start(&f).unwrap();
    let r = read(&m).unwrap();
    let c = find(&r, "skills.mining").unwrap();
    assert_eq!(c.status, Status::Skipped);
    assert!(c.summary.contains("no skill-artifact proposal API"));
}

#[test]
fn the_capability_index_row_is_live() {
    let (m, f) = fixture(
        |mut d| {
            d.capability_status = Some(Arc::new(|| {
                Some(CapabilityStatus {
                    mode: "fts5-only".into(),
                    source_error: false,
                    last_recheck: None,
                })
            }));
            d
        },
        probe(json!([])),
    );
    start(&f).unwrap();
    let r = read(&m).unwrap();
    let c = find(&r, "capabilities.index").unwrap();
    assert_eq!(c.status, Status::Warn);
    assert_eq!(
        c.summary,
        "Capability index: fts5-only. Last recheck: pending."
    );
}

#[test]
fn composition_problems_are_listed_next_to_the_provisioning_checks() {
    let (m, f) = fixture(
        |mut d| {
            d.composition_checks = Some(Arc::new(|| {
                vec![Check::new(
                    "providers.broken",
                    Status::Fail,
                    "provider broken refused (E_CONFIG_INVALID): billing path \"enterprise\" is not one of plan",
                )]
            }));
            d
        },
        probe(json!([{"id": "models.cache", "status": "ok", "summary": "fine"}])),
    );
    start(&f).unwrap();
    let r = read(&m).unwrap();
    let rows: Vec<_> = r
        .checks()
        .filter(|c| c.id == "providers.broken")
        .map(|c| c.status)
        .collect();
    assert_eq!(rows, vec![Status::Fail]);
    assert!(find(&r, "models.cache").is_some());
}

#[test]
fn privacy_overlays_the_cached_report_immediately_without_another_probe() {
    let active = Arc::new(AtomicU32::new(0));
    let runs = Arc::new(AtomicU32::new(0));
    let (a, r) = (active.clone(), runs.clone());
    let check: CheckFn = Arc::new(move || {
        r.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"schema": "1staid.check/1", "checks": [{"id": "privacy.local-only", "status": "ok", "summary": "cached off"}]}),
        )
    });
    let (m, f) = fixture(
        move |mut d| {
            d.core_checks = Some(Arc::new(move || {
                let on = a.load(Ordering::SeqCst) == 1;
                vec![Check::new(
                    "privacy.local-only",
                    if on { Status::Fail } else { Status::Ok },
                    if on { "active cloud refusal" } else { "off" },
                )]
            }));
            d
        },
        check,
    );
    start(&f).unwrap();
    let first = read(&m).unwrap();
    assert_eq!(find(&first, "privacy.local-only").unwrap().summary, "off");
    active.store(1, Ordering::SeqCst);
    let second = read(&m).unwrap();
    let rows: Vec<_> = second
        .checks()
        .filter(|c| c.id == "privacy.local-only")
        .collect();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, Status::Fail);
}

#[test]
fn the_sandbox_task_cap_table() {
    struct Row(
        &'static str,
        bool,
        TaskMechanism,
        f64,
        Status,
        &'static str,
        Option<&'static str>,
    );
    let rows = [
        Row("unavailable sandbox skips the process cap", false, TaskMechanism::None, 512.0, Status::Skipped,
            "Process cap not checked: the sandbox is unavailable.", None),
        Row("Seatbelt reports fork denial even when the configured cap is off", true, TaskMechanism::ForkDenied, 0.0, Status::Ok,
            "Forks are denied in the tool sandbox (Seatbelt), whatever tools.sandbox.maxTasks says. The coding-gate verifier is not capped on macOS: process limits there count every process of the user.", None),
        Row("namespace accounting reports the configured task cap", true, TaskMechanism::NamespaceLimit, 7.0, Status::Ok,
            "At most 7 tasks per sandboxed run (tool sandbox and Linux coding-gate verifier), counted in the run's own user namespace.", None),
        Row("a disabled Linux process cap warns", true, TaskMechanism::NamespaceLimit, 0.0, Status::Warn,
            "Process cap off: the owner set tools.sandbox.maxTasks to 0.", None),
        Row("an unenforceable process cap reports the reason and hint", true, TaskMechanism::None, 512.0, Status::Warn,
            "No process cap: fixture reason", Some("Run PLUR1BUS as a normal user.")),
    ];
    for Row(name, available, mechanism, n, status, summary, hint) in rows {
        let (m, f) = fixture(
            move |mut d| {
                d.sandbox_max_tasks = Some(Arc::new(move || n));
                d.detect_sandbox = Arc::new(move |_| {
                    let mut s = sandbox(available, "bubblewrap", mechanism);
                    s.tasks.hint = hint.map(str::to_owned);
                    s
                });
                d
            },
            probe(json!([])),
        );
        start(&f).unwrap();
        let r = read(&m).unwrap();
        let checks: Vec<_> = r.checks().collect();
        let at = checks
            .iter()
            .position(|c| c.id == "tools.sandbox.tasks")
            .unwrap();
        assert_eq!(checks[at - 1].id, "tools.sandbox", "{name}");
        assert_eq!(checks[at].status, status, "{name}");
        assert_eq!(checks[at].summary, summary, "{name}");
        if let Some(h) = hint {
            assert_eq!(checks[at].repair.as_ref().unwrap().label, h, "{name}");
        }
    }
}

#[test]
fn the_probe_output_is_validated() {
    for (name, doc) in [
        ("wrong schema", json!({"schema": "x", "checks": []})),
        ("no checks", json!({"schema": "1staid.check/1"})),
        (
            "bad id",
            json!({"schema": "1staid.check/1", "checks": [{"id": "Bad", "status": "ok", "summary": "s"}]}),
        ),
        (
            "long id",
            json!({"schema": "1staid.check/1", "checks": [{"id": "a".repeat(101), "status": "ok", "summary": "s"}]}),
        ),
        (
            "bad status",
            json!({"schema": "1staid.check/1", "checks": [{"id": "a", "status": "bad", "summary": "s"}]}),
        ),
        (
            "no summary",
            json!({"schema": "1staid.check/1", "checks": [{"id": "a", "status": "ok"}]}),
        ),
        (
            "null item",
            json!({"schema": "1staid.check/1", "checks": [null]}),
        ),
        ("not an object", json!(7)),
    ] {
        let check: CheckFn = Arc::new(move || Ok(doc.clone()));
        let (_m, f) = fixture(|d| d, check);
        let e = start(&f).unwrap_err();
        assert_eq!(
            e.rpc().reason.as_deref(),
            Some("firstaid-invalid"),
            "{name}"
        );
    }
}

#[test]
fn statuses_map_and_a_core_check_cannot_shadow_a_probe_check() {
    let (m, f) = fixture(
        |mut d| {
            d.core_checks = Some(Arc::new(|| vec![Check::new("a", Status::Fail, "core")]));
            d.sandbox_required = Some(Arc::new(|| false));
            d
        },
        probe(json!([
            {"id": "a", "status": "info", "summary": "x"},
            {"id": "b", "status": "skip", "summary": "y"},
            {"id": "containers.x", "status": "ok", "summary": "z"}
        ])),
    );
    start(&f).unwrap();
    let r = read(&m).unwrap();
    // Cached `a` stays from the probe at generation; the live overlay replaces it by id.
    assert_eq!(find(&r, "a").unwrap().summary, "core");
    assert_eq!(find(&r, "b").unwrap().status, Status::Skipped);
    assert!(find(&r, "tools.sandbox.bypass").is_some());
    assert!(
        find(&r, "containers").is_none(),
        "a containers.* check stands for the category"
    );
    for id in ["secrets", "certificates", "ports", "disks"] {
        assert_eq!(find(&r, id).unwrap().status, Status::Skipped, "{id}");
    }
}

#[test]
fn the_host_eval_gate_decides_the_tool_eval_row() {
    let gate = |passed, label: &str| HostEvalGate {
        passed,
        models: vec![GateModel {
            provider: "p".into(),
            model: "m".into(),
            label: label.into(),
        }],
    };
    for (g, status, summary) in [
        (gate(true, "supported"), Status::Ok, "p/m: supported"),
        (
            gate(false, "limited tool use"),
            Status::Fail,
            "p/m: limited tool use",
        ),
        (gate(false, "unknown"), Status::Warn, "p/m: unknown"),
        (
            HostEvalGate {
                passed: false,
                models: vec![],
            },
            Status::Warn,
            "Host tool use unknown: no default model inventory/evidence available.",
        ),
    ] {
        let (m, f) = fixture(
            move |mut d| {
                d.host_eval = Arc::new(Host(g.clone()));
                d
            },
            probe(json!([])),
        );
        start(&f).unwrap();
        let r = read(&m).unwrap();
        let c = find(&r, "tools.tool-eval").unwrap();
        assert_eq!((c.status, c.summary.as_str()), (status, summary));
    }
}

#[test]
fn params_and_errors() {
    assert_eq!(
        DoctorParams::from_value(&json!({})).unwrap(),
        DoctorParams::default()
    );
    assert_eq!(
        DoctorParams::from_value(&json!({"refresh": true}))
            .unwrap()
            .refresh,
        Some(true)
    );
    assert!(DoctorParams::from_value(&json!({"refresh": "yes"})).is_err());
    assert!(DoctorParams::from_value(&json!([1])).is_err());
    let e = DoctorError::Rpc(RpcErr::new("E_CONFLICT", "x", Some("refresh-rate-limit")));
    assert!(e.into_method_error().is_some());
}
