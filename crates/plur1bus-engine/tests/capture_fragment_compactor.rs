//! `engine/store/fragment-compactor.js` parity at the Node pin (RE-D161).
//!
//! `fixtures/capture/fragment-compactor.json` was recorded twice by
//! `record-fragment-compactor.mjs` from the SHA-checked pin sources (scripted ports, fixed
//! clock, captured timer); both recordings were byte-identical. The replay drives the native
//! counters and decisions through the same ports and compares every port call, timer, log
//! kind and explicit outcome in order.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "parity fixtures fail immediately"
)]

use plur1bus_engine::contract::Cancel;
use plur1bus_engine::store::fragment_compactor::{
    check, keep_versions_hours, CompactionLog, CompactionSettings, CompactorCore, FragmentTables,
    OptimizePlan, OptimizeResult, Outcome,
};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/capture/fragment-compactor.json")).unwrap()
}

#[test]
fn the_fixture_binds_the_pinned_sources() {
    let source = &fixture()["source"];
    assert_eq!(source["commit"], "9f34008c143c5da87b2194b5a28442b407ff8ba7");
    assert_eq!(
        source["sha256"]["engine/store/fragment-compactor.js"],
        "6a795b75780530732d1ee1d56c198fd96c6c0ef9227cb018c57f4e0fb684e878"
    );
    assert_eq!(
        source["sha256"]["lib/lancedb-optimize.js"],
        "147709b52fb0693be1df9f5fcfc4fa2a92a36158a9430cb5b30b0745eaf8c27e"
    );
}

#[test]
fn settings_resolve_as_at_the_pin() {
    let cases = fixture()["compaction"].as_array().unwrap().clone();
    assert!(cases.len() > 20);
    for case in cases {
        let resolved = CompactionSettings::resolve(&case["input"]);
        let actual = json!({
            "enabled": resolved.enabled,
            "fragmentThreshold": resolved.fragment_threshold,
            "checkEveryWrites": resolved.check_every_writes,
            "checkIntervalMs": resolved.check_interval_ms,
            "timeoutMs": resolved.timeout_ms,
        });
        assert_eq!(actual, case["output"], "input {}", case["input"]);
    }
}

#[test]
fn version_retention_resolves_as_at_the_pin() {
    let cases = fixture()["keepVersionsHours"].as_array().unwrap().clone();
    assert!(cases.len() > 15);
    for case in cases {
        let input = if case["input"] == "__undefined__" {
            Value::Null
        } else {
            case["input"].clone()
        };
        let expected = case["output"].as_f64().unwrap();
        assert_eq!(keep_versions_hours(&input), expected, "input {input}");
    }
}

/// The pin's scripted `fragmentCount`/`optimize` ports, recording every call.
struct Scripted {
    counts: Mutex<VecDeque<Value>>,
    optimizes: Mutex<VecDeque<Value>>,
    events: Mutex<Vec<Value>>,
}

impl FragmentTables for Scripted {
    fn fragment_count(&self, agent: &str, _cancel: &Cancel) -> Option<u64> {
        self.events
            .lock()
            .unwrap()
            .push(json!({"type":"count","agent":agent}));
        // A throw, NaN or a non-number is "unknown" (FC:125-132); so is an empty script.
        self.counts
            .lock()
            .unwrap()
            .pop_front()
            .and_then(|next| next.as_u64())
    }

    fn optimize(&self, agent: &str, plan: &OptimizePlan, _cancel: &Cancel) -> OptimizeResult {
        // `ifBusy: "skip"` and `quietConflicts` are adapter flags; the native table always
        // skips a busy table and never logs conflict retries above debug.
        self.events.lock().unwrap().push(json!({
            "type":"optimize","agent":agent,"cleanupAgoMs":plan.cleanup_ago_ms,
            "timeoutMs":plan.timeout_ms,"maxAttempts":plan.max_attempts,
            "retryDelayMs":plan.retry_delay_ms,"ifBusy":"skip","quietConflicts":true,
        }));
        let next = self
            .optimizes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(json!({"ok":true}));
        let reason = next["reason"].as_str().map(str::to_owned);
        if next == "throw" {
            // A thrown error's message is the reason (FC:161).
            OptimizeResult::Failed(Some("optimize exploded".into()))
        } else if next["ok"] == true {
            OptimizeResult::Compacted
        } else if next["busy"] == true {
            OptimizeResult::Busy
        } else if reason.as_deref() == Some("no-table") {
            OptimizeResult::NoTable
        } else if reason.as_deref() == Some("shutdown") {
            OptimizeResult::Shutdown
        } else if next["conflict"] == true {
            OptimizeResult::Conflict(reason.unwrap_or_default())
        } else {
            OptimizeResult::Failed(reason)
        }
    }
}

