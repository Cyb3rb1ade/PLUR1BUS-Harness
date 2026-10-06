//! `plur1bus 1staid repair` (spec §6.6, D12, HB16): runs the `1staid check` pass, plans a step for each finding it
//! can repair, prints the whole plan, asks (or takes `--yes`), applies the confirmed steps and checks again.
//!
//! Exit codes: 0 when no step failed and the check afterwards has no `fail`; 1 otherwise; 2 for a usage error and for
//! a plan that needs a confirmation when there is no terminal to ask on and no `--yes` (nothing changes then).
use super::firstaid::{self, GATHER_BUDGET};
use crate::cli::RepairArgs;
use crate::install::setup::StdinPrompter;
use crate::output::Out;
use crate::paths::Layout;
use crate::repair::{self, risk_name, CheckAfter, Ctx, Plan, StepStatus, STEP_ORDER};
use serde_json::json;
use std::io::IsTerminal;
use std::time::Instant;

fn status_name(s: StepStatus) -> &'static str {
    match s {
        StepStatus::Planned => "planned",
        StepStatus::Done => "done",
        StepStatus::Skipped => "skipped",
        StepStatus::Failed => "FAILED",
        StepStatus::Declined => "declined",
    }
}

/// The plan as text: one line per step.
fn describe(plan: &Plan) -> String {
    if plan.steps.is_empty() {
        return "nothing to repair".to_string();
    }
    plan.steps
        .iter()
        .map(|s| {
            let mut line = format!(
                "{:<8} {:<6} {:<24} {}: {}",
                status_name(s.status),
                risk_name(s.risk),
                s.id,
                s.action,
                s.target
            );
            if matches!(s.status, StepStatus::Skipped | StepStatus::Failed) {
                if let Some(m) = s.detail.as_ref().and_then(|d| d["message"].as_str()) {
                    line.push_str(&format!(" ({m})"));
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn run(out: &Out, layout: &Layout, args: RepairArgs) -> ! {
    if let Some(unknown) = args.only.iter().find(|o| !STEP_ORDER.contains(&o.as_str())) {
        out.fail(
            "E_INVALID_PARAMS",
            &format!("--only {unknown}: no such repair step"),
            json!({ "step": unknown, "steps": STEP_ORDER }),
            2,
        );
    }
    let runner = super::service::runner(out);
    let ctx = Ctx::for_host(layout, runner.as_ref());
    let checks = firstaid::collect(layout, runner.as_ref(), Instant::now() + GATHER_BUDGET);
    let mut plan = repair::plan_for(&checks, &ctx, &args.only);

    if args.dry_run {
        out.ok(
            "1staid.repair/1",
            &json!({ "dryRun": true, "steps": plan.steps, "checkAfter": null }),
            || describe(&plan),
        );
        std::process::exit(0);
    }

    let interactive = std::io::stdin().is_terminal() && !out.json;
    if plan.needs_confirmation() && !args.yes && !interactive {
        if !out.json {
            crate::output::say(&describe(&plan));
        }
        out.fail(
            "E_INVALID_PARAMS",
            "the repair plan needs a confirmation: re-run with --yes to apply it (nothing was changed)",
            json!({ "applied": false, "dryRun": false, "steps": plan.steps }),
            2,
        );
    }
    if interactive && plan.needs_confirmation() {
        crate::output::say(&describe(&plan));
    }

    repair::execute(&mut plan, &ctx, &mut StdinPrompter, args.yes);
    let after = firstaid::collect(layout, runner.as_ref(), Instant::now() + GATHER_BUDGET);
    let check_after = CheckAfter::of(&after);
    let failed = plan.steps.iter().any(|s| s.status == StepStatus::Failed);
    let clean = !failed && check_after.fail == 0;
    out.ok(
        "1staid.repair/1",
        &json!({ "dryRun": false, "steps": plan.steps, "checkAfter": check_after }),
        || {
            let tail = if check_after.fail == 0 {
                format!(
                    "check afterwards: {} ok, {} warn, no failures",
                    check_after.ok, check_after.warn
                )
            } else {
                format!(
                    "check afterwards: {} failing ({})",
                    check_after.fail,
                    check_after.failing.join(", ")
                )
            };
            format!("{}\n{tail}", describe(&plan))
        },
    );
    std::process::exit(if clean { 0 } else { 1 })
}
