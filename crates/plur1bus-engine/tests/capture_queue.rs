//! RE-05/T1 Node-recorded scheduler and post-turn queue parity, including timeout settlement.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use plur1bus_engine::capture::logging::{CaptureLogSink, CaptureLogStage, SafeCaptureLog};
use plur1bus_engine::capture::post_turn::{DrainOptions, PostTurnQueue};
use plur1bus_engine::capture::queue::{
    is_background_turn, should_skip_auto_capture, BoundedQueue, CaptureQueue, PressureSnapshot,
    Priority, QueueMeta, RuntimeConfig,
};
use plur1bus_engine::contract::{Cancel, CaptureResult, EngineError};
use plur1bus_engine::text::json::{parse_json, write_json};
use serde::Serialize;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/capture/golden/queue.json")).unwrap()
}

fn captured() -> CaptureResult {
    serde_json::from_value(json!({ "stored": 1, "skipped": 0 })).unwrap()
}

fn queue(config: &Value) -> CaptureQueue {
    CaptureQueue::new(
        RuntimeConfig::from_value(config),
        Arc::new(PressureSnapshot::disabled),
    )
    .unwrap()
}

fn receive<T>(receiver: mpsc::Receiver<T>) -> T {
    let value = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(receiver);
    value
}

#[derive(Default)]
struct RecordedLogs(Mutex<Vec<SafeCaptureLog>>);

impl CaptureLogSink for RecordedLogs {
    fn record(&self, entry: SafeCaptureLog) {
        self.0.lock().unwrap().push(entry);
    }
}

#[test]
fn runtime_capture_config_equals_recorded_node_fields() {
    for entry in fixture()["results"]["config"].as_array().unwrap() {
        let actual = RuntimeConfig::from_value(&entry["input"]);
        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            entry["raw"].as_str().unwrap(),
            "{}",
            entry["name"]
        );
    }
}

#[test]
fn rss_pressure_boundaries_are_byte_identical_to_node() {
    for entry in fixture()["results"]["pressure"].as_array().unwrap() {
        let pressure = PressureSnapshot::measure(
            entry["rss"].as_u64().unwrap(),
            entry["heap"].as_u64().unwrap(),
            3 * 1024 * 1024 * 1024,
            4_831_838_208,
        );
        assert_eq!(
            serde_json::to_string(&pressure).unwrap(),
            entry["raw"].as_str().unwrap()
        );
    }
}

#[test]
fn critical_pressure_sheds_background_and_low_work_but_keeps_explicit_work() {
    let service = CaptureQueue::new(
        RuntimeConfig::default(),
        Arc::new(|| {
            PressureSnapshot::measure(
                5 * 1024 * 1024 * 1024,
                512 * 1024 * 1024,
                3 * 1024 * 1024 * 1024,
                4_831_838_208,
            )
        }),
    )
    .unwrap();
    for entry in fixture()["results"]["pressureAdmission"]
        .as_array()
        .unwrap()
    {
        let priority = entry["meta"]["priority"].as_str().map(Priority::from_name);
        let meta = QueueMeta {
            background: entry["meta"]["background"].as_bool().unwrap_or(false),
            priority,
            ..QueueMeta::default()
        };
        let outcome = receive(service.enqueue("alpha", meta, Box::new(|_| Ok(captured()))));
        assert_eq!(outcome.node_json(), entry["raw"].as_str().unwrap());
    }
    assert_eq!(service.status().skipped, 2);
    assert!(service.close(Duration::from_secs(2)));
}

#[test]
fn a_late_worker_error_never_logs_its_private_error_content() {
    let logs = Arc::new(RecordedLogs::default());
    let service = queue(&json!({ "captureTimeoutMs": 20 })).with_log_sink(logs.clone());
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let private = "private sentence reserved for isolated parity probe";
    let receipt = service.enqueue(
        "alpha",
        QueueMeta::default(),
        Box::new(move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Err(EngineError::Invalid {
                field: "fixture".into(),
                message: private.into(),
            })
        }),
    );
    receive(started_rx);
    assert!(receive(receipt).timed_out);
    release_tx.send(()).unwrap();
    assert!(service.wait_idle(Duration::from_secs(2)));
    let events = logs.0.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].stage, CaptureLogStage::LateCaptureSettlement);
    let encoded = serde_json::to_string(&*events).unwrap();
    assert!(!encoded.contains(private));
    assert!(!encoded.contains("fixture"));
    drop(events);
    assert!(service.close(Duration::from_secs(2)));
}

