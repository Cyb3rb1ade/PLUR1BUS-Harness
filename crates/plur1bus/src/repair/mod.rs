//! `plur1bus 1staid repair` (spec §6.6, D12, HB16): a plan of steps over the rows `1staid check` reports as failing,
//! printed whole before anything changes, then applied step by step once confirmed.
//!
//! The plan document is `1staid.repair/1` (⟂DESKTOP: the design canvas's repair flow and the D66 skill read it):
//! `{ schema, dryRun, steps: [{ id, action, target, reason, risk, needsConfirmation, status, detail? }], checkAfter }`.
//! `reason` is the check id the step answers. Steps run in [`STEP_ORDER`]. Safety rules (HB16): nothing is applied
//! without a confirmation (one prompt for the `none`/`low` steps, one per `medium`/`high` step, or `--yes`), `state/`
//! is never touched, and every applied step appends one `repair.<id>` line to the audit log.
//!
//! [`plan`] maps checks to steps; [`safe`] holds the steps of 2a-H3b-b Task 7, [`risky`] the last four ids of
//! [`STEP_ORDER`] (Task 8: the hung unit, the store migration and the two HB17 reports).
pub mod plan;
pub mod risky;
pub mod safe;

use crate::commands::firstaid::Check;
use crate::install::setup::Prompter;
use crate::paths::Layout;
use crate::service::Runner;
use serde::Serialize;
use serde_json::{json, Value};

pub use plan::plan_for;

/// Every step id, in the order a plan lists and applies them.
pub const STEP_ORDER: &[&str] = &[
    "run.permissions.fix",
    "run.stale-files.remove",
    "config.restore",
    "service.renew",
    "runtime.node.reinstall",
    "runtime.core.reinstall",
    /* Task 8: */ "unit.terminate-hung",
    "store.migrate",
    "service.silent-exit",
    "service.restart-loop",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    None,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Planned,
    Done,
    Skipped,
    Failed,
    Declined,
}

/// What a step needs to apply itself: the home and the service manager seam (tests pass the recording fake).
pub struct Ctx<'a> {
    pub layout: &'a Layout,
    pub runner: &'a dyn Runner,
}

impl Ctx<'_> {
    pub fn for_host<'a>(layout: &'a Layout, runner: &'a dyn Runner) -> Ctx<'a> {
        Ctx { layout, runner }
    }
}

/// The function that applies a step: `Ok(detail)` when it is done, `Err(message)` when it failed. A step that finds,
/// right before it would change something, that it must not (the unit it pinned is not the one serving any more)
/// returns `Ok({ "skipped": true, "reason", "message" })` and becomes `skipped`.
pub type Apply = fn(&Ctx, &Step) -> Result<Value, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: &'static str,
    pub action: &'static str,
    pub target: String,
    pub reason: &'static str,
    pub risk: Risk,
    pub needs_confirmation: bool,
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
    #[serde(skip)]
    apply: Apply,
}

impl std::fmt::Debug for Step {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Step")
            .field("id", &self.id)
            .field("risk", &self.risk)
            .field("status", &self.status)
            .field("detail", &self.detail)
            .finish()
    }
}

impl Step {
    /// A `planned` step that needs a confirmation.
    pub fn planned(
        id: &'static str,
        action: &'static str,
        target: impl Into<String>,
        reason: &'static str,
        risk: Risk,
        apply: Apply,
    ) -> Step {
        Step {
            id,
            action,
            target: target.into(),
            reason,
            risk,
            needs_confirmation: true,
            status: StepStatus::Planned,
            detail: None,
            apply,
        }
    }

    /// A `report` step (HB17): risk `none`, no confirmation, no change; `done` once executed, its `detail` the
    /// evidence.
    pub fn report(
        id: &'static str,
        target: impl Into<String>,
        reason: &'static str,
        apply: Apply,
    ) -> Step {
        Step {
            needs_confirmation: false,
            ..Step::planned(id, "report", target, reason, Risk::None, apply)
        }
    }

    /// The step is listed but will not run: `detail.reason` says why (`container-managed`, `core-source-missing`).
    pub fn skipped_because(mut self, reason: &str, message: &str) -> Step {
        self.status = StepStatus::Skipped;
        self.detail = Some(json!({ "reason": reason, "message": message }));
        self
    }

    pub fn with_detail(mut self, detail: Value) -> Step {
        self.detail = Some(detail);
        self
    }

