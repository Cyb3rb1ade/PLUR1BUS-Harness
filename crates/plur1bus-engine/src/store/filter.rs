//! Typed predicates for the persisted memory columns.
use crate::contract::MemoryScope;
/// Optional predicates, combined with AND; an empty filter includes every row.
#[derive(Clone, Debug, Default)]
pub struct RowFilter {
    /// Owning agent.
    pub agent_id: Option<String>,
    /// Access scope.
    pub scope: Option<MemoryScope>,
    /// Persisted lifecycle status.
    pub status: Option<String>,
    /// Workspace principal.
    pub workspace_id: Option<String>,
    /// User principal.
    pub owner_user_id: Option<String>,
    /// Memory/reminder discriminator.
    pub memory_kind: Option<String>,
    /// Validity timestamp in milliseconds.
    pub valid_at: Option<i64>,
    /// Restrict to these memory IDs.
    pub ids: Option<Vec<String>>,
    /// Inclusive creation lower bound.
    pub since: Option<i64>,
    /// Inclusive creation upper bound.
    pub until: Option<i64>,
}
