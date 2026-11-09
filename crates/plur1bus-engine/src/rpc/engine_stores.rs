//! Lazy process-owned writer pools. Opening a table grants no row authority.
use crate::{
    context::RequestContext,
    contract::{
        AgentId, AgentStoreHandle, Cancel, EngineConfig, EngineError, MemoryShareTarget,
        StoreError, VectorSpaceIdentity,
    },
    ops::{
        import::ImportStores,
        memory::{ReadSource, ReadStores},
        private_routes::PrivateMemoryStores,
        rebind::RebindStores,
        routes::MemoryStores,
        sharing::SharedStores,
        write::MutationStores,
    },
    recall::namespaces::NamespaceStores,
    store::{shared_pool::SharedPool, Store},
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

fn store_failure(error: EngineError) -> StoreError {
    match error {
        EngineError::Store(error) => error,
        _ => StoreError::Unavailable,
    }
}

#[derive(Default)]
struct State {
    pools: Option<Arc<NamespaceStores>>,
    memory_routes: Option<Arc<MemoryStores>>,
    warm_routes: Option<Arc<MemoryStores>>,
    recovered: bool,
    agents: BTreeSet<String>,
    closed: bool,
}

pub(super) struct EngineStores {
    config: EngineConfig,
    base: Option<PathBuf>,
    identity: VectorSpaceIdentity,
    fingerprint: String,
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
        fingerprint: String,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        cancel: Cancel,
    ) -> Self {
        Self {
            config,
            base,
            identity,
            fingerprint,
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
        let base = self.base.as_ref().ok_or_else(|| EngineError::Invalid {
            field: "baseDbPath".into(),
            message: "resolved store path required".into(),
        })?;
        if state.pools.is_none() {
            let pools = if self.config.reembedding.is_some() {
                Some(NamespaceStores::open_generation(
                    base,
                    &self.config,
                    &self.identity,
                    &self.fingerprint,
                    IDLE_STORES_PER_ROUTE,
                )?)
            } else if create_root {
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

    fn memory_routes(&self) -> Result<Option<Arc<MemoryStores>>, StoreError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        let Some(pools) = self.namespaces(&mut state, false).map_err(store_failure)? else {
            return Ok(None);
        };
        if state.memory_routes.is_none() {
            state.memory_routes = Some(self.compose_read_routes(pools)?);
        }
        Ok(state.memory_routes.clone())
    }

    fn compose_read_routes(
        &self,
        pools: Arc<NamespaceStores>,
    ) -> Result<Arc<MemoryStores>, StoreError> {
        let shared = SharedPool::open(pools.base(), &self.identity, IDLE_STORES_PER_ROUTE)?
            .with_parent_pins(pools.root_pins())?;
        Ok(Arc::new(MemoryStores::new(
            PrivateMemoryStores::new(pools),
            Arc::new(shared),
        )))
    }

    pub(super) fn configured_base(&self) -> Option<&std::path::Path> {
        self.base.as_deref()
    }

    pub(super) fn warm_sources(
        &self,
        context: &RequestContext,
    ) -> Result<Vec<ReadSource>, StoreError> {
        let routes = {
            let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
            if state.closed || self.cancel.is_cancelled() {
                return Err(StoreError::Unavailable);
            }
            if state.warm_routes.is_none() {
                let base = self.base.as_deref().ok_or(StoreError::Unavailable)?;
                let Some(pools) = NamespaceStores::open_for_warm(
                    base,
                    &self.config,
                    &self.identity,
                    &self.fingerprint,
                    IDLE_STORES_PER_ROUTE,
                )?
                else {
                    return Ok(Vec::new());
                };
                // Separate read-only pools deliberately do not invoke write-capable S5 recovery.
                state.warm_routes = Some(self.compose_read_routes(Arc::new(pools))?);
            }
            state.warm_routes.clone()
        };
        routes.ok_or(StoreError::Unavailable)?.sources(context)
    }

    fn writable_private(&self, context: &RequestContext) -> Result<Arc<Store>, StoreError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        let pools = self
            .namespaces(&mut state, true)
            .map_err(store_failure)?
            .ok_or(StoreError::Unavailable)?;
        pools.write_store(context.agent_id.as_str())
    }

    pub(super) fn close(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        state.closed = true;
        state.agents.clear();
        self.count.store(0, Ordering::Release);
        state.memory_routes = None;
        state.warm_routes = None;
        state.pools = None;
        Ok(())
    }
    pub(super) fn count(&self) -> usize {
        self.count.load(Ordering::Acquire)
    }
}

impl ReadStores for EngineStores {
    fn sources(&self, context: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        match self.memory_routes()? {
            Some(routes) => routes.sources(context),
            None => Ok(Vec::new()),
        }
    }
}

impl MutationStores for EngineStores {
    fn existing_private(&self, context: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        match self.memory_routes()? {
            Some(routes) => routes.existing_private(context),
            None => Ok(None),
        }
    }
}

impl ImportStores for EngineStores {
    fn existing(&self, context: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.existing_private(context)
    }

    fn writable(&self, context: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writable_private(context)
    }
}

impl RebindStores for EngineStores {
    fn existing(&self, context: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.existing_private(context)
    }

    fn writable(&self, context: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writable_private(context)
    }
}

impl SharedStores for EngineStores {
    fn supported(&self) -> bool {
        self.memory_routes()
            .ok()
            .flatten()
            .is_some_and(|routes| routes.supported())
    }

    fn target(
        &self,
        context: &RequestContext,
        scope: MemoryShareTarget,
    ) -> Result<Arc<Store>, StoreError> {
        self.memory_routes()?
            .ok_or(StoreError::Unavailable)?
            .target(context, scope)
    }
}
