//! Byte comparisons against Node's replay guard, including persisted state and UTF-16 keys.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use plur1bus_engine::capture::replay_guard::{
    turn_key_material, ReplayGuard, REPLAY_GUARD_MAX_ENTRIES, REPLAY_GUARD_TTL_MS,
};
use plur1bus_engine::contract::{Cancel, CaptureResult, EngineError};
use plur1bus_engine::text::js::JsString;
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let file = format!(
        "{}/tests/fixtures/capture/golden/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

fn js(value: &Value) -> JsString {
    JsString::from_utf16_units(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
            .collect(),
    )
}

fn result() -> CaptureResult {
    serde_json::from_value(json!({"stored":1,"skipped":0})).unwrap()
}

fn raw_result(value: &CaptureResult) -> String {
    let mut text = format!(
        "{{\"stored\":{},\"skipped\":{}",
        value.stored, value.skipped
    );
    if let Some(reason) = &value.reason {
        text.push_str(&format!(
            ",\"reason\":{}",
            serde_json::to_string(reason).unwrap()
        ));
    }
    text.push('}');
    text
}

#[test]
fn ten_keys_and_raw_utf16_material_equal_pinned_node() {
    for row in fixture("replay-keys.json")["keys"].as_array().unwrap() {
        let agent = js(&row["agent"]);
        let run = (!row["run"].is_null()).then(|| js(&row["run"]));
        let session = (!row["session"].is_null()).then(|| js(&row["session"]));
        let messages: Vec<_> = row["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| (js(&message[0]), js(&message[1])))
            .collect();
        let (material, key) = turn_key_material(&agent, run.as_ref(), session.as_ref(), &messages);
        assert_eq!(
            material,
            row["material"].as_str().unwrap(),
            "{}",
            row["name"]
        );
        assert_eq!(
            material.encode_utf16().collect::<Vec<_>>(),
            row["materialUtf16"]
                .as_array()
                .unwrap()
                .iter()
                .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(key, row["hash"].as_str().unwrap());
    }
}

#[test]
fn persisted_replay_states_are_raw_node_bytes_including_ttl_cap_pending_and_uri_agents() {
    let golden = fixture("replay-guard.json");
    assert_eq!(
        REPLAY_GUARD_TTL_MS,
        golden["constants"]["ttlMs"].as_i64().unwrap()
    );
    assert_eq!(
        REPLAY_GUARD_MAX_ENTRIES,
        golden["constants"]["maxEntries"].as_u64().unwrap() as usize
    );
    for scenario in golden["scenarios"].as_array().unwrap() {
        let directory = physical_tempdir();
        let agent = scenario["agent"].as_str().unwrap();
        let path = directory.path().join("Agent.alpha%3A_-0.json");
        if let Some(seed) = scenario["seed"].as_str() {
            fs::write(&path, seed).unwrap();
        }
        let now = Arc::new(AtomicI64::new(1000));
        let clock = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let mut guard = ReplayGuard::new(directory.path().to_owned(), clock.clone());
        for step in scenario["steps"].as_array().unwrap() {
            if step["kind"] == "reopen" {
                guard = ReplayGuard::new(directory.path().to_owned(), clock.clone());
                continue;
            }
            now.store(step["at"].as_i64().unwrap(), Ordering::SeqCst);
            let mut called = false;
            let mut stale = None;
            let value = guard
                .run(
                    agent,
                    step["key"].as_str().unwrap(),
                    &Cancel::never(),
                    |rows| {
                        called = true;
                        stale = Some(rows.stale_row_ids().to_vec());
                        for action in step["actions"].as_array().unwrap() {
                            match action["kind"].as_str().unwrap() {
                                "planned" => {
                                    let ids = if let Some(ids) = action["ids"].as_array() {
                                        ids.iter()
                                            .map(|id| id.as_str().unwrap().to_owned())
                                            .collect()
                                    } else {
                                        let mut ids =
                                            vec![
                                                action["repeated"].as_str().unwrap().to_owned();
                                                action["count"].as_u64().unwrap() as usize
                                            ];
                                        ids.extend(
                                            action["tail"]
                                                .as_array()
                                                .unwrap()
                                                .iter()
                                                .map(|id| id.as_str().unwrap().to_owned()),
                                        );
                                        ids
                                    };
                                    rows.on_rows_planned(&ids).unwrap();
                                }
                                "settled" => rows.on_rows_settled().unwrap(),
                                "kept" => rows.on_rows_kept().unwrap(),
                                other => panic!("unrecognized recorded action: {other}"),
                            }
                        }
                        Ok(serde_json::from_value(step["result"].clone()).unwrap())
                    },
                )
                .unwrap();
            assert_eq!(
                called,
                step["called"].as_bool().unwrap(),
                "{}",
                scenario["name"]
            );
            assert_eq!(serde_json::to_value(stale).unwrap(), step["stale"]);
            assert_eq!(raw_result(&value), step["rawResult"].as_str().unwrap());
            assert_eq!(
                fs::read_to_string(&path).ok(),
                step["raw"].as_str().map(str::to_owned),
                "raw persisted state: {}",
                scenario["name"]
            );
            assert_eq!(
                guard.warning_count(),
                step["warnings"].as_u64().unwrap() as usize
            );
        }
    }
}

#[test]
fn an_identical_waiters_abort_does_not_cancel_the_leader() {
    let expected = fixture("replay-guard.json")["concurrency"].clone();
    let root = physical_tempdir();
    let guard = ReplayGuard::new(root.path().to_owned(), Arc::new(|| 1000));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let leader_guard = guard.clone();
    let leader = std::thread::spawn(move || {
        leader_guard.run("fixture", "flight", &Cancel::never(), |_| {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(result())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    let mut follower_called = false;
    let follower = guard
        .run("fixture", "flight", &cancel, |_| {
            follower_called = true;
            Ok(result())
        })
        .unwrap();
    release_tx.send(()).unwrap();
    let completed = leader.join().unwrap().unwrap();
    assert_eq!(
        follower_called,
        expected["followerCalled"].as_bool().unwrap()
    );
    assert_eq!(
        raw_result(&follower),
        expected["cancelled"].as_str().unwrap()
    );
    assert_eq!(
        raw_result(&completed),
        expected["completed"].as_str().unwrap()
    );
    assert_eq!(
        raw_result(
            &guard
                .run("fixture", "flight", &cancel, |_| panic!("duplicate ran"))
                .unwrap()
        ),
        expected["duplicate"].as_str().unwrap()
    );
    assert_eq!(
        raw_result(
            &guard
                .run("fixture", "new-flight", &cancel, |_| Ok(result()))
                .unwrap()
        ),
        expected["alreadyAborted"].as_str().unwrap()
    );
}

#[test]
fn a_failed_leader_releases_waiters_and_late_callbacks_survive_run_return() {
    let golden = fixture("replay-guard.json")["concurrency"].clone();
    let root = physical_tempdir();
    let guard = ReplayGuard::new(root.path().to_owned(), Arc::new(|| 1000));
    let mut late = None;
    let failure = guard
        .run("fixture", "late", &Cancel::never(), |rows| {
            late = Some(rows);
            Ok(serde_json::from_value(json!({"stored":0,"skipped":1,"reason":"timeout"})).unwrap())
        })
        .unwrap();
    assert_eq!(failure.reason.as_deref(), Some("timeout"));
    assert_eq!(raw_result(&failure), golden["beforeLate"].as_str().unwrap());
    late.unwrap().on_rows_settled().unwrap();
    assert_eq!(
        guard
            .run("fixture", "late", &Cancel::never(), |_| panic!(
                "late settlement lost"
            ))
            .unwrap()
            .reason
            .as_deref(),
        Some("duplicate-turn")
    );
    let failed: Result<CaptureResult, EngineError> =
        guard.run("fixture", "error", &Cancel::never(), |_| {
            Err(EngineError::NotAvailable {
                reason: "fixture".to_owned(),
            })
        });
    assert!(failed.is_err());
    assert_eq!(
        guard
            .run("fixture", "error", &Cancel::never(), |_| Ok(result()))
            .unwrap()
            .stored,
        serde_json::Number::from(1)
    );
}

#[test]
fn failed_state_writes_keep_this_process_guarded_without_blocking_capture() {
    let expected = fixture("replay-guard.json")["concurrency"]["writeFailure"].clone();
    let directory = physical_tempdir();
    let root = directory.path().join("root-is-file");
    fs::write(&root, "fixture").unwrap();
    let guard = ReplayGuard::new(root, Arc::new(|| 1000));
    let first = guard
        .run("fixture", "same", &Cancel::never(), |_| Ok(result()))
        .unwrap();
    let duplicate = guard
        .run("fixture", "same", &Cancel::never(), |_| {
            panic!("write failure lost memory guard")
        })
        .unwrap();
    assert_eq!(raw_result(&first), expected["first"].as_str().unwrap());
    assert_eq!(
        raw_result(&duplicate),
        expected["duplicate"].as_str().unwrap()
    );
    assert_eq!(
        guard.warning_count(),
        expected["warnings"].as_u64().unwrap() as usize
    );
}

#[test]
fn only_one_waiter_takes_over_an_incomplete_leader() {
    use std::sync::atomic::AtomicUsize;
    let expected = fixture("replay-guard.json")["concurrency"].clone();
    let directory = physical_tempdir();
    let guard = ReplayGuard::new(directory.path().to_owned(), Arc::new(|| 1000));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let leader_guard = guard.clone();
    let leader = std::thread::spawn(move || {
        leader_guard.run("fixture", "same", &Cancel::never(), |_| {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(serde_json::from_value(json!({"stored":0,"skipped":1,"reason":"aborted"})).unwrap())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let waiters: Vec<_> = (0..2)
        .map(|_| {
            let guard = guard.clone();
            let calls = calls.clone();
            std::thread::spawn(move || {
                guard.run("fixture", "same", &Cancel::never(), |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(result())
                })
            })
        })
        .collect();
    release_tx.send(()).unwrap();
    leader.join().unwrap().unwrap();
    let mut results: Vec<_> = waiters
        .into_iter()
        .map(|waiter| raw_result(&waiter.join().unwrap().unwrap()))
        .collect();
    let mut expected_results: Vec<_> = expected["takeoverResults"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    results.sort();
    expected_results.sort();
    assert_eq!(results, expected_results);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        expected["takeoverCalls"].as_u64().unwrap() as usize
    );
}

// Production rejects symlinks; use the physical system temporary root on macOS too.
fn physical_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}
