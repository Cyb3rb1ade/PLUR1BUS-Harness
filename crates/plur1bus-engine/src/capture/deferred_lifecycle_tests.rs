//! Deterministic stale-timer and concurrent close boundary regressions.
#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn an_old_timer_cannot_start_a_new_generation_in_the_same_lane() {
    let queue = DeferredDynamicsQueue::new_controlled(Default::default());
    assert!(queue.enqueue("a", || Ok(())));
    let old = lock(&queue.0.state).lanes[0].timer.clone().unwrap();
    queue.kick("a").unwrap();
    assert!(queue.enqueue("a", || Ok(())));
    queue.start("a", Some(&old)).unwrap();
    assert_eq!(queue.scheduled_count(), 1);
    let state = lock(&queue.0.state);
    assert!(!state.lanes[0].running);
    assert_eq!(state.lanes[0].jobs.len(), 1);
    drop(state);
    queue.close();
    queue.drain(None).unwrap();
}

#[test]
fn close_serializes_with_timer_registration_and_joins_all_handles() {
    for _ in 0..64 {
        let queue = DeferredDynamicsQueue::new(Default::default());
        let gate = Arc::new(std::sync::Barrier::new(2));
        let producer = queue.clone();
        let producer_gate = gate.clone();
        let thread = std::thread::spawn(move || {
            producer_gate.wait();
            producer.enqueue("a", || Ok(()))
        });
        gate.wait();
        queue.close();
        let accepted = thread.join().unwrap();
        assert!(lock(&queue.0.timers).is_empty());
        assert_eq!(queue.scheduled_count(), 0);
        assert_eq!(queue.pending("a"), usize::from(accepted));
        queue.drain(None).unwrap();
    }
}

#[test]
fn worker_resource_refusal_retains_the_original_callback_for_explicit_retry() {
    let mut queue = DeferredDynamicsQueue::new_controlled(Default::default());
    Arc::get_mut(&mut queue.0).unwrap().lane_limit = 1;
    let gate = Arc::new(std::sync::Barrier::new(3));
    for _ in 0..2 {
        let gate = gate.clone();
        lock(&queue.0.workers).push((
            "held".into(),
            std::thread::spawn(move || {
                gate.wait();
            }),
        ));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    assert!(queue.enqueue("a", move || {
        tx.send(()).unwrap();
        Ok(())
    }));
    assert!(matches!(
        queue.kick("a"),
        Err(EngineError::NotAvailable { .. })
    ));
    assert_eq!(queue.pending("a"), 1);
    assert_eq!(queue.failure_count(), 1);
    assert!(rx.try_recv().is_err());
    gate.wait();
    for (_, handle) in std::mem::take(&mut *lock(&queue.0.workers)) {
        handle.join().unwrap();
    }
    queue.kick("a").unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    queue.close();
}
