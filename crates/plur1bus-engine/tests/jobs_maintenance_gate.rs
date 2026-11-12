//! Frozen Node gate transitions and native cancellation/concurrency boundaries.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::{Cancel, EngineError},
    jobs::maintenance_gate::{Gate, Status},
};
use serde_json::{json, Value};
use std::sync::Arc;

#[test]
fn twenty_eight_actual_node_gate_scenarios_match() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/maintenance-gate.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let mut gate = Gate::new(Arc::new(|| 1800000000000.0));
        if case.get("external").is_some() || case["externalError"] == true {
            let external = case["external"].clone();
            let fails = case["externalError"] == true;
            gate = gate.with_external(Arc::new(move |_| {
                if fails {
                    return Err(EngineError::NotAvailable {
                        reason: "external unavailable".into(),
                    });
                }
                Ok(Status {
                    active: external["active"].as_bool() == Some(true),
                    reason: external["reason"].as_str().map(str::to_owned),
                    since: external["since"].as_f64(),
                })
            }));
        }
        let mut outputs = Vec::new();
        for action in case["actions"].as_array().unwrap() {
            let input = &action["input"];
            let outcome = match action["op"].as_str().unwrap() {
                "enter" => gate
                    .enter(
                        input["reason"].as_str().unwrap(),
                        input["migrationId"].as_str().unwrap(),
                        &Cancel::never(),
                    )
                    .map(|()| json!({})),
                "exit" => gate
                    .exit(
                        input["reason"].as_str().unwrap(),
                        input["migrationId"].as_str().unwrap(),
                        &Cancel::never(),
                    )
                    .map(|()| json!({})),
                _ => gate
                    .status(&Cancel::never())
                    .map(|value| json!({"value": value})),
            };
            outputs.push(match outcome {
                Ok(value) => value,
                Err(EngineError::NotAvailable { reason }) => json!({"error": reason}),
                Err(error) => json!({"unexpected": error.to_string()}),
            });
        }
        assert_eq!(json!(outputs), case["outputs"], "{}", case["name"]);
    }
}

#[test]
fn cancellation_and_invalid_clock_do_not_mutate_the_local_lease() {
    let gate = Gate::new(Arc::new(|| 1.0));
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(gate.enter("switch", "one", &cancelled).is_err());
    assert!(!gate.status(&Cancel::never()).unwrap().active);
    gate.enter("switch", "one", &Cancel::never()).unwrap();
    assert!(gate.exit("switch", "one", &cancelled).is_err());
    assert!(gate.status(&Cancel::never()).unwrap().active);
    assert!(gate.status(&cancelled).is_err());
    gate.exit("switch", "one", &Cancel::never()).unwrap();
    let invalid = Gate::new(Arc::new(|| f64::NAN));
    assert!(invalid.enter("switch", "one", &Cancel::never()).is_err());
    assert!(!invalid.status(&Cancel::never()).unwrap().active);
}

#[test]
fn a_deadline_interrupts_waiting_for_another_local_transition() {
    use std::time::{Duration, Instant};
    let (entered, started) = std::sync::mpsc::channel();
    let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let wait = release.clone();
    let gate = Arc::new(Gate::new(Arc::new(move || {
        entered.send(()).unwrap();
        let guard = wait.0.lock().unwrap();
        drop(wait.1.wait_while(guard, |go| !*go).unwrap());
        1.0
    })));
    let holder = gate.clone();
    let writer =
        std::thread::spawn(move || holder.enter("switch", "one", &Cancel::never()).unwrap());
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    let (done, result) = std::sync::mpsc::channel();
    let reader = gate.clone();
    let worker = std::thread::spawn(move || {
        let result = reader.status(&Cancel::with_deadline(
            Instant::now() + Duration::from_millis(20),
        ));
        done.send(result.is_err()).unwrap();
    });
    let observed = result.recv_timeout(Duration::from_secs(1));
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    writer.join().unwrap();
    worker.join().unwrap();
    assert!(observed.unwrap());
    assert!(gate.status(&Cancel::never()).unwrap().active);
}

#[test]
fn concurrent_enter_has_one_owner_and_pending_external_status_cannot_hide_it() {
    let gate = Arc::new(Gate::new(Arc::new(|| 1.0)));
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|i| {
            let gate = gate.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (
                    i,
                    gate.enter("switch", &format!("migration-{i}"), &Cancel::never())
                        .is_ok(),
                )
            })
        })
        .collect();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|(_, ok)| *ok).count(), 1);
    let owner = results.iter().find(|(_, ok)| *ok).unwrap().0;
    gate.exit("switch", &format!("migration-{owner}"), &Cancel::never())
        .unwrap();

    let (send, receive) = std::sync::mpsc::channel();
    let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let wait = release.clone();
    let gate = Arc::new(
        Gate::new(Arc::new(|| 2.0)).with_external(Arc::new(move |_| {
            send.send(()).unwrap();
            let lock = wait.0.lock().unwrap();
            drop(wait.1.wait_while(lock, |go| !*go).unwrap());
            Ok(Status {
                active: false,
                reason: None,
                since: None,
            })
        })),
    );
    let reader = gate.clone();
    let worker = std::thread::spawn(move || reader.status(&Cancel::never()).unwrap());
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    gate.enter("switch", "one", &Cancel::never()).unwrap();
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    assert_eq!(worker.join().unwrap().reason.as_deref(), Some("switch"));
}
