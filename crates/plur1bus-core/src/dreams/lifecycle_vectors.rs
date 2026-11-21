use super::*;
use crate::dreams::scheduler::sync_agents;
use crate::dreams::types::{FinishRun, NewRun, Outcome, RunQuery, SchedulePatch};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

const BASE: i64 = 1_750_000_000_000;
const DAY: i64 = 86_400_000;

struct Time(AtomicI64);
impl Clock for Time {
    fn now(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

fn seed(name: &str, at: i64, trigger: Trigger, scheduled_for: Option<i64>) -> NewRun {
    NewRun {
        run_id: name.into(),
        agent_id: "alpha".into(),
        phase: Phase::Light,
        job_id: "light-dream".into(),
        partition: Some("agent-private".into()),
        idempotency_key: "crashed-window".into(),
        trigger,
        scheduled_for,
        started_at: at,
        log_path: None,
    }
}

fn fail(store: &DreamStore, id: &str, at: i64) {
    store
        .finish_run(
            id,
            &FinishRun {
                outcome: Some(Outcome::Failed),
                reason: Some("fixture".into()),
                finished_at: Some(at),
                ..FinishRun::default()
            },
        )
        .unwrap();
}

fn scenario(name: &str) -> Value {
    let store = DreamStore::open(Path::new(":memory:")).unwrap();
    let settings = Settings {
        timezone: "UTC".into(),
        stagger_window_s: 0,
    };
    let clock = Time(AtomicI64::new(BASE));
    let agents = ["alpha"];
    sync_agents(&store, &agents, &settings, BASE).unwrap();
    if matches!(
        name,
        "startup due" | "disabled due" | "returning agent" | "cron due"
    ) {
        let at = if matches!(name, "startup due" | "disabled due") {
            BASE - 1
        } else {
            BASE + 1000
        };
        store
            .update_schedule(
                "alpha",
                Phase::Light,
                SchedulePatch {
                    next_run_at: Some(Some(at)),
                    enabled: (name == "disabled due").then_some(false),
                    ..SchedulePatch::default()
                },
            )
            .unwrap();
    }
    if name.starts_with("retry") {
        let at = BASE
            - match name {
                "retry too old" => DAY + 1,
                "retry boundary" => DAY,
                _ => 100,
            };
        let trigger = if name == "retry manual" {
            Trigger::Manual
        } else {
            Trigger::Cron
        };
        store
            .insert_run(&seed("crashed", at, trigger, Some(at)))
            .unwrap();
        assert!(store.claim_key("crashed", "crashed-window").unwrap());
        if name == "retry exhausted" {
            store
                .insert_run(&seed("prior", at + 1, Trigger::Catchup, Some(at)))
                .unwrap();
            fail(&store, "prior", at + 2);
        }
    }
    let mut lifecycle = Lifecycle::default();
    if name == "prestart capture" {
        assert!(lifecycle
            .record_capture(&store, &agents, &settings, &clock, "alpha", 150.0)
            .unwrap()
            .is_empty());
    }
    let mut tick = lifecycle
        .start(
            &store,
            if name == "removed agent" {
                &[]
            } else {
                &agents
            },
            &settings,
            &clock,
            None,
        )
        .unwrap();
    if matches!(name, "cron due" | "returning agent") {
        if name == "returning agent" {
            clock.0.store(BASE + 500, Ordering::Relaxed);
            assert!(lifecycle
                .tick(&store, &[], &settings, &clock, None)
                .unwrap()
                .due
                .is_empty());
        }
        clock.0.store(BASE + 1000, Ordering::Relaxed);
        tick = lifecycle
            .tick(&store, &agents, &settings, &clock, None)
            .unwrap();
    }
    if name == "minimum gap" {
        store
            .insert_run(&seed("prior", BASE - 1, Trigger::Manual, None))
            .unwrap();
        fail(&store, "prior", BASE);
    }
    if matches!(
        name,
        "importance threshold" | "below importance threshold" | "minimum gap" | "stopped"
    ) {
        if name == "stopped" {
            lifecycle.stop();
            tick = lifecycle
                .tick(&store, &agents, &settings, &clock, None)
                .unwrap();
        }
        let importance = if name == "below importance threshold" {
            149.0
        } else {
            150.0
        };
        tick.due.extend(
            lifecycle
                .record_capture(&store, &agents, &settings, &clock, "alpha", importance)
                .unwrap(),
        );
    }
    let mut runs = store
        .runs(&RunQuery {
            agent_id: Some("alpha"),
            phase: Some(Phase::Light),
            ..Default::default()
        })
        .unwrap()
        .into_iter()
        .map(|r| {
            json!({"id":r.open.run_id,"trigger":r.open.trigger,"at":r.open.scheduled_for,
            "outcome":r.result.outcome,"reason":r.result.reason,"claimed":r.claimed})
        })
        .collect::<Vec<_>>();
    runs.extend(tick.due.iter().enumerate().map(|(i, d)| {
        assert_eq!(d.agent, "alpha");
        assert_eq!(d.phase, Phase::Light);
        json!({"id":format!("fixture-{}",i+1),"trigger":d.trigger,"at":d.at})
    }));
    runs.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let captures = if name == "importance threshold" {
        None
    } else {
        store
            .schedule("alpha", Phase::Light)
            .unwrap()
            .map(|s| s.captures_acc)
    };
    json!({"runs":runs,"wakeAt":tick.wake_at,"captures":captures})
}

#[test]
fn lifecycle_triggers_and_recovery_match_typescript() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/dreams/lifecycle.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert_eq!(scenario(name), case["expected"], "{name}");
    }
}