#[derive(Serialize)]
struct BoundedStep {
    result: plur1bus_engine::capture::queue::PushResult,
    ids: Vec<String>,
    evicted: Vec<String>,
}

#[test]
fn bounded_queue_evicts_only_oldest_low_background_and_keeps_explicit_work() {
    for entry in fixture()["results"]["bounded"].as_array().unwrap() {
        let mut pending = BoundedQueue::new(entry["depth"].as_u64().unwrap() as usize);
        let mut evicted = Vec::new();
        let mut steps = Vec::new();
        for item in entry["items"].as_array().unwrap() {
            let pushed = pending.push(
                item["id"].as_str().unwrap().to_owned(),
                item["background"].as_bool().unwrap(),
                Priority::from_name(item["priority"].as_str().unwrap()),
            );
            if let Some(value) = pushed.evicted {
                evicted.push(value);
            }
            steps.push(BoundedStep {
                result: pushed.result,
                ids: pending.values().cloned().collect(),
                evicted: evicted.clone(),
            });
        }
        assert_eq!(
            serde_json::to_string(&steps).unwrap(),
            entry["raw"].as_str().unwrap()
        );
    }
}

#[test]
fn internal_turn_admission_keeps_node_background_and_command_rules() {
    for entry in fixture()["results"]["admission"].as_array().unwrap() {
        let input = &entry["input"];
        let event = if input["magic"] == true {
            json!({ "prompt": format!("__{}_memory_core_light_sleep__", ["open", "claw"].concat()) })
        } else {
            input["event"].clone()
        };
        #[derive(Serialize)]
        struct Admission {
            background: bool,
            skip: bool,
        }
        let actual = Admission {
            background: is_background_turn(&event, &input["ctx"]),
            skip: should_skip_auto_capture(&event, &input["ctx"]),
        };
        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            entry["raw"].as_str().unwrap(),
            "{}",
            entry["name"]
        );
    }
}

