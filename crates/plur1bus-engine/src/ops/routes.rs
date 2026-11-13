//! Explicit composition of private namespace routes and authenticated shared pools.
use super::{
    import::ImportStores,
    memory::{ReadSource, ReadStores, SourceKind},
    private_routes::PrivateMemoryStores,
    rebind::RebindStores,
    sharing::SharedStores,
    unimport::UnimportStores,
    write::MutationStores,
};
use crate::{
    context::RequestContext,
    contract::{MemoryShareTarget, StoreError},
    store::{shared_pool::SharedPool, Store},
};
use std::sync::Arc;
/// Real memory routing ports. The operation context and row ACL remain authoritative.
pub struct MemoryStores {
    private: PrivateMemoryStores,
    shared: Arc<SharedPool>,
}
impl MemoryStores {
    /// Compose configured pools without any filesystem access or capability advertisement.
    pub fn new(private: PrivateMemoryStores, shared: Arc<SharedPool>) -> Self {
        Self { private, shared }
    }

    pub(crate) fn check_shared_support(&self) -> Result<(), StoreError> {
        self.shared.check_support()
    }
}
impl ReadStores for MemoryStores {
    fn sources(&self, ctx: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        let mut sources = self.private.sources(ctx)?;
        for (scope, kind) in [
            (MemoryShareTarget::Workspace, SourceKind::Workspace),
            (MemoryShareTarget::User, SourceKind::User),
        ] {
            if let Some(store) = self.shared.existing(ctx, scope)? {
                sources.push(ReadSource {
                    store,
                    kind,
                    optional: true,
                });
            }
        }
        Ok(sources)
    }
}
impl MutationStores for MemoryStores {
    fn existing_private(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        self.private.existing_private(ctx)
    }
}
impl ImportStores for MemoryStores {
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        ImportStores::existing(&self.private, ctx)
    }
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError> {
        ImportStores::writable(&self.private, ctx)
    }
}
impl RebindStores for MemoryStores {
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        RebindStores::existing(&self.private, ctx)
    }
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError> {
        RebindStores::writable(&self.private, ctx)
    }
}
impl UnimportStores for MemoryStores {
    fn existing(&self, ctx: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        ImportStores::existing(&self.private, ctx)
    }
    fn writable(&self, ctx: &RequestContext) -> Result<Arc<Store>, StoreError> {
        ImportStores::writable(&self.private, ctx)
    }
    fn shared_pools(&self, ctx: &RequestContext) -> Result<Vec<Arc<Store>>, StoreError> {
        [MemoryShareTarget::Workspace, MemoryShareTarget::User]
            .into_iter()
            .map(|scope| self.shared.existing(ctx, scope))
            .collect::<Result<Vec<_>, _>>()
            .map(|stores| stores.into_iter().flatten().collect())
    }
}
impl SharedStores for MemoryStores {
    fn supported(&self) -> bool {
        self.shared.supported()
    }
    fn unsupported_reason(&self) -> &str {
        if cfg!(any(target_os = "linux", target_os = "macos", windows)) {
            "unsafe-root"
        } else {
            "platform"
        }
    }
    fn target(
        &self,
        ctx: &RequestContext,
        scope: MemoryShareTarget,
    ) -> Result<Arc<Store>, StoreError> {
        self.shared.writable(ctx, scope)
    }
}
