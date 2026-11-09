//! Lazy process-owned writer pools. Opening a table grants no row authority.
use crate::{
    contract::{
        AgentId, AgentStoreHandle, EngineConfig, EngineError, StoreError, VectorSpaceIdentity,
    },
    recall::namespaces::NamespaceStores,
};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

#[derive(Default)]
struct State {
    pools: Option<NamespaceStores>,
    agents: BTreeSet<String>,
    closed: bool,
}

pub(super) struct EngineStores {
    config: EngineConfig,
    base: Option<PathBuf>,
    identity: VectorSpaceIdentity,
    state: Mutex<State>,
    count: AtomicUsize,
}
impl EngineStores {
    pub(super) fn new(
        config: EngineConfig,
        base: Option<PathBuf>,
        identity: VectorSpaceIdentity,
    ) -> Self {
        Self {
            config,
            base,
            identity,
            state: Mutex::default(),
            count: AtomicUsize::new(0),
        }
    }
    pub(super) fn open(self: &Arc<Self>, agent: &AgentId) -> Result<AgentStoreHandle, EngineError> {
        // Contract AgentId is broader than the physical store segment grammar.
        let id = crate::context::safe_agent_id(&agent.to_string()).map_err(|_| {
            EngineError::Invalid {
                field: "agentId".into(),
                message: "invalid store agent ID".into(),
            }
        })?;
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        if state.closed {
            return Err(EngineError::NotAvailable {
                reason: "closed".into(),
            });
        }
        if state.pools.is_none() {
            let base = self.base.as_ref().ok_or_else(|| EngineError::Invalid {
                field: "baseDbPath".into(),
                message: "resolved store path required".into(),
            })?;
            // Eight idle handles per route; live leases remain pinned by StorePool.
            state.pools = Some(NamespaceStores::open(
                base,
                &self.config,
                &self.identity,
                8,
            )?);
        }
        state
            .pools
            .as_ref()
            .ok_or(StoreError::Unavailable)?
            .write_store(&id)?;
        state.agents.insert(id.clone());
        self.count.store(state.agents.len(), Ordering::Release);
        let weak = Arc::downgrade(self);
        let closed = AtomicBool::new(false);
        Ok(AgentStoreHandle {
            agent_id: agent.clone(),
            close: Box::new(move || {
                if closed.load(Ordering::Acquire) {
                    return Ok(());
                }
                if let Some(owner) = weak.upgrade() {
                    let mut state = owner.state.lock().map_err(|_| StoreError::Unavailable)?;
                    if !closed.swap(true, Ordering::AcqRel) {
                        state.agents.remove(&id);
                        owner.count.store(state.agents.len(), Ordering::Release);
                    }
                }
                Ok(())
            }),
        })
    }
    pub(super) fn close(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        state.closed = true;
        state.agents.clear();
        self.count.store(0, Ordering::Release);
        state.pools = None;
        Ok(())
    }
    pub(super) fn count(&self) -> usize {
        self.count.load(Ordering::Acquire)
    }
}
