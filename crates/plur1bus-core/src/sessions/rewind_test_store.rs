//! Clock, in-memory session store and audit sink shared by the rewind tests.
use super::checkpoint_retention::SharedAudit;
use super::{Clock, IdSource, SessionStore};
use crate::rbac::audit::{AuditEvent, AuditSink};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

pub(crate) struct TestClock(pub AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub(crate) struct TestIds(pub AtomicU64);
impl IdSource for TestIds {
    fn next_id(&self) -> String {
        (self.0.fetch_add(1, Ordering::SeqCst) + 1).to_string()
    }
}

pub(crate) fn clock(at: i64) -> Arc<TestClock> {
    Arc::new(TestClock(AtomicI64::new(at)))
}

pub(crate) fn store_with(clock: Arc<TestClock>) -> SessionStore {
    SessionStore::open_memory(clock, Arc::new(TestIds(AtomicU64::new(0)))).unwrap()
}

/// An audit sink that keeps its events.
struct MemAudit(Rc<RefCell<Vec<AuditEvent>>>);
impl AuditSink for MemAudit {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        self.0.borrow_mut().push(event.clone());
        Ok(())
    }
}

pub(crate) fn audit_pair() -> (SharedAudit, Rc<RefCell<Vec<AuditEvent>>>) {
    let events = Rc::new(RefCell::new(Vec::new()));
    (
        Rc::new(RefCell::new(
            Box::new(MemAudit(events.clone())) as Box<dyn AuditSink>
        )),
        events,
    )
}