#[test]
fn queued_capture_priorities_and_per_agent_order_match_node() {
    let service = queue(&json!({ "pressureGateEnabled": false }));
    let events = Arc::new(Mutex::new(Vec::new()));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first_events = events.clone();
    let first = service.enqueue(
        "alpha",
        QueueMeta::default(),
        Box::new(move |_| {
            first_events.lock().unwrap().push("active");
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(captured())
        }),
    );
    receive(started_rx);
    let mut receivers = vec![first];
    for (name, priority, background) in [
        ("low", Priority::Low, true),
        ("normal", Priority::Normal, false),
        ("high", Priority::High, false),
    ] {
        let target = events.clone();
        receivers.push(service.enqueue(
            "alpha",
            QueueMeta {
                priority: Some(priority),
                background,
                ..QueueMeta::default()
            },
            Box::new(move |_| {
                target.lock().unwrap().push(name);
                Ok(captured())
            }),
        ));
    }
    release_tx.send(()).unwrap();
    let outcomes: Vec<String> = receivers
        .into_iter()
        .map(|rx| receive(rx).node_json())
        .collect();
    assert!(service.wait_idle(Duration::from_secs(2)));
    assert_eq!(
        *events.lock().unwrap(),
        vec!["active", "high", "normal", "low"]
    );
    assert_eq!(
        outcomes,
        fixture()["results"]["order"]["resultLines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        serde_json::to_string(&service.status()).unwrap(),
        fixture()["results"]["order"]["statusLine"]
            .as_str()
            .unwrap()
    );
    assert!(service.close(Duration::from_secs(2)));
}

#[test]
fn a_timeout_returns_before_settlement_but_retains_the_agent_slot() {
    let service = queue(&json!({ "pressureGateEnabled": false, "captureTimeoutMs": 20 }));
    let events = Arc::new(Mutex::new(Vec::new()));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let target = events.clone();
    let first = service.enqueue(
        "alpha",
        QueueMeta::default(),
        Box::new(move |_| {
            target.lock().unwrap().push("first-start");
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            target.lock().unwrap().push("first-end");
            Ok(captured())
        }),
    );
    receive(started_rx);
    let target = events.clone();
    let second = service.enqueue(
        "alpha",
        QueueMeta::default(),
        Box::new(move |_| {
            target.lock().unwrap().push("second-start");
            Ok(captured())
        }),
    );
    let result = receive(first);
    assert_eq!(
        result.node_json(),
        fixture()["results"]["timeout"]["timeoutResultLine"]
            .as_str()
            .unwrap()
    );
    assert_eq!(
        serde_json::to_string(&service.status()).unwrap(),
        fixture()["results"]["timeout"]["timeoutStateLine"]
            .as_str()
            .unwrap()
    );
    assert_eq!(*events.lock().unwrap(), vec!["first-start"]);
    release_tx.send(()).unwrap();
    assert!(receive(second).ok);
    assert!(service.wait_idle(Duration::from_secs(2)));
    assert_eq!(
        *events.lock().unwrap(),
        vec!["first-start", "first-end", "second-start"]
    );
    assert_eq!(
        serde_json::to_string(&service.status()).unwrap(),
        fixture()["results"]["timeout"]["statusLine"]
            .as_str()
            .unwrap()
    );
    assert!(service.close(Duration::from_secs(2)));
}

#[test]
fn a_pre_aborted_capture_is_not_enqueued() {
    let service = queue(&json!({ "pressureGateEnabled": false }));
    let cancel = Cancel::never();
    cancel.cancel();
    let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = called.clone();
    let result = receive(service.enqueue(
        "alpha",
        QueueMeta {
            cancel,
            ..QueueMeta::default()
        },
        Box::new(move |_| {
            observed.store(true, std::sync::atomic::Ordering::Release);
            Ok(captured())
        }),
    ));
    assert_eq!(
        result.node_json(),
        fixture()["results"]["preAborted"]["raw"].as_str().unwrap()
    );
    assert!(service.close(Duration::from_secs(2)));
    assert!(!called.load(std::sync::atomic::Ordering::Acquire));
}

#[test]
fn a_queued_abort_reaches_the_worker_without_cancelling_another_capture() {
    let service = queue(&json!({ "pressureGateEnabled": false }));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = service.enqueue(
        "alpha",
        QueueMeta::default(),
        Box::new(move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(captured())
        }),
    );
    receive(started_rx);
    let cancel = Cancel::never();
    let queued_cancel = cancel.clone();
    let second = service.enqueue(
        "alpha",
        QueueMeta {
            cancel: queued_cancel,
            ..QueueMeta::default()
        },
        Box::new(move |signal| {
            assert!(signal.is_cancelled());
            Ok(captured())
        }),
    );
    cancel.cancel();
    release_tx.send(()).unwrap();
    assert!(receive(first).ok);
    assert!(receive(second).ok);
    assert!(service.wait_idle(Duration::from_secs(2)));
    assert!(service.close(Duration::from_secs(2)));
}

#[test]
fn different_agents_can_run_before_either_worker_settles() {
    let service = queue(&json!({ "pressureGateEnabled": false }));
    let (started_tx, started_rx) = mpsc::channel();
    let mut releases = Vec::new();
    let mut receipts = Vec::new();
    for agent in ["alpha", "beta"] {
        let (release_tx, release_rx) = mpsc::channel();
        let started = started_tx.clone();
        receipts.push(service.enqueue(
            agent,
            QueueMeta::default(),
            Box::new(move |_| {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(captured())
            }),
        ));
        releases.push(release_tx);
    }
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    for release in releases {
        release.send(()).unwrap();
    }
    for receipt in receipts {
        assert!(receive(receipt).ok);
    }
    assert!(service.close(Duration::from_secs(2)));
}

