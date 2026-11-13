//! Entry guards and in-flight draining shared by all memory operations.
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, EngineError, HostServices, MemoryOpError, MemoryOpErrorCode, Principal,
    },
};
use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// How long a caller waits for the engine-wide mutation gate before it is refused as busy
/// (RE-D165). Longer than one budgeted embedding under the gate (15 s); a holder inside a Neo
/// lease wait may hold longer, and a waiter then gets `engine-busy` and retries.
pub const MUTATION_WAIT: Duration = Duration::from_secs(20);
/// At most this many callers wait for the gate at a time (RE-D165). A further caller is
/// refused at once as busy, so waiters never fill a connection's request slots (eight per
/// connection in the process server) and recall and capture keep slots of their own.
pub const MAX_MUTATION_WAITERS: usize = 4;

fn busy() -> EngineError {
    EngineError::NotAvailable {
        reason: "engine-busy".into(),
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
    /// The mutation gate is held.
    held: bool,
    /// Callers waiting for the gate.
    waiting: usize,
}

/// Host-bound lifecycle. Closing rejects new work and drains already admitted operations.
pub struct OperationContext {
    host: Arc<dyn HostServices>,
    state: Mutex<State>,
    drained: Condvar,
    /// Signalled when the gate is released or the context closes.
    released: Condvar,
    wait: Mutex<Duration>,
}

/// The engine-wide mutation gate, released on drop.
pub struct MutationGuard<'a>(&'a OperationContext);
impl Drop for MutationGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().held = false;
        self.0.released.notify_all();
    }
}

