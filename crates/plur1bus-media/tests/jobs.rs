#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture checks")]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use plur1bus_media::{
    jobs::{AdapterCall, Error, Host, Job, Progress, Result, Runner, Update},
    units::Units,
};
use serde_json::{json, Value};

struct Fixture {
    name: String,
    current: Mutex<Job>,
    events: Mutex<Vec<Value>>,
    published: Mutex<Option<Value>>,
    fail_settlement: AtomicBool,
}

fn units(value: Option<Units>) -> Value {
    match value {
        Some(Units::Images(quantity)) => json!({"unit":"image","quantity":quantity}),
        Some(Units::VideoSeconds(quantity)) => json!({"unit":"videoSecond","quantity":quantity}),
        None => Value::Null,
    }
}

fn project(job: &Job) -> Value {
    let mut object = serde_json::to_value(job).unwrap();
    let fraction = job.progress.fraction;
    if fraction == 0. || fraction == 1. {
        object["progress"]["fraction"] = json!(u8::from(fraction == 1.));
    }
    for key in [
        "id",
        "adapter",
        "operation",
        "request",
        "createdAt",
        "updatedAt",
    ] {
        object.as_object_mut().unwrap().remove(key);
    }
    object
}

impl Fixture {
    fn record(&self, line: Value) {
        self.events.lock().unwrap().push(line);
    }
}

impl Host for Fixture {
    type Output = ();

    fn now_ms(&self) -> i64 {
        900
    }
    fn job_id(&self) -> String {
        "generated-job".into()
    }
    fn supports(&self, _adapter: &str) -> bool {
        true
    }
    fn supports_resume(&self, _adapter: &str) -> bool {
        true
    }
    fn load(&self, _id: &str) -> Result<Option<Job>> {
        self.record(json!(["get"]));
        Ok(Some(self.current.lock().unwrap().clone()))
    }
    fn save(&self, job: &Job) -> Result<()> {
        self.record(json!(["put", project(job)]));
        *self.current.lock().unwrap() = job.clone();
        Ok(())
    }
    fn list(&self) -> Result<Vec<Job>> {
        Ok(vec![self.current.lock().unwrap().clone()])
    }
    fn claim(&self, _id: &str) -> Result<()> {
        self.record(json!(["claim"]));
        Ok(())
    }
    fn release(&self, _id: &str) -> Result<()> {
        self.record(json!(["release"]));
        Ok(())
    }
    fn find_output(&self, _id: &str) -> Result<Option<Value>> {
        self.record(json!(["lookup-output"]));
        Ok(self
            .published
            .lock()
            .unwrap()
            .clone()
            .or_else(|| (self.name == "existing-output").then(manifest)))
    }
    fn publish(&self, _id: &str, _request: &Value, (): ()) -> Result<Value> {
        self.record(json!(["publish"]));
        let output = manifest();
        *self.published.lock().unwrap() = Some(output.clone());
        Ok(output)
    }
    fn reserve(&self, _id: &str, requested: Units) -> Result<()> {
        self.record(json!(["reserve", units(Some(requested))]));
        Ok(())
    }
    fn settle(&self, _id: &str, delivered: Option<Units>) -> Result<()> {
        self.record(json!(["settle", units(delivered)]));
        if self.fail_settlement.swap(false, Ordering::AcqRel) {
            return Err(Error::Storage);
        }
        Ok(())
    }
    fn produce(
        &self,
        call: AdapterCall<'_>,
        update: &mut dyn FnMut(Update) -> Result<()>,
    ) -> Result<()> {
        self.record(json!(["adapter", call.operation, call.checkpoint]));
        if self.name == "provider-failure" {
            return Err(Error::BackendUnavailable);
        }
        update(Update::Checkpoint(
            serde_json::from_value(json!({
                "id":"fixture-provider-job","model":"fixture-model"
            }))
            .unwrap(),
        ))?;
        update(Update::Progress(if self.name == "invalid-progress" {
            Progress {
                fraction: 1.1,
                stage: None,
            }
        } else {
            serde_json::from_value(json!({"fraction":0.5,"stage":"downloading"})).unwrap()
        }))
    }
}

fn manifest() -> Value {
    json!({"files":[{"path":"0.png","format":"png","bytes":3}]})
}

#[test]
fn run_cancel_recovery_and_budget_match_typescript_port_calls() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/job-runner.json"
    ))
    .unwrap();
    for vector in vectors["cases"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap().to_owned();
        let input: Job = serde_json::from_value(vector["input"].clone()).unwrap();
        let id = input.id.clone();
        let fixture = Fixture {
            name,
            current: Mutex::new(input),
            events: Mutex::default(),
            published: Mutex::default(),
            fail_settlement: AtomicBool::new(false),
        };
        let runner = Runner::new(&fixture);
        if fixture.name == "queued-cancel" {
            runner.cancel(&id).unwrap();
        } else {
            runner
                .run(&id, &|| {
                    (fixture.name == "pre-aborted").then_some(Error::Cancelled)
                })
                .unwrap();
        }
        assert_eq!(
            project(&fixture.current.lock().unwrap()),
            vector["expected"],
            "{}",
            fixture.name
        );
        assert_eq!(
            json!(*fixture.events.lock().unwrap()),
            vector["events"],
            "{}",
            fixture.name
        );
    }
}

#[test]
fn a_published_output_survives_settlement_failure_without_resubmitting() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/job-runner.json"
    ))
    .unwrap();
    let input: Job = serde_json::from_value(vectors["cases"][0]["input"].clone()).unwrap();
    let id = input.id.clone();
    let fixture = Fixture {
        name: "settlement-failure".into(),
        current: Mutex::new(input),
        events: Mutex::default(),
        published: Mutex::default(),
        fail_settlement: AtomicBool::new(true),
    };
    let runner = Runner::new(&fixture);
    assert_eq!(runner.run(&id, &|| None), Err(Error::Storage));
    assert!(fixture.published.lock().unwrap().is_some());
    assert_eq!(
        fixture.current.lock().unwrap().state,
        plur1bus_media::jobs::State::Running
    );
    runner.recover(&|| None).unwrap();
    let events = fixture.events.lock().unwrap();
    assert_eq!(
        events.iter().filter(|event| event[0] == "adapter").count(),
        1
    );
    assert_eq!(
        events.iter().filter(|event| event[0] == "publish").count(),
        1
    );
    assert_eq!(
        events.iter().filter(|event| event[0] == "settle").count(),
        2
    );
    assert_eq!(
        fixture.current.lock().unwrap().state,
        plur1bus_media::jobs::State::Succeeded
    );
}
