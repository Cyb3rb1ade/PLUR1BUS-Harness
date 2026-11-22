use super::*;
use crate::dreams::types::{Breaker, NewRun, SchedulePatch, Trigger};
use crate::toolcall::json::V;
use serde_json::{json, Value};
use std::path::Path;

fn same(actual: impl Serialize, expected: &Value) {
    let value = serde_json::to_value(actual).unwrap();
    assert!(
        V::from_serde(&value).deep_equal(&V::from_serde(expected)),
        "actual {value}\nexpected {expected}",
    );
}

#[test]
fn scheduler_plans_replay_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/dreams/plans.json"
    ))
    .unwrap();
    for case in fixture.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let agent = "agent-fixture";
        let now = case["now"].as_i64().unwrap();
        let settings = serde_json::from_value(case["settings"].clone()).unwrap();
        let phase = serde_json::from_value(case["phase"].clone()).unwrap();
        let store = DreamStore::open(Path::new(":memory:")).unwrap();
        sync_agents(&store, &[agent], &settings, now).unwrap();
        let jobs: Vec<Job> = serde_json::from_value(case["jobs"].clone()).unwrap();
        for _ in 0..case["captures"].as_u64().unwrap() {
            store.record_capture(agent, 5.0, now).unwrap();
        }
        if let Some(until) = case["breakerUntil"].as_i64() {
            store
                .update_schedule(
                    agent,
                    Phase::Rem,
                    SchedulePatch {
                        breaker_state: Some(Breaker::Open),
                        breaker_until: Some(Some(until)),
                        ..SchedulePatch::default()
                    },
                )
                .unwrap();
        }
        if name == "already claimed" {
            let key = plan(&store, agent, phase, now, &jobs)
                .unwrap()
                .idempotency_key;
            store
                .insert_run(&NewRun {
                    run_id: "existing".to_owned(),
                    agent_id: agent.to_owned(),
                    phase,
                    job_id: "fixture".to_owned(),
                    partition: Some("agent-private".to_owned()),
                    idempotency_key: key.clone(),
                    trigger: Trigger::Cron,
                    scheduled_for: None,
                    started_at: now,
                    log_path: None,
                })
                .unwrap();
            assert!(store.claim_key("existing", &key).unwrap());
        }
        let out = plan(&store, agent, phase, now, &jobs).unwrap();
        same(out, &case["result"]);
        let times: Vec<Value> = store
            .schedules(Some(agent))
            .unwrap()
            .into_iter()
            .map(|schedule| {
                json!({"phase":schedule.seed.phase, "nextRunAt":schedule.seed.next_run_at,
                "staggerOffsetS":schedule.seed.stagger_offset_s, "timezone":schedule.seed.timezone})
            })
            .collect();
        same(times, &case["times"]);
    }
}