impl OperationContext {
    /// Start an open operation boundary without touching any persistent state.
    pub fn new(host: Arc<dyn HostServices>) -> Self {
        Self {
            host,
            state: Mutex::new(State::default()),
            drained: Condvar::new(),
            released: Condvar::new(),
            wait: Mutex::new(MUTATION_WAIT),
        }
    }
    /// Replace the gate wait (tests only).
    #[cfg(any(test, feature = "testkit"))]
    pub fn set_mutation_wait(&self, wait: Duration) {
        *self.wait.lock().unwrap_or_else(PoisonError::into_inner) = wait;
    }
    /// How many callers wait for the gate now (tests only).
    #[cfg(any(test, feature = "testkit"))]
    pub fn mutation_waiters(&self) -> usize {
        self.lock().waiting
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub(crate) fn host_handle(&self) -> Arc<dyn HostServices> {
        self.host.clone()
    }
    /// Host services used only after the entry guard admits the operation.
    pub fn host(&self) -> &dyn HostServices {
        self.host.as_ref()
    }
    /// Validate the principal before any store lease; register the operation until its guard drops.
    pub fn enter<'a>(
        &'a self,
        principal: &Principal,
        agent: &AgentContext,
    ) -> Result<Operation<'a>, EngineError> {
        {
            let mut state = self.lock();
            if state.closed {
                return Err(error(MemoryOpErrorCode::Storage));
            }
            state.active += 1;
        }
        let guard = InFlight(self);
        let id = principal.agent_id.as_str();
        if id.is_empty()
            || id.len() > 128
            || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let context =
            RequestContext::build(principal, agent, self.host.as_ref()).map_err(|failure| {
                error(match failure {
                    EngineError::Host(_) => MemoryOpErrorCode::InvalidInput,
                    _ => MemoryOpErrorCode::Denied,
                })
            })?;
        Ok(Operation {
            context,
            _guard: guard,
        })
    }
    /// Recheck immediately before mutation, including operations admitted before close began.
    pub fn assert_open(&self) -> Result<(), EngineError> {
        if self.lock().closed {
            Err(error(MemoryOpErrorCode::Storage))
        } else {
            Ok(())
        }
    }
    /// Take the engine-wide mutation gate, waiting at most the gate wait ([`MUTATION_WAIT`]).
    /// A gate still held then answers `engine-busy`, and so does a caller beyond
    /// [`MAX_MUTATION_WAITERS`] at once; a close during the wait answers like a closed context.
    /// No caller waits without a deadline (RE-D165).
    pub(crate) fn mutation(&self) -> Result<MutationGuard<'_>, EngineError> {
        let wait = *self.wait.lock().unwrap_or_else(PoisonError::into_inner);
        let deadline = Instant::now().checked_add(wait);
        let mut state = self.lock();
        if state.held && !state.closed {
            if state.waiting >= MAX_MUTATION_WAITERS {
                return Err(busy());
            }
            state.waiting += 1;
        } else if state.closed {
            return Err(error(MemoryOpErrorCode::Storage));
        } else {
            state.held = true;
            return Ok(MutationGuard(self));
        }
        while state.held && !state.closed {
            let left = deadline.map(|at| at.saturating_duration_since(Instant::now()));
            if left == Some(Duration::ZERO) {
                state.waiting -= 1;
                return Err(busy());
            }
            state = match left {
                Some(left) => {
                    self.released
                        .wait_timeout(state, left)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .released
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
        state.waiting -= 1;
        if state.closed {
            return Err(error(MemoryOpErrorCode::Storage));
        }
        state.held = true;
        Ok(MutationGuard(self))
    }
    pub(super) fn destructive_workspace(
        &self,
        context: &RequestContext,
    ) -> Result<std::path::PathBuf, EngineError> {
        if context.origin_wire() != "user" || context.background() {
            return Err(error(MemoryOpErrorCode::Denied));
        }
        self.host
            .workspace_dir(&context.agent_id)
            .map_err(|_| error(MemoryOpErrorCode::InvalidInput))?
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))
    }
    /// Refuse new operations, then wait until every existing guard has been released.
    /// The caller must not hold an operation guard itself.
    pub fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        self.released.notify_all();
        while state.active != 0 {
            state = self
                .drained
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
    /// [`Self::close`] within a budget: new work and gate waiters are refused at once, and
    /// admitted operations are waited for at most `budget`. Returns whether all drained; an
    /// operation still inside a provider call then finishes on its own thread and can no
    /// longer mutate (`assert_open` before every write step).
    pub fn close_within(&self, budget: Duration) -> bool {
        let deadline = Instant::now().checked_add(budget);
        let mut state = self.lock();
        state.closed = true;
        self.released.notify_all();
        while state.active != 0 {
            let Some(left) = deadline.map(|at| at.saturating_duration_since(Instant::now())) else {
                state = self
                    .drained
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
                continue;
            };
            if left.is_zero() {
                return false;
            }
            state = self
                .drained
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}
struct InFlight<'a>(&'a OperationContext);
impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.active -= 1;
        if state.active == 0 {
            self.0.drained.notify_all();
        }
    }
}
/// Authenticated request plus the guard keeping its stores alive through completion.
pub struct Operation<'a> {
    /// Canonical identity used for every row ACL check.
    pub context: RequestContext,
    _guard: InFlight<'a>,
}
pub(super) fn error(code: MemoryOpErrorCode) -> EngineError {
    MemoryOpError::new(code).into()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "fixture errors are fatal")]
    use super::*;
    use crate::contract::testing::FakeHost;

    fn context() -> Arc<OperationContext> {
        let temp = std::env::temp_dir().join("plur1bus-context-test-unused");
        Arc::new(OperationContext::new(Arc::new(FakeHost::new(
            temp,
            serde_json::from_value(serde_json::json!({})).unwrap(),
        ))))
    }
    fn reason(error: EngineError) -> String {
        match error {
            EngineError::NotAvailable { reason } => reason,
            EngineError::MemoryOp(error) => error.code.to_string(),
            other => other.to_string(),
        }
    }
    fn until(check: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(30);
        while !check() {
            assert!(Instant::now() < end, "condition not reached");
            std::thread::yield_now();
        }
    }

    #[test]
    fn a_waiter_gets_busy_after_its_wait_and_the_gate_after_release() {
        let ctx = context();
        ctx.set_mutation_wait(Duration::from_millis(50));
        let held = ctx.mutation().unwrap();
        assert_eq!(reason(ctx.mutation().err().unwrap()), "engine-busy");
        assert_eq!(ctx.mutation_waiters(), 0);
        drop(held);
        drop(ctx.mutation().unwrap());
    }

    #[test]
    fn waiters_beyond_the_cap_are_refused_at_once_and_close_releases_the_rest() {
        let ctx = context();
        ctx.set_mutation_wait(Duration::from_secs(600));
        let held = ctx.mutation().unwrap();
        std::thread::scope(|scope| {
            let waiters: Vec<_> = (0..MAX_MUTATION_WAITERS)
                .map(|_| scope.spawn(|| ctx.mutation().map(|_| ()).map_err(reason)))
                .collect();
            until(|| ctx.mutation_waiters() == MAX_MUTATION_WAITERS);
            // The fifth caller does not wait at all.
            let started = Instant::now();
            assert_eq!(reason(ctx.mutation().err().unwrap()), "engine-busy");
            assert!(started.elapsed() < Duration::from_secs(5));
            // Close refuses the waiters as a closed context, without waiting for the holder.
            ctx.close_within(Duration::ZERO);
            for waiter in waiters {
                assert_eq!(waiter.join().unwrap().unwrap_err(), "storage");
            }
        });
        assert_eq!(ctx.mutation_waiters(), 0);
        drop(held);
        assert_eq!(reason(ctx.mutation().err().unwrap()), "storage");
    }

    #[test]
    fn close_within_reports_an_operation_still_admitted() {
        let ctx = context();
        let principal: Principal = serde_json::from_value(serde_json::json!({"agentId":"agent",
            "workspace":"workspace:v1:fixture","channel":"cli","accountId":"fixture",
            "chat":{"id":"fixture","kind":"direct"},"trust":"inferred"}))
        .unwrap();
        let agent: AgentContext =
            serde_json::from_value(serde_json::json!({"origin":"user","background":false}))
                .unwrap();
        let admitted = ctx.enter(&principal, &agent).unwrap();
        assert!(!ctx.close_within(Duration::from_millis(20)));
        assert!(
            ctx.assert_open().is_err(),
            "no write step passes after close"
        );
        drop(admitted);
        assert!(ctx.close_within(Duration::from_millis(20)));
    }
}
