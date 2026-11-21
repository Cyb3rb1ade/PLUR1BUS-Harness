use super::*;
use crate::budget::{Clock, IdSource};
use crate::collab::CollabErrorCode as C;
use crate::dreams::runner::{
    run_phase, DreamJobs, JobContext, JobOutcome, JobReceipt, Ports, RunRequest,
};
use crate::dreams::scheduler::{sync_agents, Job, Settings};
use crate::dreams::store::DreamStore;
use crate::dreams::types::{Phase, Trigger};
use crate::rbac::audit::AuditEvent;
use crate::rbac::types::{Principal, PrincipalKind, Role};
use crate::toolcall::json::V;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

const NOW: i64 = 1_750_000_000_000;

struct Time;
impl Clock for Time {
    fn now(&self) -> i64 {
        NOW
    }
}

struct Ids(AtomicUsize);
impl IdSource for Ids {
    fn next_id(&self) -> String {
        format!("fixture-{}", self.0.fetch_add(1, Ordering::Relaxed))
    }
}

fn principal() -> Principal {
    Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new("owner", Role::Owner)
    }
}

struct Jobs<'a>(&'a str);
impl DreamJobs for Jobs<'_> {
    fn active_agent(&self, agent: &str) -> bool {
        agent == "alpha"
    }
    fn current_person(&self, user: &str) -> Option<Principal> {
        (user == "owner").then(principal)
    }
    fn available(&self) -> Vec<Job> {
        let name = if self.0 == "light only" {
            "light-dream"
        } else {
            "consolidate-daily"
        };
        vec![Job {
            name: name.into(),
            needs_llm: false,
        }]
    }
    fn has_model_route(&self, _: &str) -> bool {
        true
    }
    fn execute(&mut self, _: &Job, _: &JobContext<'_>) -> R<JobReceipt> {
        Ok(JobReceipt {
            outcome: JobOutcome::Completed,
            reason: None,
            tokens_in: None,
            tokens_out: None,
            diary_written: (self.0 == "bad diary").then_some(false),
        })
    }
}

struct Source<'a> {
    name: &'a str,
    input: Option<CandidateInput>,
    calls: Vec<Vec<String>>,
}
impl CandidateSource for Source<'_> {
    fn pull(&mut self, agent: &str, _: &AbortSignal) -> R<CandidateBatch> {
        if self.name == "unavailable source" {
            return Err(CollabError::new(C::Storage, "fixture"));
        }
        Ok(CandidateBatch {
            agent_id: agent.into(),
            items: self.input.take().into_iter().collect(),
        })
    }
    fn can_promote(&self) -> bool {
        self.name != "missing capability"
    }
    fn promote(&mut self, agent: &str, ids: &[&str], _: &AbortSignal) -> R<PromotionReceipt> {
        self.calls
            .push(ids.iter().map(|s| (*s).to_owned()).collect());
        let id = if self.name == "wrong id" {
            "memory-2"
        } else {
            "memory-1"
        };
        let (outcome, reason) = match self.name {
            "bad reason" => (ReceiptOutcome::Promoted, "not-integrated"),
            "already promoted" => (ReceiptOutcome::Skipped, "already-promoted"),
            "not confirmed" => (ReceiptOutcome::Skipped, "not-found"),
            _ => (ReceiptOutcome::Promoted, "integrated"),
        };
        let item = ReceiptItem {
            id: id.into(),
            outcome,
            reason: reason.into(),
        };
        Ok(PromotionReceipt {
            agent_id: if self.name == "wrong agent" {
                "other"
            } else {
                agent
            }
            .into(),
            items: match self.name {
                "empty receipt" => vec![],
                "duplicate receipt" => vec![item.clone(), item],
                _ => vec![item],
            },
        })
    }
}

#[test]
fn scoped_candidate_promotion_replays_typescript() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/dreams/promotions.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut source = Source {
            name,
            input: Some(serde_json::from_value(case["input"].clone()).unwrap()),
            calls: vec![],
        };
        let store = DreamStore::open(Path::new(":memory:")).unwrap();
        let settings = Settings::default();
        sync_agents(&store, &["alpha"], &settings, NOW).unwrap();
        for _ in 0..3 {
            store.record_capture("alpha", 5.0, NOW).unwrap();
        }
        let mut jobs = Jobs(name);
        let mut audit = |_: &AuditEvent| Ok(());
        let run = run_phase(
            &store,
            &RunRequest {
                who: &principal(),
                agent: "alpha",
                phase: if name == "light only" {
                    Phase::Light
                } else {
                    Phase::Deep
                },
                trigger: Trigger::Manual,
                scheduled_for: None,
                abort: &AbortSignal::new(),
            },
            &mut Ports {
                clock: &Time,
                ids: &Ids(AtomicUsize::new(0)),
                jobs: &mut jobs,
                audit: &mut audit,
                settings: &settings,
                breaker_sessions: 3,
                require_diary: false,
                native_dues: false,
                candidates: Some(&mut source),
            },
        )
        .unwrap();
        let states=store.candidates("alpha",None).unwrap().into_iter().map(|row|
            json!({"state":row.state,"partition":row.seed.partition,"hash":row.seed.content_hash,"decision":row.decision})).collect::<Vec<_>>();
        let actual = json!({"outcome":run.result.outcome,"reason":run.result.reason,"counts":run.result.counts,"calls":source.calls,"states":states});
        assert!(
            V::from_serde(&actual).deep_equal(&V::from_serde(&case["expected"])),
            "{name}\nactual {actual}\nexpected {}",
            case["expected"]
        );
    }
}
