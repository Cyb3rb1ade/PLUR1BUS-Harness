//! From `1staid check` rows to repair steps (HB16). Each step answers one check id (its `reason`):
//!
//! | step | check | risk |
//! |---|---|---|
//! | `run.permissions.fix` | `run.permissions` fail | low |
//! | `run.stale-files.remove` | `run.stale-files` warn/fail | low |
//! | `config.restore` | `config.valid` fail | medium |
//! | `service.renew` | `service.registration` warn/fail | low |
//! | `runtime.node.reinstall` | `runtime.node` fail | medium |
//! | `runtime.core.reinstall` | `runtime.core` fail | medium |
//!
//! The last four ids (`unit.terminate-hung`, `store.migrate`, `service.silent-exit`, `service.restart-loop`) probe
//! the units and read `logs/supervisor.log` themselves ([`risky::plan`]).
//!
//! A row the check pass never reached (its "time budget exhausted" warning) plans nothing: there is no finding to
//! act on.
use super::{risky, safe, Ctx, Plan, Risk, Step, STEP_ORDER};
use crate::commands::firstaid::{Check, Status, BUDGET_EXHAUSTED};
use serde_json::json;

/// The plan for `checks`, in [`STEP_ORDER`]. `only` (the `--only` ids) keeps just the named steps; empty keeps all.
pub fn plan_for(checks: &[Check], ctx: &Ctx, only: &[String]) -> Plan {
    let find = |id: &str| {
        checks
            .iter()
            .find(|c| c.id == id && c.summary != BUDGET_EXHAUSTED)
    };
    let failing = |id: &str| find(id).filter(|c| c.status == Status::Fail);
    let not_ok = |id: &str| find(id).filter(|c| matches!(c.status, Status::Warn | Status::Fail));

    let mut steps: Vec<Step> = Vec::new();
    if let Some(c) = failing("run.permissions") {
        steps.push(
            Step::planned(
                "run.permissions.fix",
                safe::PERMISSIONS_ACTION,
                "run",
                "run.permissions",
                Risk::Low,
                safe::fix_run_permissions,
            )
            .with_detail(json!({ "finding": c.summary })),
        );
    }
    if let Some(c) = not_ok("run.stale-files") {
        let files: Vec<String> = c
            .detail
            .as_ref()
            .and_then(|d| d["files"].as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| f.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if !files.is_empty() {
            let target = files
                .iter()
                .map(|f| format!("run/{f}"))
                .collect::<Vec<_>>()
                .join(", ");
            steps.push(
                Step::planned(
                    "run.stale-files.remove",
                    "remove the run files with no live process behind them",
                    target,
                    "run.stale-files",
                    Risk::Low,
                    safe::remove_stale_files,
                )
                .with_detail(json!({ "files": files })),
            );
        }
    }
    if let Some(c) = failing("config.valid") {
        steps.push(
            Step::planned(
                "config.restore",
                "back up config.json and restore the running configuration or the newest valid backup",
                "config.json",
                "config.valid",
                Risk::Medium,
                safe::restore_config,
            )
            .with_detail(json!({ "finding": c.summary })),
        );
    }
    if not_ok("service.registration").is_some() {
        let step = Step::planned(
            "service.renew",
            "rewrite and register the service unit (not started)",
            crate::service::service_name(ctx.layout, &crate::paths::default_home()),
            "service.registration",
            Risk::Low,
            safe::renew_service,
        );
        steps.push(if crate::container::container_mode() {
            step.skipped_because(
                "container-managed",
                "the image manages the service in container mode",
            )
        } else {
            step
        });
    }
    if let Some(c) = failing("runtime.node") {
        steps.push(
            Step::planned(
                "runtime.node.reinstall",
                "download, verify and reinstall the pinned Node runtime",
                format!("runtime/node-{}", crate::install::pins::NODE_VERSION),
                "runtime.node",
                Risk::Medium,
                safe::reinstall_node,
            )
            .with_detail(json!({ "finding": c.summary })),
        );
    }
    if let Some(c) = failing("runtime.core") {
        let step = Step::planned(
            "runtime.core.reinstall",
            "download, verify and reinstall the core payload of this release",
            "runtime/core",
            "runtime.core",
            Risk::Medium,
            safe::reinstall_core,
        )
        .with_detail(json!({ "finding": c.summary }));
        steps.push(match safe::release_core_source() {
            Ok(_) => step,
            Err(message) => step.skipped_because("core-source-missing", &message),
        });
    }

    let wanted = |id: &str| only.is_empty() || only.iter().any(|o| o == id);
    steps.extend(risky::plan(checks, ctx, &wanted));

    steps.retain(|s| wanted(s.id));
    steps.sort_by_key(|s| STEP_ORDER.iter().position(|id| *id == s.id));
    Plan { steps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Layout;
    use crate::service::fake::FakeRunner;
    use serde_json::Value;

    fn check(id: &'static str, status: Status, detail: Option<Value>) -> Check {
        Check {
            id,
            status,
            summary: format!("{id} finding"),
            detail,
            hint: None,
        }
    }

    fn ids(p: &Plan) -> Vec<&'static str> {
        p.steps.iter().map(|s| s.id).collect()
    }

    fn with_ctx(f: impl FnOnce(&Ctx)) {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().join("h"));
        let runner = FakeRunner::new(dir.path().to_path_buf());
        f(&Ctx::for_host(&layout, &runner));
    }

    #[test]
    fn every_finding_maps_to_its_step_in_step_order() {
        with_ctx(|ctx| {
            let checks = vec![
                check("config.valid", Status::Fail, None),
                check("run.permissions", Status::Fail, None),
                check(
                    "run.stale-files",
                    Status::Warn,
                    Some(json!({ "files": ["core.pid", "core.sock"] })),
                ),
                check("service.registration", Status::Warn, None),
                check("runtime.node", Status::Fail, None),
                check("runtime.core", Status::Fail, None),
            ];
            let p = plan_for(&checks, ctx, &[]);
            assert_eq!(
                ids(&p),
                [
                    "run.permissions.fix",
                    "run.stale-files.remove",
                    "config.restore",
                    "service.renew",
                    "runtime.node.reinstall",
                    "runtime.core.reinstall"
                ]
            );
            let risks: Vec<Risk> = p.steps.iter().map(|s| s.risk).collect();
            let (l, m) = (Risk::Low, Risk::Medium);
            assert_eq!(risks, [l, l, m, l, m, m]);
            assert_eq!(p.steps[1].target, "run/core.pid, run/core.sock");
            let reasons: Vec<&str> = p.steps.iter().map(|s| s.reason).collect();
            assert_eq!(
                reasons,
                [
                    "run.permissions",
                    "run.stale-files",
                    "config.valid",
                    "service.registration",
                    "runtime.node",
                    "runtime.core"
                ]
            );
            // A dev build bakes no release payload: the core step is listed, but skipped.
            if crate::install::pins::release_base_url().is_none() {
                assert_eq!(p.steps[5].status, super::super::StepStatus::Skipped);
                assert_eq!(
                    p.steps[5].detail.as_ref().unwrap()["reason"],
                    "core-source-missing"
                );
            }
        });
    }

    #[test]
    fn ok_rows_warnings_that_need_nothing_and_unreached_rows_plan_nothing() {
        with_ctx(|ctx| {
            let exhausted = Check {
                summary: BUDGET_EXHAUSTED.to_string(),
                ..check("service.registration", Status::Warn, None)
            };
            let checks = vec![
                check("run.permissions", Status::Ok, None),
                check("config.valid", Status::Warn, None),
                check("runtime.node", Status::Skip, None),
                check("run.stale-files", Status::Warn, None),
                exhausted,
            ];
            assert!(plan_for(&checks, ctx, &[]).steps.is_empty());
        });
    }

    #[test]
    fn only_keeps_the_named_steps() {
        with_ctx(|ctx| {
            let checks = vec![
                check("config.valid", Status::Fail, None),
                check("run.permissions", Status::Fail, None),
            ];
            let p = plan_for(&checks, ctx, &["config.restore".to_string()]);
            assert_eq!(ids(&p), ["config.restore"]);
        });
    }
}
