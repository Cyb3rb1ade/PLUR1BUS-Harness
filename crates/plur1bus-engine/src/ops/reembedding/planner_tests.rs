#![allow(clippy::unwrap_used, reason = "frozen Node planner fixtures")]
use super::*;
use std::sync::Mutex;
fn f<'a>(v: &'a Json, k: &str) -> &'a Json {
    field(v, k).unwrap()
}
fn s(v: &Json, k: &str) -> String {
    get_text(v, k).unwrap()
}
fn fixture() -> Json {
    parse_json(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-plan.json"
    ))
    .unwrap()
}
struct Host<'a> {
    case: &'a Json,
    calls: Mutex<Vec<String>>,
    cancel_on: Option<&'static str>,
}
impl Host<'_> {
    fn call(&self, name: &str, cancel: &Cancel) {
        self.calls.lock().unwrap().push(name.into());
        if self.cancel_on == Some(name) {
            cancel.cancel();
        }
    }
}
impl PlanSource for Host<'_> {
    fn inventory_active_generation(&self, c: &Cancel) -> Result<Vec<Json>, PlanError> {
        self.call("inventory", c);
        Ok(array(f(self.case, "inventory")).unwrap().to_vec())
    }
    fn free_bytes(&self, c: &Cancel) -> Result<u64, PlanError> {
        self.call("disk", c);
        Ok(integer(f(self.case, "freeBytes")).unwrap())
    }
    fn target_artifacts_verified(&self, _: &Json, c: &Cancel) -> Result<bool, PlanError> {
        self.call("artifacts", c);
        let status = f(self.case, "artifacts");
        Ok(field(status, "ready") == Some(&Json::Bool(true))
            && field(status, "verified") == Some(&Json::Bool(true)))
    }
    fn probe_target(&self, target: &Json, c: &Cancel) -> Result<Vec<f64>, PlanError> {
        self.call("probe", c);
        match s(self.case, "probe").as_str() {
            "throw" => Err(PlanError::Dependency),
            "short" => Ok(vec![]),
            mode => {
                let n = integer(f(f(target, "fingerprint"), "dimensions")).unwrap() as usize;
                let mut v = vec![0.25; n];
                if mode == "nan" {
                    v[0] = f64::NAN;
                }
                Ok(v)
            }
        }
    }
}
fn host(case: &Json) -> Host<'_> {
    Host {
        case,
        calls: Mutex::new(vec![]),
        cancel_on: None,
    }
}
fn clock(case: &Json) -> f64 {
    let Json::Number(n) = f(case, "now") else {
        unreachable!()
    };
    n.parse().unwrap()
}
#[test]
fn actual_node_plans_digests_estimates_order_and_dependency_calls_match() {
    let fixture = fixture();
    let cases = array(f(&fixture, "cases")).unwrap();
    assert_eq!(cases.len(), 46);
    for case in cases {
        let name = s(case, "name");
        let host = host(case);
        let result = create(f(case, "request"), &host, clock(case), &Cancel::never());
        if field(case, "rustException").is_some() {
            assert!(
                matches!(
                    result,
                    Err(PlanError::Invalid(
                        "secret-bearing migration plan field is forbidden"
                    ))
                ),
                "{name}"
            );
            assert_eq!(*host.calls.lock().unwrap(), vec!["inventory"]);
            continue;
        }
        assert_eq!(
            *host.calls.lock().unwrap(),
            array(f(case, "calls"))
                .unwrap()
                .iter()
                .map(|v| super::super::state_json::text(v).unwrap())
                .collect::<Vec<_>>(),
            "{name}: dependency calls"
        );
        match result {
            Ok(plan) => {
                let expected = f(case, "result");
                assert_eq!(
                    write_json(plan.plan()),
                    write_json(f(expected, "plan")),
                    "{name}: plan bytes"
                );
                assert_eq!(plan.digest(), s(expected, "planDigest"), "{name}: digest");
                let persisted = serde_json::to_value(plan.confirmation().persisted()).unwrap();
                let expected_persisted: serde_json::Value =
                    serde_json::from_str(&write_json(f(expected, "persisted"))).unwrap();
                for k in ["schemaVersion", "planDigest", "expiresAt"] {
                    assert_eq!(persisted[k], expected_persisted[k], "{name}: {k}");
                }
                assert!(confirmation::verify(
                    plan.confirmation().expose_token(),
                    &persisted,
                    clock(case)
                ));
                assert!(!write_json(plan.plan()).contains(plan.confirmation().expose_token()));
                assert!(!format!("{plan:?}").contains(plan.confirmation().expose_token()));
            }
            Err(e) => {
                let expected = s(case, "error");
                match e {
                    PlanError::Invalid(c) => {
                        assert!(expected.starts_with(c), "{name}: {expected} vs {c}")
                    }
                    PlanError::Dependency => assert_eq!(expected, "synthetic probe failure"),
                    _ => unreachable!("unexpected error {e:?}"),
                }
            }
        }
    }
}
#[test]
fn cancellation_between_each_host_step_never_issues_a_plan() {
    let fixture = fixture();
    let cases = array(f(&fixture, "cases")).unwrap();
    for case in cases
        .iter()
        .filter(|v| matches!(s(v, "name").as_str(), "remote" | "local-verified"))
    {
        let expected = array(f(case, "calls")).unwrap();
        for stage in ["inventory", "disk", "artifacts", "probe"] {
            if !expected
                .iter()
                .any(|v| super::super::state_json::text(v).as_deref() == Some(stage))
            {
                continue;
            }
            let mut host = host(case);
            host.cancel_on = Some(stage);
            assert!(matches!(
                create(f(case, "request"), &host, clock(case), &Cancel::never()),
                Err(PlanError::Cancelled)
            ));
            assert_eq!(host.calls.lock().unwrap().last().unwrap(), stage);
        }
    }
    let case = &cases[0];
    let host = host(case);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        create(f(case, "request"), &host, clock(case), &cancel),
        Err(PlanError::Cancelled)
    ));
    assert!(host.calls.lock().unwrap().is_empty());
}
