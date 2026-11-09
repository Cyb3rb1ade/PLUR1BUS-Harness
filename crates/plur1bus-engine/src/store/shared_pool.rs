//! Physical workspace/user pools. Routes never grant access to individual rows.
use super::{directory::TrustedDirectory, identity::canonical_identity, paths, OpenMode, Store};
use crate::{
    context::{user_pool_key, workspace_pool_key, RequestContext},
    contract::{MemoryShareTarget, StoreError, VectorSpaceIdentity},
};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
struct Entry {
    store: Arc<Store>,
    used: u64,
}
#[derive(Default)]
struct State {
    roots: HashMap<PathBuf, Arc<TrustedDirectory>>,
    handles: HashMap<(PathBuf, bool), Entry>,
    clock: u64,
    tainted: bool,
}
/// Independent authenticated workspace/user destinations, with noncreating read leases.
/// Old target identities remain visible so sharing can select the matching retained provider.
pub struct SharedPool {
    base: PathBuf,
    identity: VectorSpaceIdentity,
    capacity: usize,
    state: Mutex<State>,
}
impl SharedPool {
    /// Lazy host configuration; no filesystem mutation or implicit legacy migration.
    pub fn open(
        base: &Path,
        identity: &VectorSpaceIdentity,
        capacity: usize,
    ) -> Result<Self, StoreError> {
        if capacity == 0 {
            return Err(StoreError::InvalidInput);
        }
        paths::assert_trusted_path(base)?;
        let base = if base.is_absolute() {
            base.to_owned()
        } else {
            std::env::current_dir()?.join(base)
        };
        let identity = canonical_identity(identity)?.0;
        let mut state = State::default();
        pin(&mut state, &base, false)?;
        Ok(Self {
            base,
            identity,
            capacity,
            state: Mutex::new(state),
        })
    }
    /// Platform/physical-root support only, never row authorization.
    pub fn supported(&self) -> bool {
        cfg!(any(target_os = "linux", target_os = "macos", windows))
            && self
                .state
                .lock()
                .is_ok_and(|mut state| check_roots(&mut state).is_ok())
    }
    /// Inspect an existing pool without creating a directory, table or provenance column.
    pub fn existing(
        &self,
        ctx: &RequestContext,
        scope: MemoryShareTarget,
    ) -> Result<Option<Arc<Store>>, StoreError> {
        self.lease(ctx, scope, false)
    }
    /// Explicit writable acquisition, adding only missing shared provenance columns.
    pub fn writable(
        &self,
        ctx: &RequestContext,
        scope: MemoryShareTarget,
    ) -> Result<Arc<Store>, StoreError> {
        self.lease(ctx, scope, true)?.ok_or(StoreError::Unavailable)
    }
    fn lease(
        &self,
        ctx: &RequestContext,
        scope: MemoryShareTarget,
        write: bool,
    ) -> Result<Option<Arc<Store>>, StoreError> {
        if !cfg!(any(target_os = "linux", target_os = "macos", windows)) {
            return Err(StoreError::Unavailable);
        }
        let (kind, binding) = match scope {
            MemoryShareTarget::Workspace => ("workspaces", ctx.workspace_key.as_str()),
            MemoryShareTarget::User => ("users", ctx.owner_user_id.as_str()),
        };
        if binding.is_empty() {
            return if write {
                Err(StoreError::InvalidInput)
            } else {
                Ok(None)
            };
        }
        let key = match scope {
            MemoryShareTarget::Workspace => workspace_pool_key(binding),
            MemoryShareTarget::User => user_pool_key(binding),
        };
        let shared = self.base.join(".plur1bus-shared");
        let parent = shared.join(kind);
        let path = parent.join(key);
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        check_roots(&mut state)?;
        let mut roots = Vec::new();
        for (index, root) in [&self.base, &shared, &parent].into_iter().enumerate() {
            let Some(root) = pin(&mut state, root, write)? else {
                return Ok(None);
            };
            if write && index < 2 {
                if let Err(error) = super::shared_policy::verify(root.path(), index == 1) {
                    state.tainted = true;
                    return Err(error);
                }
            }
            roots.push(root);
        }
        state.clock = state.clock.saturating_add(1);
        let used = state.clock;
        let cache_key = (path.clone(), write);
        if let Some(entry) = state.handles.get_mut(&cache_key) {
            entry.used = used;
            return Ok(Some(Arc::clone(&entry.store)));
        }
        paths::assert_trusted_path(&path)?;
        let table = path.join("memories.lance");
        let exists = match fs::symlink_metadata(&table) {
            Ok(m) if m.is_dir() => true,
            Ok(_) => return Err(StoreError::Corrupt),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        if !exists && !write {
            return Ok(None);
        }
        let mut store = if exists {
            if write {
                Store::open_shared_write(&path)?
            } else {
                Store::open(&path, OpenMode::ReadOnly, None)?
            }
        } else {
            let dim = self
                .identity
                .dimension
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or(StoreError::InvalidInput)?;
            Store::create(&path, &self.identity, dim)?
        };
        check_roots(&mut state)?;
        store.bind_pool_roots(roots)?;
        if write {
            store.ensure_shared_columns()?;
            // A fresh reader sees the migrated schema; earlier leases retain their own lifetime.
            state.handles.remove(&(path.clone(), false));
        }
        check_roots(&mut state)?;
        let store = Arc::new(store);
        while state.handles.len() >= self.capacity {
            let victim = state
                .handles
                .iter()
                .filter(|(_, e)| Arc::strong_count(&e.store) == 1)
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            let Some(victim) = victim else {
                break;
            };
            state.handles.remove(&victim);
        }
        state.handles.insert(
            cache_key,
            Entry {
                store: Arc::clone(&store),
                used,
            },
        );
        Ok(Some(store))
    }
}
fn check_roots(state: &mut State) -> Result<(), StoreError> {
    if state.tainted {
        return Err(StoreError::UntrustedPath);
    }
    for root in state.roots.values() {
        if let Err(error) = root.assert_unchanged() {
            state.tainted = true;
            return Err(error);
        }
    }
    Ok(())
}
fn pin(
    state: &mut State,
    path: &Path,
    create: bool,
) -> Result<Option<Arc<TrustedDirectory>>, StoreError> {
    check_roots(state)?;
    if let Some(root) = state.roots.get(path) {
        return Ok(Some(Arc::clone(root)));
    }
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        Ok(_) => {
            state.tainted = true;
            return Err(StoreError::UntrustedPath);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Ok(None);
            }
            paths::secure_dir(path)?;
        }
        Err(e) => return Err(e.into()),
    }
    // Existing directories are verified, never chmod-repaired by a write lease.
    if create {
        paths::secure_dir(path)?;
    }
    let root = Arc::new(TrustedDirectory::open(path)?);
    state.roots.insert(path.to_owned(), Arc::clone(&root));
    check_roots(state)?;
    Ok(Some(root))
}
