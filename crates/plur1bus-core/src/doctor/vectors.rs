//! Replay of `fixtures/parity/doctor/report.json` (recorded by `scripts/parity/export-doctor.ts`): every case drives the
//! TypeScript handler; here the same deps drive [`DoctorMethods`], and the report (or the refusal) must be equal.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::tests::{base, Access, Host, Role};
use super::*;
use crate::metrics::metrics::TURN_END_REASONS;
use serde_json::json;
use std::sync::atomic::AtomicI64;

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/parity/doctor/report.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `{ parts: [...] }` is the concatenation of the parts.
fn resolve(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(resolve).collect()),
        Value::Object(o) => {
            if o.len() == 1 {
                if let Some(Value::Array(parts)) = o.get("parts") {
                    return Value::String(parts.iter().map(|p| p.as_str().unwrap()).collect());
                }
            }
            Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x))).collect())
        }
        other => other.clone(),
    }
}

fn text(v: &Value) -> String {
    resolve(v).as_str().unwrap().to_owned()
}

fn check_of(v: &Value) -> Check {
    let mut c = Check::new(
        v["id"].as_str().unwrap(),
        Status::parse(v["status"].as_str().unwrap()).unwrap(),
        text(&v["summary"]),
    );
    if let Some(r) = v.get("repair") {
        c = c.with_repair(r["kind"].as_str().unwrap(), text(&r["label"]));
    }
    c
}

fn checks_of(v: Option<&Value>) -> Option<Vec<Check>> {
    v.map(|a| a.as_array().unwrap().iter().map(check_of).collect())
}

fn sandbox_of(v: &Value) -> SandboxDetection {
    let t = &v["tasks"];
    let opt = |x: &Value| x.get("hint").map(text);
    SandboxDetection {
        backend: v["backend"].as_str().unwrap().into(),
        strength: v["strength"].as_str().unwrap().into(),
        available: v["available"].as_bool().unwrap(),
        tasks: SandboxTasks {
            mechanism: match t["mechanism"].as_str().unwrap() {
                "namespace-limit" => TaskMechanism::NamespaceLimit,
                "fork-denied" => TaskMechanism::ForkDenied,
                _ => TaskMechanism::None,
            },
            reason: text(&t["reason"]),
            hint: opt(t),
        },
        reason: text(&v["reason"]),
        hint: opt(v),
    }
}

fn usage_of(v: &Value) -> TurnTelemetrySummary {
    let f = |x: &Value| x.as_f64().unwrap();
    let tr = &v["triage"];
    TurnTelemetrySummary {
        turns: f(&v["turns"]),
        rounds: f(&v["rounds"]),
        tool_calls: f(&v["toolCalls"]),
        meta_calls: [
            f(&v["metaCalls"]["search"]),
            f(&v["metaCalls"]["skillLoad"]),
            f(&v["metaCalls"]["skillRead"]),
        ],
        skills: [f(&v["skills"]["injected"]), f(&v["skills"]["loaded"])],
        errors_returned: f(&v["errorsReturned"]),
        tool_need_turns: f(&v["toolNeedTurns"]),
        forced_turns: f(&v["forcedTurns"]),
        without_needed_tool: f(&v["withoutNeededTool"]),
        tool_choice_unsupported: f(&v["toolChoiceUnsupported"]),
        end_reasons: TURN_END_REASONS
            .iter()
            .map(|r| f(&v["endReasons"][*r]))
            .collect(),
        triage_count: usize::try_from(tr["count"].as_u64().unwrap()).unwrap(),
        triage_p50_ms: tr.get("p50Ms").map(f),
        triage_p95_ms: tr.get("p95Ms").map(f),
    }
}