fn log_event(log: &CompactionLog) -> Value {
    let (level, kind) = match log {
        CompactionLog::ConflictRetry => ("debug", "conflict-retry".to_owned()),
        CompactionLog::ConflictStreak(streak) => ("warn", format!("conflict-streak-{streak}")),
        CompactionLog::Failed(_) => ("warn", "failed".to_owned()),
    };
    json!({"type":"log","level":level,"kind":kind})
}

/// Node logs name the agent and a hashed reason; compare the level and what was said.
fn normalize(event: &Value) -> Value {
    if event["type"] != "log" {
        return event.clone();
    }
    let message = event["message"].as_str().unwrap();
    let kind = if let Some(rest) = message.split("has lost to concurrent writes ").nth(1) {
        format!("conflict-streak-{}", rest.split(' ').next().unwrap())
    } else if message.contains("lost to concurrent writes, retrying at the next check") {
        "conflict-retry".to_owned()
    } else if message.contains("optimize failed for") {
        "failed".to_owned()
    } else {
        panic!("unexpected log {message}")
    };
    json!({"type":"log","level":event["level"],"kind":kind})
}

fn outcome_event(agent: &str, outcome: &Outcome) -> Value {
    let mut value = json!({"type":"outcome","agentId":agent,"action":outcome.action,
        "fragmentsBefore":outcome.fragments_before,"fragmentsAfter":outcome.fragments_after});
    if let Some(reason) = &outcome.reason {
        value["reason"] = json!(reason);
    }
    value
}

fn replay(scenario: &Value) -> Vec<Value> {
    let tables = Scripted {
        counts: Mutex::new(
            scenario["counts"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .collect(),
        ),
        optimizes: Mutex::new(
            scenario["optimizes"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .collect(),
        ),
        events: Mutex::new(Vec::new()),
    };
    let plan = scenario.get("plan").cloned().unwrap_or(json!({}));
    let settings = CompactionSettings::resolve(&scenario["config"]);
    let core = Mutex::new(CompactorCore::new(settings, keep_versions_hours(&plan)));
    let cancel = Cancel::never();
    let push = |event: Value| tables.events.lock().unwrap().push(event);
    if settings.enabled {
        push(json!({"type":"timer","intervalMs":settings.check_interval_ms}));
    }
    let run = |agent: &str| {
        let (_, log) = check(&core, &tables, agent, &cancel);
        if let Some(log) = log {
            push(log_event(&log));
        }
    };
    for op in scenario["ops"].as_array().unwrap() {
        let agent = op["agent"].as_str().unwrap_or_default();
        match op["op"].as_str().unwrap() {
            "note" => {
                let due = core
                    .lock()
                    .unwrap()
                    .note_writes(agent, op["n"].as_u64().unwrap());
                if due {
                    run(agent);
                }
            }
            "tick" => {
                let agents = core.lock().unwrap().timer_agents();
                for agent in agents {
                    run(&agent);
                }
            }
            "check" => {
                let (outcome, log) = check(&core, &tables, agent, &cancel);
                if let Some(log) = log {
                    push(log_event(&log));
                }
                push(outcome_event(agent, &outcome));
            }
            "close" => {
                core.lock().unwrap().close();
                if settings.enabled {
                    push(json!({"type":"timer-cleared"}));
                }
                push(json!({"type":"closed"}));
            }
            other => panic!("unknown op {other}"),
        }
    }
    tables.events.into_inner().unwrap()
}

#[test]
fn every_scenario_replays_the_pins_calls_logs_and_outcomes() {
    let scenarios = fixture()["scenarios"].as_array().unwrap().clone();
    assert!(scenarios.len() >= 17);
    for scenario in scenarios {
        let expected = scenario["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(normalize)
            .collect::<Vec<_>>();
        assert_eq!(replay(&scenario), expected, "scenario {}", scenario["name"]);
    }
}
