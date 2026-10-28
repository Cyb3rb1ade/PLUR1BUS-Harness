//! Per-agent physical store handles with an idle-only soft LRU bound.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::contract::{StoreError, VectorSpaceIdentity};

use super::identity::canonical_identity;
use super::paths::assert_trusted_path;
use super::{OpenMode, Store};

struct Entry {
    store: Arc<Store>,
    used: u64,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, Entry>,
    clock: u64,
}

/// One reusable store per agent under a configured base directory.
///
/// The capacity is soft: a leased `Arc<Store>` remains cached, even when every entry is
/// leased and another agent needs a handle. Idle handles are evicted least recently used.
/// This pool only routes handles; authorization and recall fan-out belong to their callers.
pub struct StorePool {
    base: PathBuf,
    mode: OpenMode,
    expected: Option<VectorSpaceIdentity>,
    capacity: usize,
    cache: Mutex<Cache>,
}

impl StorePool {
    /// Configure a pool without creating any store or directory.
    ///
    /// A missing agent store is created only by a writable pool with an expected identity.
    /// Optional identity fields are normalized once through the canonical Node helper.
    pub fn open(
        base: &Path,
        mode: OpenMode,
        expected: Option<&VectorSpaceIdentity>,
        capacity: usize,
    ) -> Result<Self, StoreError> {
        if capacity == 0 {
            return Err(StoreError::InvalidInput);
        }
        assert_trusted_path(base)?;
        let base = if base.is_absolute() {
            base.to_owned()
        } else {
            std::env::current_dir()
                .map_err(|error| StoreError::Io { kind: error.kind() })?
                .join(base)
        };
        let expected = expected
            .map(canonical_identity)
            .transpose()?
            .map(|(identity, _, _)| identity);
        Ok(Self {
            base,
            mode,
            expected,
            capacity,
            cache: Mutex::new(Cache::default()),
        })
    }

    /// Lease the agent's existing handle, opening or creating it once when necessary.
    ///
    /// Opening and insertion share the cache mutex, so concurrent first leases cannot create
    /// different handles for the same agent. Only this user's private directory is created;
    /// a read-only lookup of an absent store performs no filesystem writes.
    pub fn get(&self, agent_id: &str) -> Result<Arc<Store>, StoreError> {
        let path = self.agent_path(agent_id)?;
        let mut cache = self.cache.lock().map_err(|_| StoreError::Unavailable)?;
        cache.clock = cache.clock.saturating_add(1);
        let used = cache.clock;
        if let Some(entry) = cache.entries.get_mut(agent_id) {
            entry.used = used;
            let store = Arc::clone(&entry.store);
            prune_idle(&mut cache, self.capacity);
            return Ok(store);
        }
        let table_path = path.join("memories.lance");
        assert_trusted_path(&table_path)?;
        let exists = match fs::symlink_metadata(&table_path) {
            Ok(metadata) if metadata.is_dir() => true,
            Ok(_) => return Err(StoreError::Corrupt),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(StoreError::Io { kind: error.kind() }),
        };
        let store = if exists {
            Store::open(&path, self.mode, self.expected.as_ref())?
        } else if self.mode == OpenMode::ReadWrite {
            let identity = self.expected.as_ref().ok_or(StoreError::Unavailable)?;
            let dimension = identity
                .dimension
                .as_u64()
                .ok_or(StoreError::InvalidInput)?;
            let dimension = usize::try_from(dimension).map_err(|_| StoreError::InvalidInput)?;
            Store::create(&path, identity, dimension)?
        } else {
            return Err(StoreError::Unavailable);
        };
        let store = Arc::new(store);
        prune_idle(&mut cache, self.capacity - 1);
        cache.entries.insert(
            agent_id.to_owned(),
            Entry {
                store: Arc::clone(&store),
                used,
            },
        );
        Ok(store)
    }

    fn agent_path(&self, agent_id: &str) -> Result<PathBuf, StoreError> {
        // Agent IDs and named namespaces have intentionally different Node grammars:
        // unlike a namespace, an agent may start with '-' or '_'.
        if agent_id.is_empty()
            || agent_id.len() > 64
            || !agent_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(StoreError::InvalidInput);
        }
        let path = self.base.join(agent_id);
        assert_trusted_path(&path)?;
        Ok(path)
    }
}

fn prune_idle(cache: &mut Cache, target: usize) {
    while cache.entries.len() > target {
        let oldest = cache
            .entries
            .iter()
            .filter(|(_, entry)| Arc::strong_count(&entry.store) == 1)
            .min_by(|(left_id, left), (right_id, right)| {
                left.used.cmp(&right.used).then(left_id.cmp(right_id))
            })
            .map(|(agent, _)| agent.clone());
        let Some(oldest) = oldest else { break };
        cache.entries.remove(&oldest);
    }
}
