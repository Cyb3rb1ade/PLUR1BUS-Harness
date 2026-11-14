//! An ownership-checked daily decay advances both Lance dynamics columns in one commit.
use super::{RowPatch, Store};
use crate::{
    context::RequestContext,
    contract::{MemoryRow, StoreError},
};

impl Store {
    pub(crate) fn daily_decay_candidates(
        &self,
        request: &RequestContext,
        now: i64,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        use super::super::filter::sql_string;
        let agent = sql_string(request.agent_id.as_str());
        let owner = sql_string(&request.owner_user_id);
        let workspace = sql_string(&request.workspace_key);
        self.scan_page(format!(
            "(scope IN ('agent-private', 'workspace', 'user', '') OR scope IS NULL) \
             AND agentId = {agent} AND storedBy = {agent} AND ownerUserId = {owner} \
             AND workspaceKey = {workspace} AND workspaceId = {workspace} \
             AND (status IS NULL OR status IN ('', 'active')) \
             AND (memoryClass IS NULL OR memoryClass <> 'core') AND COALESCE(neverForget, 0) = 0 \
             AND id LIKE '________-____-____-____-____________' AND COALESCE(lastDynamicsAt, 0) < {now}.0 \
             AND COALESCE(lastStrengthenedAt, 0) <= {now}.0 AND COALESCE(createdAt, 0) <= {now}.0"
        ), offset, limit)
    }

    pub(crate) fn write_daily_decay(
        &self,
        expected: &MemoryRow,
        strength: f64,
        now: i64,
    ) -> Result<usize, StoreError> {
        use super::super::filter::{sql_string, uuid};
        self.writable()?;
        if !uuid(&expected.id) || !strength.is_finite() || !(0.01..=1.).contains(&strength) {
            return Err(StoreError::InvalidInput);
        }
        let keys = [
            ("id", &expected.id),
            ("agentId", &expected.agent_id),
            ("storedBy", &expected.stored_by),
            ("ownerUserId", &expected.owner_user_id),
            ("workspaceKey", &expected.workspace_key),
            ("workspaceId", &expected.workspace_id),
        ];
        let bindings = keys
            .iter()
            .map(|(column, value)| format!("{column} = {}", sql_string(value)))
            .collect::<Vec<_>>()
            .join(" AND ");
        let scope = if expected.scope.is_empty() {
            "(scope IS NULL OR scope = '')".to_owned()
        } else {
            format!("scope = {}", sql_string(&expected.scope))
        };
        let filter = format!(
            "{bindings} AND {scope} AND (status IS NULL OR status = '' OR status = 'active') \
             AND (memoryClass IS NULL OR memoryClass <> 'core') AND COALESCE(neverForget, 0) = 0 \
             AND COALESCE(lastDynamicsAt, 0) = {} AND COALESCE(lastStrengthenedAt, 0) = {} \
             AND COALESCE(createdAt, 0) = {} AND COALESCE(memoryStrength, 1) = {} \
             AND COALESCE(halfLifeDays, 30) = {} AND versionNumber = {} AND updatedAt = {}",
            expected.last_dynamics_at,
            expected.last_strengthened_at,
            expected.created_at,
            expected.memory_strength,
            expected.half_life_days,
            expected.version_number,
            expected.updated_at,
        );
        // Lance evaluates SQL expressions against intermediate columns in map order.
        // Both replacements are constants derived from a row compared at the write.
        self.patch_where(
            filter,
            &RowPatch {
                memory_strength: Some(strength),
                last_dynamics_at: Some(now as f64),
                ..RowPatch::default()
            },
        )
    }
}
