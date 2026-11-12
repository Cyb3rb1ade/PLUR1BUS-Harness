//! Deferred dynamics queue order, backlog and cancellation of fallback timers versus Node.
#![cfg(feature = "testkit")]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_engine::{contract, text};
use serde_json::Value;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use plur1bus_engine::capture::deferred_dynamics as deferred;

#[test]
fn deferred_queue_state_and_drop_order_equal_the_pinned_node() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/dynamics.json")).unwrap();
    for case in golden["deferredCases"].as_array().unwrap() {
        let options = deferred::DeferredOptions::from_json(&case["options"]);
        let queue = deferred::DeferredDynamicsQueue::new_controlled(options);
        let order = Arc::new(Mutex::new(Vec::new()));
        let (release_tx, release_rx) = mpsc::channel();
        let mut release_rx = Some(release_rx);
        for index in 0..4 {
            let order = order.clone();
            let receiver = if index == 0 { release_rx.take() } else { None };
            let accepted = queue.enqueue("a", move || {
                order.lock().unwrap().push(index);
                if let Some(receiver) = receiver {
                    receiver.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                Ok(())
            });
            let expected = &case["states"][index];
            assert_eq!(accepted, expected["accepted"].as_bool().unwrap());
            assert_eq!(
                text::json::write_json(&queue.stats()),
                expected["stats"].as_str().unwrap()
            );
            assert_eq!(
                queue.pending("a"),
                expected["pending"].as_u64().unwrap() as usize
            );
            assert_eq!(
                queue.scheduled_count(),
                expected["timers"].as_u64().unwrap() as usize
            );
        }
        let _ = release_tx.send(());
        queue.kick("a").unwrap();
        let expected = &case["states"][4];
        assert_eq!(
            text::json::write_json(&queue.stats()),
            expected["stats"].as_str().unwrap()
        );
        assert_eq!(queue.pending("a"), 0);
        assert_eq!(queue.scheduled_count(), 0);
        assert_eq!(
            serde_json::to_value(order.lock().unwrap().clone()).unwrap(),
            case["order"]
        );
        queue.close();
        assert_eq!(
            queue.enqueue("a", || Ok(())),
            case["acceptedAfterClose"].as_bool().unwrap()
        );
        queue.drain(None).unwrap();
    }
}

#[test]
fn automatic_fallback_runs_and_close_cancels_sleeping_timers() {
    let queue = deferred::DeferredDynamicsQueue::new(deferred::DeferredOptions {
        fallback_delay: Duration::from_millis(10),
        ..Default::default()
    });
    let (completed_tx, completed_rx) = mpsc::channel();
    assert!(queue.enqueue("a", move || {
        completed_tx.send(()).unwrap();
        Ok(())
    }));
    completed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    queue.drain(None).unwrap();
    queue.close();
    let queue = deferred::DeferredDynamicsQueue::new(deferred::DeferredOptions {
        fallback_delay: Duration::from_secs(30),
        ..Default::default()
    });
    assert!(queue.enqueue("a", || Ok(())));
    let before = std::time::Instant::now();
    queue.close();
    assert!(before.elapsed() < Duration::from_secs(1));
    assert_eq!(queue.pending("a"), 1);
    queue.drain(None).unwrap();
    assert_eq!(queue.pending("a"), 0);
}

#[test]
fn lanes_run_independently_and_a_failed_job_does_not_stop_the_next_job() {
    let queue =
        deferred::DeferredDynamicsQueue::new_controlled(deferred::DeferredOptions::default());
    let (first_tx, first_rx) = mpsc::channel();
    assert!(queue.enqueue("a", move || {
        first_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(())
    }));
    assert!(
        queue.enqueue("b", || Err(contract::EngineError::NotAvailable {
            reason: "fixture".to_owned()
        }))
    );
    let (second_tx, second_rx) = mpsc::channel();
    assert!(queue.enqueue("b", move || {
        second_tx.send(()).unwrap();
        Ok(())
    }));
    queue.fire_fallback("a");
    queue.kick("b").unwrap();
    second_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(queue.failure_count(), 1);
    first_tx.send(()).unwrap();
    queue.drain(None).unwrap();
    queue.close();
}