fn run(case: &Value, clock_ms: i64, user_home: &str) -> Value {
    let platform = case["platform"].as_str().unwrap().to_owned();
    let home = case["home"].as_str().unwrap();
    let check: CheckFn = match &case["probe"] {
        p if p.get("doc").is_some() => probe_doc(resolve(&p["doc"])),
        p if p["throws"] == "plain" => Arc::new(|| Err(CheckError::Other("spawn failed".into()))),
        p => {
            let reason = p["reason"].as_str().unwrap().to_owned();
            Arc::new(move || Err(CheckError::Rpc(firstaid::unavailable(&reason))))
        }
    };
    let now = Arc::new(AtomicI64::new(clock_ms));
    let mut d = base(
        home,
        now.clone(),
        Arc::new(Access(Mutex::new(Role::Viewer))),
        check,
    );
    d.user_home = Some(user_home.into());
    d.linux = Some(platform == "linux");
    d.external_agent_refusal = Arc::new(move || match platform.as_str() {
        "darwin" => Some(ExternalAgentRefusal {
            reason: "sandbox-unavailable".into(),
            cause: Some("macos-acceptance-pending".into()),
        }),
        "linux" => None,
        _ => Some(ExternalAgentRefusal {
            reason: "sandbox-unavailable".into(),
            cause: None,
        }),
    });
    let sandbox = sandbox_of(&case["sandbox"]);
    d.detect_sandbox = Arc::new(move |_| sandbox.clone());
    d.host_eval = Arc::new(Host(HostEvalGate {
        passed: false,
        models: vec![],
    }));
    if let Some(n) = case.get("maxTasks").and_then(Value::as_f64) {
        d.sandbox_max_tasks = Some(Arc::new(move || n));
    }
    if let Some(b) = case.get("sandboxRequired").and_then(Value::as_bool) {
        d.sandbox_required = Some(Arc::new(move || b));
    }
    if let Some(list) = checks_of(case.get("coreChecks")) {
        d.core_checks = Some(Arc::new(move || list.clone()));
    }
    if let Some(list) = checks_of(case.get("compositionChecks")) {
        d.composition_checks = Some(Arc::new(move || list.clone()));
    }
    if let Some(c) = case.get("capability") {
        let cap = CapabilityStatus {
            mode: c["mode"].as_str().unwrap().into(),
            source_error: c["sourceError"].as_bool().unwrap(),
            last_recheck: c["lastRecheck"].as_f64(),
        };
        d.capability_status = Some(Arc::new(move || Some(cap.clone())));
    }
    if let Some(m) = case.get("mining") {
        let available = m["available"].as_bool().unwrap();
        d.mining_status = Some(Arc::new(move || Some(MiningStatus { available })));
    }
    if let Some(u) = case.get("usage") {
        let usage = usage_of(u);
        d.turn_telemetry = Some(Arc::new(move || Some(usage.clone())));
    }
    let slot: Arc<Mutex<Option<StartFn>>> = Arc::new(Mutex::new(None));
    let s2 = slot.clone();
    d.schedule_initial = Some(Box::new(move |s| *lock(&s2) = Some(s)));
    let m = DoctorMethods::new(d).unwrap();
    let start = lock(&slot).clone().unwrap();
    let _ = start();
    now.fetch_add(30_000, std::sync::atomic::Ordering::SeqCst);
    match m.report(
        &DoctorParams::default(),
        &CallContext::new("request", "connection"),
    ) {
        Ok(r) => json!({"ok": r.to_value()}),
        Err(e) => json!({"error": {"code": e.rpc().code, "reason": e.rpc().reason}}),
    }
}

fn probe_doc(doc: Value) -> CheckFn {
    Arc::new(move || Ok(doc.clone()))
}

#[test]
fn every_recorded_case_gives_the_same_report() {
    let fx = fixture();
    let r = &fx;
    let clock = r["clockMs"].as_i64().unwrap();
    let user_home = r["userHome"].as_str().unwrap();
    let cases = r["cases"].as_array().unwrap();
    assert!(cases.len() >= 100, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let got = run(case, clock, user_home);
        if got != case["expected"] {
            failures.push(format!(
                "{}\n  expected {}\n  got      {}",
                case["name"].as_str().unwrap(),
                case["expected"],
                got
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
