//! Native private memory ports over the same configured namespace pools used by recall.
//! Callers still authorize requests/rows. Shared sources are composed separately and explicitly.
use super::{
    import::ImportStores,
    memory::{ReadSource, ReadStores, SourceKind},
    rebind::RebindStores,
    write::MutationStores,
};
use crate::{
    context::RequestContext,
    contract::StoreError,
    recall::namespaces::NamespaceStores,
    store::{Store, StoreRoutes},
};
use std::sync::Arc;

/// Private routes only: no inferred shared pool, no row-level or maintenance authority.
pub struct PrivateMemoryStores {
    namespaces: Arc<NamespaceStores>,
}
impl PrivateMemoryStores {
    /// Reuse host-constructed, physically pinned namespace routes without opening a table.
    pub fn new(namespaces: Arc<NamespaceStores>) -> Self {
        Self { namespaces }
    }
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.namespaces.existing_write_store(ctx.agent_id.as_str())
    }
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.namespaces.write_store(ctx.agent_id.as_str())
    }
}
impl ReadStores for PrivateMemoryStores {
    fn sources(&self, ctx: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        let mut sources = Vec::new();
        for route in self.namespaces.read_routes()? {
            if let Some(store) = route.lease_existing(ctx.agent_id.as_str())? {
                sources.push(ReadSource {
                    store,
                    kind: SourceKind::Private,
                    optional: false,
                });
            }
        }
        Ok(sources)
    }
}
impl MutationStores for PrivateMemoryStores {
    fn existing_private(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.existing(ctx)
    }
}
impl ImportStores for PrivateMemoryStores {
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.existing(ctx)
    }
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writable(ctx)
    }
}
impl RebindStores for PrivateMemoryStores {
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.existing(ctx)
    }
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError> {
        self.writable(ctx)
    }
}
