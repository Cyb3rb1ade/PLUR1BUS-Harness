use super::*;
use crate::dreams::scheduler::{plan, sync_agents};
use crate::dreams::types::NewRun;
use crate::rbac::{
    audit::AuditEvent,
    types::{PrincipalKind, Role},
};
use crate::toolcall::json::V;
use serde_json::{json, Value};
use std::path::Path;

struct Fixed;
impl Clock for Fixed {
    fn now(&self) -> i64 {
        1_750_000_000_000
    }
}
impl IdSource for Fixed {
    fn next_id(&self) -> String {
        "fixture-run".to_owned()
    }
}

struct Backend<'a> {
    name: &'a str,
    calls: Vec<Value>,
}
impl DreamJobs for Backend<'_> {
    fn active_agent(&self, agent: &str) -> bool {
        agent == "agent-fixture"
    }
    fn current_person(&self, user_id: &str) -> Option<Principal> {
        (user_id == "tester").then(|| Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new(user_id, Role::Owner)
        })
    }
    fn available(&self) -> Vec<Job> {
        vec![
            Job {
                name: "rem-dream".to_owned(),
                needs_llm: true,
            },
            Job {
                name: "discover-semantic-links".to_owned(),
                needs_llm: false,
            },
        ]
    }
    fn has_model_route(&self, _: &str) -> bool {
        self.name != "missing route"
    }
    fn execute(&mut self, job: &Job, context: &JobContext<'_>) -> R<JobReceipt> {
        self.calls
            .push(json!({"job":job.name, "dueId":context.due_id}));
        let primary = job.name == "rem-dream";
        let (outcome, reason) = match (self.name, primary) {
            ("primary skipped", true) => (JobOutcome::Skipped, Some("no_llm_provider")),
            ("job failed", true) => (JobOutcome::Failed, Some("fixture_failure")),
            ("incomplete", true) => (JobOutcome::Incomplete, Some("fixture_pending")),
            _ => (JobOutcome::Completed, None),
        };
        Ok(JobReceipt {
            outcome,
            reason: reason.map(str::to_owned),
            tokens_in: Some(5),
            tokens_out: if primary { Some(2) } else { None },
            diary_written: if self.name == "diary failed" {
                Some(false)
            } else {
                None
            },
        })
    }
}

#[test]
fn runner_replays_real_scheduler_outcomes() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../fixtures/parity/dreams/runs.json")).unwrap();
    let agent = "agent-fixture";
    let person = Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new("tester", Role::Owner)
    };
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let s = DreamStore::open(Path::new(":memory:")).unwrap();
        let settings = Settings::default();
        sync_agents(&s, &[agent], &settings, Fixed.now()).unwrap();
        for _ in 0..3 {
            s.record_capture(agent, 5.0, Fixed.now()).unwrap();
        }
        let mut jobs = Backend {
            name,
            calls: vec![],
        };
        if name == "idempotent" {
            let key = plan(&s, agent, Phase::Rem, Fixed.now(), &jobs.available())
                .unwrap()
                .idempotency_key;
            s.insert_run(&NewRun {
                run_id: "previous".to_owned(),
                agent_id: agent.to_owned(),
                phase: Phase::Rem,
                job_id: "rem-dream".to_owned(),
                partition: Some("agent-private".to_owned()),
                idempotency_key: key.clone(),
                trigger: Trigger::Cron,
                scheduled_for: None,
                started_at: Fixed.now(),
                log_path: None,
            })
            .unwrap();
            assert!(s.claim_key("previous", &key).unwrap());
        }
        let abort = AbortSignal::new();
        if name == "cancelled" {
            abort.abort();
        }
        let mut audit = |_: &AuditEvent| Ok(());
        let run = run_phase(
            &s,
            &RunRequest {
                who: &person,
                agent,
                phase: Phase::Rem,
                trigger: Trigger::Cron,
                scheduled_for: Some(4000),
                abort: &abort,
            },
            &mut Ports {
                clock: &Fixed,
                ids: &Fixed,
                jobs: &mut jobs,
                audit: &mut audit,
                settings: &settings,
                breaker_sessions: if name == "breaker cap" { 0 } else { 3 },
                require_diary: name == "diary missing",
                native_dues: true,
                candidates: None,
            },
        )
        .unwrap();
        let schedule = s.schedule(agent, Phase::Rem).unwrap().unwrap();
        let actual = json!({
            "outcome":run.result.outcome, "reason":run.result.reason, "counts":run.result.counts,
            "tokensIn":run.result.tokens_in, "tokensOut":run.result.tokens_out, "claimed":run.claimed,
            "capturesAcc":schedule.captures_acc, "breakerState":schedule.breaker_state,
            "calls":jobs.calls,
        });
        assert!(
            V::from_serde(&actual).deep_equal(&V::from_serde(&case["result"])),
            "{name}\nactual {actual}\nexpected {}",
            case["result"]
        );
    }
}
