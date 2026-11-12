//! Typed envelope for Node's four additional shared-pool columns.
use crate::{
    contract::{MemoryRow, StoreError},
    text::js::js_trim,
};
use serde::{Deserialize, Serialize};
/// Exact append order and names recorded from Node ensureSharedMemoryColumns.
pub(crate) const COLUMNS: [&str; 4] = [
    "sourceMemoryId",
    "sourceAgentId",
    "shareIdempotencyKey",
    "shareProvenance",
];
/// Share provenance is physical metadata, not an extension of the frozen RPC MemoryRow.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareMetadata {
    /// Original private card.
    pub source_memory_id: String,
    /// Agent owning that original.
    pub source_agent_id: String,
    /// Node SHA-256 share idempotency key.
    pub share_idempotency_key: String,
    /// Exact Node JSON string; preserved without rewriting its member order.
    pub share_provenance: String,
}
/// One physical row plus the optional shared-pool provenance.
#[derive(Clone, Debug)]
pub struct MemoryRecord {
    /// Frozen common row fields.
    pub row: MemoryRow,
    /// Present only for a table with the four sharing columns.
    pub sharing: Option<ShareMetadata>,
}
impl MemoryRecord {
    /// Node's canonical origin: original source first, then row owner and id.
    #[must_use]
    pub fn origin(&self) -> Option<(String, String)> {
        if let Some(shared) = &self.sharing {
            let agent = js_trim(&shared.source_agent_id);
            let id = js_trim(&shared.source_memory_id);
            if !agent.is_empty() && !id.is_empty() {
                return Some((agent.to_owned(), id.to_owned()));
            }
        }
        let agent = js_trim(if self.row.agent_id.is_empty() {
            &self.row.stored_by
        } else {
            &self.row.agent_id
        });
        let id = js_trim(&self.row.id);
        (!agent.is_empty() && !id.is_empty()).then(|| (agent.to_owned(), id.to_owned()))
    }
    pub(crate) fn decode(value: serde_json::Value) -> Result<Self, StoreError> {
        let sharing = if COLUMNS.iter().any(|column| value.get(*column).is_some()) {
            let text = |key| value[key].as_str().unwrap_or("").to_owned();
            Some(ShareMetadata {
                source_memory_id: text("sourceMemoryId"),
                source_agent_id: text("sourceAgentId"),
                share_idempotency_key: text("shareIdempotencyKey"),
                share_provenance: text("shareProvenance"),
            })
        } else {
            None
        };
        Ok(Self {
            row: super::row::decode_row(value)?,
            sharing,
        })
    }
}
