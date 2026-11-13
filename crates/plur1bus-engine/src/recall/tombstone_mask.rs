//! Deletion mask for every recall candidate source (RE-D153).
//!
//! The pin's recall consults no tombstone registry (`lib/recall-pipeline.js`
//! filters candidates only by lifecycle and ACL), so a card forgotten from the
//! active writer returns through a physically retained legacy copy. The native
//! forget keeps such copies (RE-D142); recall masks them with the same predicate
//! as the warm path: a committed deletion or a still-interrupted attempt.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use crate::contract::{MemoryRow, StoreError};
use crate::store::tombstone::TombstoneRegistry;

type Resolved = Result<Arc<HashSet<String>>, StoreError>;

/// The per-agent registries beside the process store base; nothing is created or repaired.
/// One mask serves one recall call: each owner's registry is resolved once and reused,
/// so every candidate source of that call sees the same snapshot.
#[derive(Clone, Debug)]
pub struct TombstoneMask {
    base: PathBuf,
    resolved: Arc<Mutex<HashMap<String, Resolved>>>,
}

impl TombstoneMask {
    /// Bind the same store base the memory readers use.
    #[must_use]
    pub fn new(base: &Path) -> Self {
        Self {
            base: base.to_owned(),
            resolved: Arc::default(),
        }
    }

    /// Whether the row owner's registry blocks this id: a committed deletion, or an
    /// interrupted attempt not yet reconciled by S5 (the warm path's predicate).
    /// A row without an owner binding cannot have been forgotten by its owner.
    ///
    /// # Errors
    ///
    /// An unreadable or untrusted registry is an error, never an unmasked read.
    pub fn masks(&self, row: &MemoryRow) -> Result<bool, StoreError> {
        self.masks_id(&row.id, &row.agent_id, &row.stored_by)
    }

    /// The same check over a selected entry's projected `id`, `agentId` and `storedBy`.
    ///
    /// # Errors
    ///
    /// As [`Self::masks`].
    pub fn masks_entry(&self, entry: &serde_json::Value) -> Result<bool, StoreError> {
        let field = |name: &str| entry[name].as_str().unwrap_or_default();
        self.masks_id(field("id"), field("agentId"), field("storedBy"))
    }

    /// A mask over the same base with nothing resolved yet: a second, fresh snapshot.
    #[must_use]
    pub fn refreshed(&self) -> Self {
        Self::new(&self.base)
    }

    pub(crate) fn base(&self) -> &Path {
        &self.base
    }

    fn masks_id(&self, id: &str, agent_id: &str, stored_by: &str) -> Result<bool, StoreError> {
        // The owner exactly as `MemoryReader::source_visible` resolves it.
        let owner = if agent_id.is_empty() {
            stored_by
        } else {
            agent_id
        };
        if owner.is_empty() {
            return Ok(false);
        }
        Ok(self.blocked(owner)?.contains(id))
    }

    fn blocked(&self, owner: &str) -> Resolved {
        let mut resolved = self.resolved.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(known) = resolved.get(owner) {
            return known.clone();
        }
        let fresh = TombstoneRegistry::new(&self.base, owner)
            .and_then(|registry| registry.recall_blocked_origins())
            .map(Arc::new);
        resolved.insert(owner.to_owned(), fresh.clone());
        fresh
    }
}