#[test]
fn configured_same_agent_concurrency_keeps_the_third_job_waiting() {
    let service = queue(&json!({ "maxConcurrentCapturePerAgent": 2 }));
    let (started_tx, started_rx) = mpsc::channel();
    let mut releases = Vec::new();
    let mut receipts = Vec::new();
    for _ in 0..2 {
        let (release_tx, release_rx) = mpsc::channel();
        let started = started_tx.clone();
        receipts.push(service.enqueue(
            "alpha",
            QueueMeta::default(),
            Box::new(move |_| {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(captured())
            }),
        ));
        releases.push(release_tx);
    }
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let third = service.enqueue("alpha", QueueMeta::default(), Box::new(|_| Ok(captured())));
    assert_eq!(
        serde_json::to_string(&service.status()).unwrap(),
        fixture()["results"]["concurrent"]["heldLine"]
            .as_str()
            .unwrap()
    );
    releases.remove(0).send(()).unwrap();
    let first = receive(receipts.remove(0));
    let third = receive(third);
    releases.remove(0).send(()).unwrap();
    let second = receive(receipts.remove(0));
    assert_eq!(
        vec![first.node_json(), second.node_json(), third.node_json()],
        fixture()["results"]["concurrent"]["resultLines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    );
    assert!(service.wait_idle(Duration::from_secs(2)));
    assert_eq!(
        serde_json::to_string(&service.status()).unwrap(),
        fixture()["results"]["concurrent"]["statusLine"]
            .as_str()
            .unwrap()
    );
    assert!(service.close(Duration::from_secs(2)));
}

#[test]
fn post_turn_bytes_retry_fifo_lock_deadline_and_cap_equal_node() {
    let expected: Value =
        serde_json::from_str(fixture()["results"]["postTurn"]["raw"].as_str().unwrap()).unwrap();
    let scratch = physical_tempdir();
    let service = PostTurnQueue::open(scratch.path()).unwrap();
    let first = service.enqueue("alpha", parse_json(r#"{"turns":[{"role":"user","content":"A synthetic public fixture sentence."}],"lightDream":true,"episodes":false}"#).unwrap(), 1_790_000_000_000).unwrap();
    let body = std::fs::read_to_string(
        scratch
            .path()
            .join(".post-turn-queue/alpha")
            .join(&first.file),
    )
    .unwrap();
    assert_eq!(body.replace(&first.id, "<uuid>"), expected["firstEntry"]);
    service
        .enqueue(
            "alpha",
            parse_json(r#"{"turns":[],"lightDream":false,"episodes":true}"#).unwrap(),
            1_790_000_000_001,
        )
        .unwrap();
    for step in expected["failed"].as_array().unwrap() {
        let result = service
            .drain("alpha", |_| Ok(false), DrainOptions::default(), || 0)
            .unwrap();
        assert_eq!(result.node_json(), step["resultLine"].as_str().unwrap());
        let body = std::fs::read_to_string(
            scratch
                .path()
                .join(".post-turn-queue/alpha")
                .join(&first.file),
        )
        .unwrap();
        assert_eq!(body.replace(&first.id, "<uuid>"), step["contents"]);
    }
    let mut seen = 0;
    let result = service
        .drain(
            "alpha",
            |_| {
                seen += 1;
                Ok(seen != 1)
            },
            DrainOptions::default(),
            || 0,
        )
        .unwrap();
    assert_eq!(
        result.node_json(),
        fixture()["results"]["postTurn"]["droppedThenProcessedLine"]
            .as_str()
            .unwrap()
    );
    let reserved = service
        .enqueue(
            "beta",
            parse_json(
                r#"{"attempts":99,"id":"old","agentId":"old","enqueuedAt":-1,"extra":true}"#,
            )
            .unwrap(),
            1_790_000_000_002,
        )
        .unwrap();
    let body = std::fs::read_to_string(
        scratch
            .path()
            .join(".post-turn-queue/beta")
            .join(&reserved.file),
    )
    .unwrap();
    assert_eq!(
        body.replace(&reserved.id, "<uuid>"),
        expected["reservedEntry"]
    );
    let lock = plur1bus_engine::store::lock::JobLock::acquire(
        &scratch.path().join(".post-turn-queue/beta"),
        ".drain",
        Duration::from_secs(900),
    )
    .unwrap();
    let locked = service
        .drain("beta", |_| Ok(true), DrainOptions::default(), || 0)
        .unwrap();
    assert_eq!(
        locked.node_json(),
        fixture()["results"]["postTurn"]["lockedLine"]
            .as_str()
            .unwrap()
    );
    drop(lock);
    let mut clock_calls = 0;
    let deadline = service
        .drain(
            "beta",
            |_| Ok(true),
            DrainOptions {
                budget_ms: 1,
                ..DrainOptions::default()
            },
            || {
                clock_calls += 1;
                if clock_calls == 1 {
                    0
                } else {
                    2
                }
            },
        )
        .unwrap();
    assert_eq!(
        deadline.node_json(),
        fixture()["results"]["postTurn"]["deadlineLine"]
            .as_str()
            .unwrap()
    );
    let mut dropped = 0;
    for sequence in 0..202 {
        dropped += service
            .enqueue(
                "cap",
                parse_json(&format!(r#"{{"turns":[],"sequence":{sequence}}}"#)).unwrap(),
                1_790_000_000_000 + sequence,
            )
            .unwrap()
            .dropped;
    }
    assert_eq!(
        json!({ "dropped": dropped, "count": service.count("cap") }),
        expected["cap"]
    );
}

#[test]
fn a_post_turn_failure_preserves_its_entry_and_does_not_panic_on_invalid_json() {
    let scratch = physical_tempdir();
    let logs = Arc::new(RecordedLogs::default());
    let service = PostTurnQueue::open(scratch.path())
        .unwrap()
        .with_log_sink(logs.clone());
    let entry = service
        .enqueue(
            "alpha",
            parse_json(r#"{"turns":[]}"#).unwrap(),
            1_790_000_000_000,
        )
        .unwrap();
    let result = service
        .drain(
            "alpha",
            |_| {
                Err(EngineError::Invalid {
                    field: "fixture".into(),
                    message: "private content must remain absent from logs".into(),
                })
            },
            DrainOptions::default(),
            || 0,
        )
        .unwrap();
    assert_eq!(result.failed, 1);
    let path = scratch
        .path()
        .join(".post-turn-queue/alpha")
        .join(entry.file);
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(write_json(&parse_json(&body).unwrap()).contains("\"attempts\":1"));
    std::fs::write(&path, "{").unwrap();
    let dropped = service
        .drain("alpha", |_| Ok(true), DrainOptions::default(), || 0)
        .unwrap();
    assert_eq!(dropped.dropped, 1);
    assert_eq!(dropped.remaining, 0);
    let encoded = serde_json::to_string(&*logs.0.lock().unwrap()).unwrap();
    assert!(!encoded.contains("private content must remain absent from logs"));
    assert!(!encoded.contains("fixture"));
}

#[test]
fn post_turn_json_keeps_node_numbers_numeric_key_order_and_lone_surrogates() {
    let scratch = physical_tempdir();
    let service = PostTurnQueue::open(scratch.path()).unwrap();
    for entry in fixture()["results"]["postTurn"]["payloadCases"]
        .as_array()
        .unwrap()
    {
        let queued = service
            .enqueue(
                "codec",
                parse_json(entry["input"].as_str().unwrap()).unwrap(),
                entry["now"].as_i64().unwrap(),
            )
            .unwrap();
        let raw = std::fs::read_to_string(
            scratch
                .path()
                .join(".post-turn-queue/codec")
                .join(&queued.file),
        )
        .unwrap();
        assert_eq!(
            raw.replace(&queued.id, "<uuid>"),
            entry["raw"].as_str().unwrap()
        );
    }
}

// Production rejects symlinks; use the physical system temporary root on macOS too.
fn physical_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
