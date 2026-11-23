#![allow(clippy::unwrap_used, reason = "private helper fixture assertions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_media::{
    adapters::{ImageRequest, Observer},
    coreml::{Config, CoreMl, Environment, Launch, Protocol, Session, Workspace},
    jobs::{Checkpoint, Progress, Result},
};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
    time::{Duration, Instant},
};

type Events = Rc<RefCell<VecDeque<Value>>>;

struct Fake {
    events: Events,
    data: Vec<u8>,
    legacy: bool,
    cancelled: Rc<Cell<bool>>,
    launches: Cell<usize>,
}

struct Pipe(Events, bool);

impl Session for Pipe {
    fn send(&mut self, line: &[u8], _: Instant) -> Result<()> {
        let expected = self.0.borrow_mut().pop_front().unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(
            &line[..line.len() - 1],
            expected["send"].as_str().unwrap().as_bytes()
        );
        Ok(())
    }
    fn receive(&mut self, _: usize, _: Instant) -> Result<Option<Vec<u8>>> {
        if self.1
            && self
                .0
                .borrow()
                .front()
                .is_some_and(|event| event.get("send").is_some())
        {
            return Ok(None);
        }
        let frame = self.0.borrow_mut().pop_front();
        Ok(frame.map(|event| event["receive"].as_str().unwrap().as_bytes().to_vec()))
    }
    fn close_input(&mut self, _: Instant) -> Result<()> {
        Ok(())
    }
    fn finish(self, _: Instant) -> Result<bool> {
        Ok(true)
    }
    fn stop(self, _: Instant) {}
}

impl Environment for Fake {
    type Session = Pipe;
    type Workspace = Work;

    fn apple_silicon(&self) -> bool {
        true
    }
    fn probe(&self, _: usize, _: Instant) -> Result<Option<Vec<u8>>> {
        if self.legacy {
            return Ok(None);
        }
        let event = self.events.borrow_mut().pop_front().unwrap();
        Ok(Some(event["receive"].as_str().unwrap().as_bytes().to_vec()))
    }
    fn launch(&self, launch: Launch, _: Instant) -> Result<Self::Session> {
        assert_eq!(matches!(launch, Launch::OneShot), self.legacy);
        self.launches.set(self.launches.get() + 1);
        Ok(Pipe(self.events.clone(), self.legacy))
    }
    fn workspace(&self, _: Instant) -> Result<Self::Workspace> {
        Ok(Work(self.data.clone()))
    }
    fn cancelled(&self) -> bool {
        self.cancelled.get()
    }
}

struct Work(Vec<u8>);

impl Workspace for Work {
    fn path(&self) -> &str {
        "/fixture/output"
    }
    fn write_private(&mut self, name: &str, bytes: &[u8], _: Instant) -> Result<String> {
        assert_eq!(name, "input.png");
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(!bytes.windows(4).any(|part| part == b"eXIf"));
        Ok(format!("/fixture/output/{name}"))
    }
    fn read_regular(&self, name: &str, limit: usize, _: Instant) -> Result<Vec<u8>> {
        assert_eq!(name, "0.png");
        assert!(self.0.len() <= limit);
        Ok(self.0.clone())
    }
}

struct Progresses(Vec<f64>, Option<Rc<Cell<bool>>>);

impl Observer for Progresses {
    fn progress(&mut self, event: Progress) -> Result<()> {
        self.0.push(event.fraction);
        if let Some(cancelled) = &self.1 {
            cancelled.set(true);
        }
        Ok(())
    }
    fn checkpoint(&mut self, _: Checkpoint) -> Result<()> {
        Ok(())
    }
}

#[test]
fn coreml_replays_exact_legacy_and_jsonl_messages_including_cancel() {
    let recording: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/media/coreml-wire.json"
    ))
    .unwrap();
    let input = &recording["input"];
    let source = STANDARD
        .decode(input["reference"].as_str().unwrap())
        .unwrap();
    for mode in ["normal", "legacy", "hold"] {
        let scenario = &recording["scenarios"][mode];
        let expected = &scenario["outcome"];
        let host = Fake {
            events: Rc::new(RefCell::new(
                scenario["events"].as_array().unwrap().clone().into(),
            )),
            data: STANDARD.decode(input["png"].as_str().unwrap()).unwrap(),
            legacy: mode == "legacy",
            cancelled: Rc::new(Cell::new(false)),
            launches: Cell::new(0),
        };
        let mut adapter = CoreMl::new(
            &host,
            Config {
                model: input["model"].as_str().unwrap(),
                models_dir: "/fixture/models",
                protocol: Protocol::Auto,
                compute_units: Some("cpuAndGPU"),
                scheduler: Some("dpmpp"),
                strength: 0.5,
                cancel_grace: Duration::from_secs(1),
            },
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut events = Progresses(vec![], (mode == "hold").then(|| host.cancelled.clone()));
        let output = adapter.generate(
            &ImageRequest {
                parameters: &input["parameters"],
                references: &[],
                mask: None,
            },
            &mut events,
            deadline,
        );
        assert_eq!(json!(events.0), scenario["progress"], "{mode}");
        if mode == "hold" {
            assert_eq!(json!(output.err().unwrap().code), *expected, "{mode}");
        } else {
            let output = output.unwrap();
            let encoded: Vec<_> = output
                .files
                .iter()
                .map(|file| STANDARD.encode(&file.bytes))
                .collect();
            assert_eq!(json!(encoded), expected["generated"]);
            assert_eq!(output.metadata["seed"], expected["seed"]);
            assert_eq!(json!(output.partial), expected["partial"]);
            if mode == "normal" {
                let edited = adapter
                    .edit(
                        &ImageRequest {
                            parameters: &json!({"prompt":"Snow"}),
                            references: &[&source],
                            mask: None,
                        },
                        &mut Progresses(vec![], None),
                        deadline,
                    )
                    .unwrap();
                let encoded: Vec<_> = edited
                    .files
                    .iter()
                    .map(|file| STANDARD.encode(&file.bytes))
                    .collect();
                assert_eq!(json!(encoded), expected["edited"]);
            }
            assert_eq!(json!(adapter.models(deadline).unwrap()), expected["models"]);
        }
        assert!(host.events.borrow().is_empty(), "{mode}");
        assert_eq!(
            host.launches.get(),
            if mode == "legacy" { 2 } else { 1 },
            "{mode}"
        );
    }
}
