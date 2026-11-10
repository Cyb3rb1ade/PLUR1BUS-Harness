//! Committed-deletion mask for every recall candidate source (RE-D153).
//!
//! The pin's recall consults no tombstone registry (`lib/recall-pipeline.js`
//! filters candidates only by lifecycle and ACL), so a card forgotten from the
//! active writer returns through a physically retained legacy copy. The native
//! forget keeps such copies (RE-D142) and the memory readers mask them; recall
//! applies the same registry lookup as `memory.show`/`list`.

use std::path::{Path, PathBuf};

use crate::contract::{MemoryRow, StoreError};
use crate::store::tombstone::TombstoneRegistry;

/// The per-agent registry beside the process store base; nothing is created or repaired.
#[derive(Clone, Debug)]
pub struct TombstoneMask {
    base: PathBuf,
}

impl TombstoneMask {
    /// Bind the same store base the memory readers use.
    #[must_use]
    pub fn new(base: &Path) -> Self {
        Self {
            base: base.to_owned(),
        }
    }

    /// Whether the row owner's registry holds a committed deletion of this id.
    /// A row without an owner binding cannot have been forgotten by its owner.
    ///
    /// # Errors
    ///
    /// An unreadable or untrusted registry is an error, never an unmasked read.
    pub fn masks(&self, row: &MemoryRow) -> Result<bool, StoreError> {
        // The owner exactly as `MemoryReader::source_visible` resolves it.
        let owner = if row.agent_id.is_empty() {
            &row.stored_by
        } else {
            &row.agent_id
        };
        if owner.is_empty() {
            return Ok(false);
        }
        Ok(TombstoneRegistry::new(&self.base, owner)?
            .find_by_origin(&row.id, false)?
            .is_some())
    }
}
