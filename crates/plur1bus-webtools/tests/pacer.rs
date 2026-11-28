#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "recorded TypeScript oracle"
)]

use plur1bus_webtools::pacer::{Clock, Error, Pacer};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

struct Fixture {
    now: Cell<u64>,
    fail: Cell<bool>,
    sleeps: RefCell<Vec<u64>>,
}

impl Clock for Fixture {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
    fn sleep_ms(&self, ms: u64, _cancelled: &dyn Fn() -> bool) -> Result<(), Error> {
        self.sleeps.borrow_mut().push(ms);
        if self.fail.get() {
            return Err(Error::Cancelled);
        }
        self.now.set(self.now.get() + ms);
        Ok(())
    }
}

#[test]
fn pacing_and_reservation_rollback_match_recorded_host_calls() {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/webtools/pacer.json")).unwrap();
    for case in data["cases"].as_array().unwrap() {
        let clock = Fixture {
            now: Cell::new(1000),
            fail: Cell::default(),
            sleeps: RefCell::default(),
        };
        let pacer = Pacer::new(1000);
        let mut outcomes = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            clock
                .now
                .set(clock.now.get() + step["advance"].as_u64().unwrap_or(0));
            clock.fail.set(step["cancel"].as_bool().unwrap_or(false));
            let result = pacer.wait(
                step["host"].as_str().unwrap(),
                step["crawlMs"].as_u64().unwrap_or(0),
                &clock,
                &|| false,
            );
            outcomes.push(match result {
                Ok(()) => "ok",
                Err(Error::Cancelled) => "cancelled",
                Err(error) => panic!("unexpected result: {error:?}"),
            });
        }
        assert_eq!(
            json!({"outcomes":outcomes,"sleeps":clock.sleeps.into_inner(),"hosts":pacer.len().unwrap()}),
            case["expected"],
        );
    }
}

#[test]
fn adding_an_origin_evicts_the_oldest_slot_at_capacity() {
    let clock = Fixture {
        now: Cell::new(1000),
        fail: Cell::default(),
        sleeps: RefCell::default(),
    };
    let pacer = Pacer::new(1000);
    for host in 0..1024 {
        pacer
            .wait(&format!("host-{host}"), 0, &clock, &|| false)
            .unwrap();
    }
    assert_eq!(pacer.len(), Ok(1024));
    pacer.wait("new-host", 0, &clock, &|| false).unwrap();
    assert_eq!(pacer.len(), Ok(1024));
    pacer.wait("host-0", 0, &clock, &|| false).unwrap();
    assert!(clock.sleeps.borrow().is_empty());
    pacer.wait("host-2", 0, &clock, &|| false).unwrap();
    assert_eq!(clock.sleeps.into_inner(), [1000]);
}
