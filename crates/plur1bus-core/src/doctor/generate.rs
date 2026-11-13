//! `generate()` and `currentReport()` of `doctor-report.ts`.

use super::firstaid::unavailable;
use super::report::{Check, Group, Report, Status};
use super::{CheckError, Inner, ModelRef, TaskMechanism, DEFAULT_MAX_TASKS};
use crate::frame::RpcErr;
use crate::logs::query::iso_string;
use crate::metrics::metrics::TURN_END_REASONS;
use crate::metrics::registry::js_number_to_string;
use serde_json::Value;

const SKIPPED_CATEGORIES: [&str; 5] = ["containers", "secrets", "certificates", "ports", "disks"];

fn invalid() -> RpcErr {
    unavailable("firstaid-invalid")
}

fn valid_id(id: &str) -> bool {
    (1..=100).contains(&id.len())
        && id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

fn num(n: f64) -> String {
    js_number_to_string(n)
}

impl Inner {
    fn safe_check(&self, c: &Check) -> Check {
        let mut out = Check::new(c.id.clone(), c.status, self.sanitizer.safe(&c.summary));
        if let Some(r) = &c.repair {
            out = out.with_repair(r.kind.clone(), self.sanitizer.safe(&r.label));
        }
        out
    }

    /// One run of the probe and the checks around it.
    pub(super) fn generate(&self) -> Result<Report, RpcErr> {
        let raw = (self.check)().map_err(|e| match e {
            CheckError::Rpc(e) => e,
            CheckError::Other(_) => unavailable("firstaid-unavailable"),
        })?;
        let safe = |t: &str| self.sanitizer.safe(t);
        if raw.get("schema").and_then(Value::as_str) != Some("1staid.check/1") {
            return Err(invalid());
        }
        let items = raw
            .get("checks")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        let mut checks: Vec<Check> = Vec::with_capacity(items.len() + 12);
        for item in items {
            let id = item.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
            let summary = item
                .get("summary")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if !valid_id(id) {
                return Err(invalid());
            }
            let status = match status {
                "ok" | "info" => Status::Ok,
                "warn" => Status::Warn,
                "fail" => Status::Fail,
                "skip" => Status::Skipped,
                _ => return Err(invalid()),
            };
            let mut c = Check::new(id, status, safe(summary));
            if let Some(hint) = item.get("hint").and_then(Value::as_str) {
                c = c.with_repair("hint", safe(hint));
            }
            checks.push(c);
        }
        if self.sandbox_required.as_ref().is_some_and(|f| !f()) {
            checks.push(Check::new(
                "tools.sandbox.bypass",
                Status::Warn,
                "NOT SANDBOXED: owner disabled tools.sandbox.required; each process launch is audited.",
            ));
        }
        if let Some(core) = &self.core_checks {
            for c in core() {
                if !checks.iter().any(|x| x.id == c.id) {
                    checks.push(self.safe_check(&c));
                }
            }
        }
        let sandbox = (self.detect_sandbox)(&self.home.join("bin").join("plur1bus-sandbox-limits"));
        let mut sc = Check::new(
            "tools.sandbox",
            if sandbox.available {
                Status::Warn
            } else {
                Status::Fail
            },
            safe(&format!(
                "{} ({}): {}",
                sandbox.backend, sandbox.strength, sandbox.reason
            )),
        );
        if let Some(hint) = &sandbox.hint {
            sc = sc.with_repair("hint", safe(hint));
        }
        checks.push(sc);
        let n = self
            .sandbox_max_tasks
            .as_ref()
            .map_or(DEFAULT_MAX_TASKS, |f| f());
        let tasks = &sandbox.tasks;
        let task_check = if !sandbox.available {
            Check::new(
                "tools.sandbox.tasks",
                Status::Skipped,
                "Process cap not checked: the sandbox is unavailable.",
            )
        } else {
            match tasks.mechanism {
                TaskMechanism::ForkDenied => Check::new(
                    "tools.sandbox.tasks",
                    Status::Ok,
                    "Forks are denied in the tool sandbox (Seatbelt), whatever tools.sandbox.maxTasks says. The coding-gate verifier is not capped on macOS: process limits there count every process of the user.",
                ),
                TaskMechanism::NamespaceLimit => {
                    if n > 0.0 {
                        Check::new(
                            "tools.sandbox.tasks",
                            Status::Ok,
                            format!(
                                "At most {} tasks per sandboxed run (tool sandbox and Linux coding-gate verifier), counted in the run's own user namespace.",
                                num(n)
                            ),
                        )
                    } else {
                        Check::new(
                            "tools.sandbox.tasks",
                            Status::Warn,
                            "Process cap off: the owner set tools.sandbox.maxTasks to 0.",
                        )
                    }
                }
                TaskMechanism::None => {
                    let mut c = Check::new(
                        "tools.sandbox.tasks",
                        Status::Warn,
                        format!("No process cap: {}", tasks.reason),
                    );
                    if let Some(h) = &tasks.hint {
                        c = c.with_repair("hint", h.clone());
                    }
                    c
                }
            }
        };
        checks.push(self.safe_check(&task_check));
        let refusal = (self.external_agent_refusal)();
        let acp_sandbox_available = sandbox.available
            && n.fract() == 0.0
            && n.abs() <= 9_007_199_254_740_991.0
            && n >= 1.0
            && (!self.linux || tasks.mechanism == TaskMechanism::NamespaceLimit);
        let (status, summary) = match &refusal {
            Some(r) => (
                Status::Fail,
                format!(
                    "External ACP agents, terminals and discovery probes: {}{}.",
                    r.reason,
                    r.cause
                        .as_ref()
                        .map_or(String::new(), |c| format!(" ({c})"))
                ),
            ),
            None if acp_sandbox_available => (
                Status::Ok,
                "External ACP process sandbox available; connector acceptance is checked separately."
                    .to_string(),
            ),
            None => (
                Status::Fail,
                "External ACP process sandbox: sandbox-unavailable.".to_string(),
            ),
        };
        checks.push(Check::new("external.agents.sandbox", status, summary));
        let now = (self.clock)();
        let defaults: Vec<ModelRef> = self
            .tool_eval_defaults
            .as_ref()
            .map_or_else(Vec::new, |f| f());
        let gate = self.host_eval.gate(&defaults, &self.home, now);
        let gate_status = if gate.passed {
            Status::Ok
        } else if gate.models.iter().any(|m| m.label == "limited tool use") {
            Status::Fail
        } else {
            Status::Warn
        };
        let gate_summary = if gate.models.is_empty() {
            "Host tool use unknown: no default model inventory/evidence available.".to_string()
        } else {
            gate.models
                .iter()
                .map(|m| format!("{}/{}: {}", m.provider, m.model, m.label))
                .collect::<Vec<_>>()
                .join("; ")
        };
        checks.push(Check::new(
            "tools.tool-eval",
            gate_status,
            safe(&gate_summary),
        ));
        // These categories have no authoritative 1staid check in this revision. Report that explicitly.
        for id in SKIPPED_CATEGORIES {
            let prefix = format!("{id}.");
            if !checks
                .iter()
                .any(|c| c.id == id || c.id.starts_with(&prefix))
            {
                checks.push(Check::new(
                    id,
                    Status::Skipped,
                    "No authoritative provisioning check is available in this installation.",
                ));
            }
        }
        if let Some(composition) = &self.composition_checks {
            for c in composition() {
                if !checks.iter().any(|x| x.id == c.id) {
                    let mut next = Check::new(c.id.clone(), c.status, safe(&c.summary));
                    next.repair = c.repair.clone();
                    checks.push(next);
                }
            }
        }
        let generated_at =
            iso_string(now).ok_or_else(|| RpcErr::new("E_INTERNAL", "invalid time value", None))?;
        Ok(Report {
            generated_at,
            groups: vec![Group {
                id: "provisioning".into(),
                title: "Provisioning".into(),
                checks,
            }],
        })
    }

    /// `currentReport`: a copy of the cached report with the live checks laid over it.
    pub(super) fn current_report(&self, report: &Report) -> Report {
        let mut copy = report.clone();
        let Some(group) = copy.groups.first_mut() else {
            return copy;
        };
        if let Some(core) = &self.core_checks {
            for check in core() {
                let next = self.safe_check(&check);
                match group.checks.iter().position(|c| c.id == check.id) {
                    Some(at) => group.checks[at] = next,
                    None => group.checks.push(next),
                }
            }
        }
        if let Some(cap) = self.capability_status.as_ref().and_then(|f| f()) {
            let status = if cap.source_error {
                Status::Fail
            } else if cap.mode == "fts5-only" {
                Status::Warn
            } else {
                Status::Ok
            };
            let recheck = cap.last_recheck.map_or_else(|| "pending".to_string(), num);
            group.checks.push(Check::new(
                "capabilities.index",
                status,
                format!("Capability index: {}. Last recheck: {recheck}.", cap.mode),
            ));
        }
        if let Some(mining) = self.mining_status.as_ref().and_then(|f| f()) {
            group.checks.push(if mining.available {
                Check::new(
                    "skills.mining",
                    Status::Ok,
                    "Skill mining proposes inactive artifacts for human review.",
                )
            } else {
                Check::new(
                    "skills.mining",
                    Status::Skipped,
                    "Skill mining unavailable: the engine exposes memory corrections but no skill-artifact proposal API.",
                )
            });
        }
        if let Some(u) = self.turn_telemetry.as_ref().and_then(|f| f()) {
            let latency = if u.triage_count > 0 {
                format!(
                    "Triage p50 {} ms, p95 {} ms ({} recent samples).",
                    u.triage_p50_ms.map_or_else(|| "undefined".to_string(), num),
                    u.triage_p95_ms.map_or_else(|| "undefined".to_string(), num),
                    u.triage_count
                )
            } else {
                "Triage p50/p95 unavailable: no samples.".to_string()
            };
            let endings = TURN_END_REASONS
                .iter()
                .zip(u.end_reasons.iter())
                .filter(|(_, c)| **c > 0.0)
                .map(|(r, c)| format!("{r}={}", num(*c)))
                .collect::<Vec<_>>()
                .join(", ");
            let endings = if endings.is_empty() {
                "none".to_string()
            } else {
                endings
            };
            let status = if u.without_needed_tool != 0.0 || u.tool_choice_unsupported != 0.0 {
                Status::Warn
            } else {
                Status::Ok
            };
            group.checks.push(Check::new(
                "tools.turn-usage",
                status,
                format!(
                    "{} turns, {} rounds, {} tool calls; meta search/load/read {}/{}/{}; {} injected, {} loaded skills; {} errors returned; {} forced; {} need detected; {} needed tools unused, {} unsupported; ends {endings}. {latency}",
                    num(u.turns),
                    num(u.rounds),
                    num(u.tool_calls),
                    num(u.meta_calls[0]),
                    num(u.meta_calls[1]),
                    num(u.meta_calls[2]),
                    num(u.skills[0]),
                    num(u.skills[1]),
                    num(u.errors_returned),
                    num(u.forced_turns),
                    num(u.tool_need_turns),
                    num(u.without_needed_tool),
                    num(u.tool_choice_unsupported),
                ),
            ));
        }
        copy
    }
}