    fn low_group(&self) -> bool {
        self.risk <= Risk::Low
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Plan {
    pub steps: Vec<Step>,
}

impl Plan {
    /// Whether applying this plan needs someone's confirmation.
    pub fn needs_confirmation(&self) -> bool {
        self.steps
            .iter()
            .any(|s| s.status == StepStatus::Planned && s.needs_confirmation)
    }
}

/// The `checkAfter` summary of a `1staid check` pass: counts and the failing ids.
#[derive(Debug, Clone, Serialize)]
pub struct CheckAfter {
    pub ok: usize,
    pub warn: usize,
    pub fail: usize,
    pub failing: Vec<&'static str>,
}

impl CheckAfter {
    pub fn of(checks: &[Check]) -> CheckAfter {
        use crate::commands::firstaid::Status;
        let count = |s: Status| checks.iter().filter(|c| c.status == s).count();
        CheckAfter {
            ok: count(Status::Ok),
            warn: count(Status::Warn),
            fail: count(Status::Fail),
            failing: checks
                .iter()
                .filter(|c| c.status == Status::Fail)
                .map(|c| c.id)
                .collect(),
        }
    }
}

/// Asks for the confirmations and applies the confirmed steps in order. With `yes` nothing is asked. Otherwise one
/// question covers every `none`/`low` step that needs a confirmation, and each `medium`/`high` one gets its own;
/// all questions come before the first change. A declined step becomes `declined`; a step that is not `planned`
/// (already `skipped`) is left as it is. Each applied step appends one `repair.<id>` audit line.
pub fn execute(plan: &mut Plan, ctx: &Ctx, confirm: &mut dyn Prompter, yes: bool) {
    let pending = |s: &Step| s.status == StepStatus::Planned && s.needs_confirmation;
    if !yes {
        let low: Vec<&'static str> = plan
            .steps
            .iter()
            .filter(|s| pending(s) && s.low_group())
            .map(|s| s.id)
            .collect();
        let low_ok = low.is_empty()
            || confirm.confirm(&format!(
                "Apply {} low-risk step(s): {}",
                low.len(),
                low.join(", ")
            ));
        for s in plan.steps.iter_mut().filter(|s| pending(s)) {
            let ok = if s.low_group() {
                low_ok
            } else {
                confirm.confirm(&format!(
                    "Apply {} ({} risk): {} {}",
                    s.id,
                    risk_name(s.risk),
                    s.action,
                    s.target
                ))
            };
            if !ok {
                s.status = StepStatus::Declined;
            }
        }
    }
    for i in 0..plan.steps.len() {
        if plan.steps[i].status != StepStatus::Planned {
            continue;
        }
        let s = plan.steps[i].clone();
        let (status, mut detail) = match (s.apply)(ctx, &s) {
            Ok(mut d) if d["skipped"] == true => {
                if let Some(o) = d.as_object_mut() {
                    o.remove("skipped");
                }
                (StepStatus::Skipped, d)
            }
            Ok(d) => (StepStatus::Done, d),
            Err(message) => (StepStatus::Failed, json!({ "message": message })),
        };
        let audit_detail = json!({ "status": status, "reason": s.reason, "detail": detail });
        if let Err(e) = crate::audit::append(
            ctx.layout,
            &format!("repair.{}", s.id),
            &s.target,
            audit_detail,
        ) {
            if let Some(o) = detail.as_object_mut() {
                o.insert("auditError".into(), json!(e.to_string()));
            }
        }
        let step = &mut plan.steps[i];
        step.status = status;
        step.detail = Some(detail);
    }
}

pub fn risk_name(r: Risk) -> &'static str {
    match r {
        Risk::None => "none",
        Risk::Low => "low",
        Risk::Medium => "medium",
        Risk::High => "high",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::fake::FakeRunner;

    struct Script {
        answers: Vec<bool>,
        asked: Vec<String>,
    }
    impl Prompter for Script {
        fn ask(&mut self, _key: &str, _question: &str, default: &str) -> String {
            default.to_string()
        }
        fn confirm(&mut self, question: &str) -> bool {
            self.asked.push(question.to_string());
            if self.answers.is_empty() {
                false
            } else {
                self.answers.remove(0)
            }
        }
    }

    fn ok_apply(_: &Ctx, s: &Step) -> Result<Value, String> {
        Ok(json!({ "applied": s.id }))
    }
    fn failing_apply(_: &Ctx, _: &Step) -> Result<Value, String> {
        Err("nope".into())
    }
    fn never_apply(_: &Ctx, s: &Step) -> Result<Value, String> {
        panic!("{} must not run", s.id)
    }

    fn plan() -> Plan {
        Plan {
            steps: vec![
                Step::planned(
                    "run.permissions.fix",
                    "chmod",
                    "run",
                    "run.permissions",
                    Risk::Low,
                    ok_apply,
                ),
                Step::planned(
                    "run.stale-files.remove",
                    "remove",
                    "run/x",
                    "run.stale-files",
                    Risk::Low,
                    ok_apply,
                ),
                Step::planned(
                    "config.restore",
                    "restore",
                    "config.json",
                    "config.valid",
                    Risk::Medium,
                    ok_apply,
                ),
                Step::planned(
                    "runtime.node.reinstall",
                    "reinstall",
                    "runtime/node",
                    "runtime.node",
                    Risk::Medium,
                    failing_apply,
                ),
                Step::planned(
                    "service.renew",
                    "renew",
                    "svc",
                    "service.registration",
                    Risk::Low,
                    never_apply,
                )
                .skipped_because("container-managed", "container"),
            ],
        }
    }

    fn with_ctx(f: impl FnOnce(&Ctx)) {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        let runner = FakeRunner::new(dir.path().to_path_buf());
        f(&Ctx::for_host(&layout, &runner));
    }

    #[test]
    fn one_prompt_covers_the_low_steps_and_each_medium_step_gets_its_own() {
        with_ctx(|ctx| {
            let mut p = plan();
            let mut s = Script {
                answers: vec![true, false, true],
                asked: vec![],
            };
            execute(&mut p, ctx, &mut s, false);
            assert_eq!(s.asked.len(), 3, "{:?}", s.asked);
            assert!(s.asked[0].contains("run.permissions.fix, run.stale-files.remove"));
            assert!(s.asked[1].starts_with("Apply config.restore (medium risk)"));
            assert!(s.asked[2].starts_with("Apply runtime.node.reinstall"));
            let st: Vec<StepStatus> = p.steps.iter().map(|s| s.status).collect();
            assert_eq!(
                st,
                [
                    StepStatus::Done,
                    StepStatus::Done,
                    StepStatus::Declined,
                    StepStatus::Failed,
                    StepStatus::Skipped
                ]
            );
            assert_eq!(p.steps[3].detail, Some(json!({ "message": "nope" })));
            let audit = std::fs::read_to_string(ctx.layout.audit_log()).unwrap();
            let actions: Vec<Value> = audit
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect();
            let names: Vec<&str> = actions
                .iter()
                .map(|a| a["action"].as_str().unwrap())
                .collect();
            assert_eq!(
                names,
                [
                    "repair.run.permissions.fix",
                    "repair.run.stale-files.remove",
                    "repair.runtime.node.reinstall"
                ]
            );
            assert_eq!(actions[2]["detail"]["status"], "failed");
        });
    }

    #[test]
    fn declining_the_plan_prompt_declines_every_low_step_and_yes_asks_nothing() {
        with_ctx(|ctx| {
            let mut p = plan();
            let mut s = Script {
                answers: vec![false, false, false],
                asked: vec![],
            };
            execute(&mut p, ctx, &mut s, false);
            assert_eq!(p.steps[0].status, StepStatus::Declined);
            assert_eq!(p.steps[1].status, StepStatus::Declined);
            assert!(!ctx.layout.audit_log().exists());

            let mut p = plan();
            let mut s = Script {
                answers: vec![],
                asked: vec![],
            };
            execute(&mut p, ctx, &mut s, true);
            assert!(s.asked.is_empty());
            assert_eq!(p.steps[2].status, StepStatus::Done);
        });
    }

    #[test]
    fn the_step_document_has_the_canvas_fields() {
        let p = plan();
        let v = serde_json::to_value(&p.steps[2]).unwrap();
        assert_eq!(
            v,
            json!({ "id": "config.restore", "action": "restore", "target": "config.json", "reason": "config.valid",
                    "risk": "medium", "needsConfirmation": true, "status": "planned" })
        );
        let v = serde_json::to_value(&p.steps[4]).unwrap();
        assert_eq!(v["status"], "skipped");
        assert_eq!(v["detail"]["reason"], "container-managed");
        assert!(!p.steps.is_empty() && Plan::default().steps.is_empty());
        assert!(p.needs_confirmation() && !Plan::default().needs_confirmation());
    }

    #[test]
    fn step_order_lists_every_id_once() {
        let mut ids = STEP_ORDER.to_vec();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), STEP_ORDER.len());
    }
}
