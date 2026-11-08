//! Entry guards and in-flight draining shared by all memory operations.
use crate::{
    context::RequestContext,
    contract::{
        AgentContext, EngineError, HostServices, MemoryOpError, MemoryOpErrorCode, Principal,
    },
};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
}

/// Host-bound lifecycle. Closing rejects new work and drains already admitted operations.
pub struct OperationContext {
    host: Arc<dyn HostServices>,
    state: Mutex<State>,
    drained: Condvar,
    mutation: Mutex<()>,
}
impl OperationContext {
    /// Start an open operation boundary without touching any persistent state.
    pub fn new(host: Arc<dyn HostServices>) -> Self {
        Self {
            host,
            state: Mutex::new(State::default()),
            drained: Condvar::new(),
            mutation: Mutex::new(()),
        }
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
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
    pub(super) fn mutation(&self) -> Result<MutexGuard<'_, ()>, EngineError> {
        let guard = self.mutation.lock().unwrap_or_else(PoisonError::into_inner);
        self.assert_open()?;
        Ok(guard)
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
        while state.active != 0 {
            state = self
                .drained
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
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
