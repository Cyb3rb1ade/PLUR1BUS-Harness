//! Actual A1 registry metadata notes and retry streaks; scripted bodies never receive data authority.
#![cfg(feature = "testkit")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::*,
    jobs::{
        ledger::JobLedger,
        registry::{JobBody, JobContext, JobReport, Registry},
    },
    text::json::write_json,
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
struct Script {
    steps: Vec<Value>,
    next: AtomicUsize,
    queries: Mutex<Vec<Value>>,
}
impl JobBody for Script {
    fn name(&self) -> JobName {
        JobName::KnowledgeUpdate
    }
    fn run(&self, context: &JobContext, _cancel: &Cancel) -> Result<JobReport, EngineError> {
        let step = &self.steps[self.next.fetch_add(1, Ordering::SeqCst)];
        for key in step["keys"].as_array().into_iter().flatten() {
            context.mark_completed_key(key.as_str().unwrap())?;
        }
        for key in step["pending"].as_array().into_iter().flatten() {
            context.note_pending_key(key.as_str().unwrap())?;
        }
        for key in step["abandoned"].as_array().into_iter().flatten() {
            context.note_abandoned_key(key.as_str().unwrap())?;
        }
        if let Some(diary) = step.get("diary") {
            context.note_diary(
                diary["written"].as_bool().unwrap(),
                diary["reason"].as_str(),
            )?;
        }
        if step["diaryDisabled"] == true {
            context.disable_diary()?;
        }
        let mut queries = Vec::new();
        for key in step["queries"].as_array().into_iter().flatten() {
            let key = key.as_str().unwrap();
            queries.push(json!({"key":key,"completed":context.has_completed_key(key)?,"abandoned":context.is_abandoned_key(key)?}));
        }
        self.queries.lock().unwrap().push(json!(queries));
        Ok(match step["outcome"].as_str() {
            Some("failed") => return Err(StoreError::Unavailable.into()),
            Some("skipped") => JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some(step["reason"].as_str().unwrap_or("disabled").into()),
            },
            Some("incomplete") => JobReport {
                outcome: JobOutcome::Incomplete,
                reason: Some("pending".into()),
            },
            _ => JobReport::completed(),
        })
    }
}
#[test]
fn fifteen_actual_node_note_sequences_match_runs_rows_events_and_snapshot_queries() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/job-notes.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let now = golden["now"].as_i64().unwrap();
        let ids = AtomicUsize::new(0);
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = events.clone();
        let registry = Registry::new(root.path(), Arc::new(move || now))
            .unwrap()
            .with_id_factory(Arc::new(move || {
                format!("run-{}", ids.fetch_add(1, Ordering::SeqCst) + 1)
            }))
            .with_events(Arc::new(move |run| {
                observed
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(run).unwrap());
                Ok(())
            }));
        let body = Arc::new(Script {
            steps: case["input"]["steps"].as_array().unwrap().clone(),
            next: AtomicUsize::new(0),
            queries: Mutex::new(Vec::new()),
        });
        registry.bind(body.clone()).unwrap();
        for expected in case["results"].as_array().unwrap() {
            let actual = registry
                .run(
                    JobName::KnowledgeUpdate,
                    &serde_json::from_value(json!("alpha")).unwrap(),
                    serde_json::from_value(json!({})).unwrap(),
                    &Cancel::never(),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::from_str::<Value>(expected.as_str().unwrap()).unwrap(),
                "{}",
                case["input"]["name"]
            );
        }
        let ledger = JobLedger::open(root.path(), "alpha").unwrap();
        let rows: Vec<_> = ledger
            .snapshot(&Cancel::never())
            .unwrap()
            .rows
            .iter()
            .map(write_json)
            .collect();
        let expected: Vec<_> = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(rows, expected, "{}", case["input"]["name"]);
        assert_eq!(json!(*body.queries.lock().unwrap()), case["queries"]);
        let expected: Vec<Value> = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| {
                assert_eq!(event["name"], "job.run");
                serde_json::from_str(event["value"].as_str().unwrap()).unwrap()
            })
            .collect();
        assert_eq!(*events.lock().unwrap(), expected);
        assert!(ledger.orphan_markers(&Cancel::never()).unwrap().is_empty());
    }
}
