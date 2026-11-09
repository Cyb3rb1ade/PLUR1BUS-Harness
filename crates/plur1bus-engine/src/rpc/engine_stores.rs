//! Lazy process-owned writer pools. Opening a table grants no row authority.
use crate::{
    context::RequestContext,
    contract::{
        AgentId, AgentStoreHandle, Cancel, EngineConfig, EngineError, StoreError,
        VectorSpaceIdentity,
    },
    ops::{
        memory::{ReadSource, ReadStores},
        private_routes::PrivateMemoryStores,
        routes::MemoryStores,
    },
    recall::namespaces::NamespaceStores,
    store::shared_pool::SharedPool,
};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const IDLE_STORES_PER_ROUTE: usize = 8;

#[derive(Default)]
struct State {
    pools: Option<Arc<NamespaceStores>>,
    memory_routes: Option<Arc<MemoryStores>>,
    recovered: bool,
    agents: BTreeSet<String>,
    closed: bool,
}

pub(super) struct EngineStores {
    config: EngineConfig,
    base: Option<PathBuf>,
    identity: VectorSpaceIdentity,
    state: Mutex<State>,
    count: AtomicUsize,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    cancel: Cancel,
}
impl EngineStores {
    pub(super) fn new(
        config: EngineConfig,
        base: Option<PathBuf>,
        identity: VectorSpaceIdentity,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        cancel: Cancel,
    ) -> Self {
        Self {
            config,
            base,
            identity,
            state: Mutex::default(),
            count: AtomicUsize::new(0),
            clock,
            cancel,
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
        let pools = self
            .namespaces(&mut state, true)?
            .ok_or(StoreError::Unavailable)?;
        pools.write_store(&id)?;
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
    fn namespaces(
        &self,
        state: &mut State,
        create_root: bool,
    ) -> Result<Option<Arc<NamespaceStores>>, EngineError> {
        if state.closed {
            return Err(EngineError::NotAvailable {
                reason: "closed".into(),
            });
        }
        self.cancel.check()?;
        if self.config.reembedding.is_some() {
            return Err(EngineError::NotAvailable {
                reason: "generation-routing-pending".into(),
            });
        }
        let base = self.base.as_ref().ok_or_else(|| EngineError::Invalid {
            field: "baseDbPath".into(),
            message: "resolved store path required".into(),
        })?;
        if state.pools.is_none() {
            let pools = if create_root {
                Some(NamespaceStores::open(
                    base,
                    &self.config,
                    &self.identity,
                    IDLE_STORES_PER_ROUTE,
                )?)
            } else {
                NamespaceStores::open_existing(
                    base,
                    &self.config,
                    &self.identity,
                    IDLE_STORES_PER_ROUTE,
                )?
            };
            state.pools = pools.map(Arc::new);
        }
        let Some(pools) = &state.pools else {
            return Ok(None);
        };
        if !state.recovered {
            let lookup = crate::ops::tombstones::NamespaceGenerationLookup::new(pools.clone());
            let report =
                crate::ops::tombstones::reconcile(base, &lookup, (self.clock)(), &self.cancel)?;
            if !report.errors.is_empty() || !report.registry_errors.is_empty() {
                return Err(EngineError::NotAvailable {
                    reason: "startup-recovery-incomplete".into(),
                });
            }
            state.recovered = true;
        }
        self.cancel.check()?;
        Ok(Some(pools.clone()))
    }

    fn memory_routes(&self) -> Result<Option<Arc<MemoryStores>>, EngineError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        let Some(pools) = self.namespaces(&mut state, false)? else {
            return Ok(None);
        };
        if state.memory_routes.is_none() {
            let shared = SharedPool::open(pools.base(), &self.identity, IDLE_STORES_PER_ROUTE)?;
            state.memory_routes = Some(Arc::new(MemoryStores::new(
                PrivateMemoryStores::new(pools),
                Arc::new(shared),
            )));
        }
        Ok(state.memory_routes.clone())
    }

    pub(super) fn close(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        state.closed = true;
        state.agents.clear();
        self.count.store(0, Ordering::Release);
        state.memory_routes = None;
        state.pools = None;
        Ok(())
    }
    pub(super) fn count(&self) -> usize {
        self.count.load(Ordering::Acquire)
    }
}

impl ReadStores for EngineStores {
    fn sources(&self, context: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        match self.memory_routes() {
            Ok(Some(routes)) => routes.sources(context),
            Ok(None) => Ok(Vec::new()),
            Err(EngineError::Store(error)) => Err(error),
            Err(_) => Err(StoreError::Unavailable),
        }
    }
}