#[test]
fn process_instances_share_one_queue_and_the_first_options_win() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/dynamics.json")).unwrap();
    assert_eq!(
        deferred::SHARED_DYNAMICS_QUEUE_KEY,
        golden["deferredKey"].as_str().unwrap()
    );
    let first = deferred::get_shared_deferred_dynamics_queue(deferred::DeferredOptions::default());
    let second = deferred::get_shared_deferred_dynamics_queue(deferred::DeferredOptions {
        fallback_delay: Duration::ZERO,
        ..Default::default()
    });
    assert!(first.enqueue("fixture", || Ok(())));
    assert_eq!(second.scheduled_count(), 1);
    second.kick("fixture").unwrap();
    assert_eq!(first.pending("fixture"), 0);
    first.close();
}

#[test]
fn a_delivered_fallback_after_close_cannot_start_waiting_work() {
    let queue = deferred::DeferredDynamicsQueue::new_controlled(Default::default());
    let (tx, rx) = mpsc::channel();
    assert!(queue.enqueue("a", move || {
        tx.send(()).unwrap();
        Ok(())
    }));
    queue.close();
    queue.fire_fallback("a");
    assert_eq!(queue.pending("a"), 1);
    assert_eq!(
        text::json::write_json(&queue.stats()),
        r#"{"a":{"waiting":1,"running":false,"dropped":0}}"#
    );
    assert!(rx.try_recv().is_err());
    queue.drain(None).unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn callback_panic_settles_the_lane_and_does_not_block_drain() {
    let queue = deferred::DeferredDynamicsQueue::new_controlled(Default::default());
    assert!(queue.enqueue("a", || panic!("fixture callback panic")));
    let (next_tx, next_rx) = mpsc::channel();
    assert!(queue.enqueue("a", move || {
        next_tx.send(()).unwrap();
        Ok(())
    }));
    let draining = queue.clone();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        draining.drain(None).unwrap();
        done_tx.send(()).unwrap();
    });
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    next_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(queue.pending("a"), 0);
    assert_eq!(queue.failure_count(), 1);
    queue.close();
}

#[test]
fn cancelled_drain_retains_an_active_lane_until_the_callback_returns() {
    let queue = deferred::DeferredDynamicsQueue::new_controlled(Default::default());
    let (release_tx, release_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::channel();
    assert!(queue.enqueue("a", move || {
        started_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(())
    }));
    queue.kick_background("a").unwrap();
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let cancel =
        contract::Cancel::with_deadline(std::time::Instant::now() + Duration::from_millis(20));
    assert!(matches!(
        queue.drain_with_cancel(None, &cancel),
        Err(contract::EngineError::Cancelled(_))
    ));
    assert_eq!(queue.pending("a"), 1);
    queue.close();
    assert_eq!(queue.pending("a"), 1);
    release_tx.send(()).unwrap();
    queue.drain(None).unwrap();
    assert_eq!(queue.pending("a"), 0);
}

#[test]
fn native_resource_limits_bound_lanes_backlog_and_total_waiting_work() {
    let queue = deferred::DeferredDynamicsQueue::new_controlled(deferred::DeferredOptions {
        max_backlog: f64::INFINITY,
        fallback_enabled: false,
        ..Default::default()
    });
    assert!(!queue.enqueue(&"x".repeat(129), || Ok(())));
    for lane in 0..4 {
        for _ in 0..1024 {
            assert!(queue.enqueue(&lane.to_string(), || Ok(())));
        }
    }
    assert!(queue.enqueue("0", || Ok(()))); // Replace oldest within this full lane.
    assert_eq!(queue.pending("0"), 1024);
    assert!(!queue.enqueue("extra", || Ok(()))); // Never evict another agent's work.
    queue.drain(None).unwrap();
    for lane in 0..queue.lane_limit() {
        assert!(queue.enqueue(&lane.to_string(), || Ok(())));
    }
    assert!(!queue.enqueue("extra", || Ok(())));
    queue.close();
    queue.drain(None).unwrap();
}

#[test]
fn already_cancelled_drain_never_starts_waiting_work() {
    let queue = deferred::DeferredDynamicsQueue::new_controlled(Default::default());
    assert!(queue.enqueue("a", || Ok(())));
    let cancel = contract::Cancel::never();
    cancel.cancel();
    assert!(queue.drain_with_cancel(None, &cancel).is_err());
    assert_eq!(queue.scheduled_count(), 1);
    assert_eq!(queue.pending("a"), 1);
    queue.close();
    queue.drain(None).unwrap();
}
