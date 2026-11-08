//! Explicit shared-column migration and writes; ordinary MemoryRow upserts cannot erase provenance.
use super::{backend_error, Store};
use crate::{
    contract::{StoreError, VectorSpaceIdentity},
    store::{
        row,
        shared_row::{MemoryRecord, ShareMetadata, COLUMNS},
    },
};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use std::path::Path;
impl Store {
    /// Create a new pool and add the exact four Node provenance columns before leasing it.
    pub fn create_shared(
        path: &Path,
        identity: &VectorSpaceIdentity,
        dim: usize,
    ) -> Result<Self, StoreError> {
        let mut store = Self::create(path, identity, dim)?;
        store.ensure_shared_columns()?;
        Ok(store)
    }
    /// Migrate an exclusively owned writable handle. Read opens never migrate columns.
    pub fn ensure_shared_columns(&mut self) -> Result<(), StoreError> {
        self.writable()?;
        if COLUMNS
            .iter()
            .all(|name| self.schema.field_with_name(name).is_ok())
        {
            return Ok(());
        }
        let table = self.table.clone();
        let schema = self.executor.run(async move {
            let expressions = COLUMNS
                .iter()
                .map(|name| {
                    (
                        (*name).to_owned(),
                        if *name == "shareProvenance" {
                            "'{}'"
                        } else {
                            "''"
                        }
                        .to_owned(),
                    )
                })
                .collect();
            table
                .add_columns(
                    lancedb::table::NewColumnTransform::SqlExpressions(expressions),
                    None,
                )
                .await
                .map_err(backend_error)?;
            table.schema().await.map_err(backend_error)
        })?;
        let dim = match self
            .schema
            .field_with_name("vector")
            .map_err(|_| StoreError::Corrupt)?
            .data_type()
        {
            arrow_schema::DataType::FixedSizeList(_, dim) => *dim as usize,
            _ => return Err(StoreError::Corrupt),
        };
        row::validate_schema(&schema, dim)?;
        self.schema = schema;
        Ok(())
    }
    /// Read the common fields and share provenance together from the same Lance snapshot.
    pub fn get_record(&self, id: &str) -> Result<Option<MemoryRecord>, StoreError> {
        self.trusted()?;
        let table = self.table.clone();
        let filter = format!("id = {}", crate::store::filter::sql_string(id));
        self.executor.run(async move {
            let batches = table
                .query()
                .only_if(filter)
                .limit(1)
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            for batch in batches {
                if let Some(value) = row::json_rows(&batch)?.into_iter().next() {
                    return MemoryRecord::decode(value).map(Some);
                }
            }
            Ok(None)
        })
    }
    /// Look up at most two active copies so duplicate idempotency keys fail closed.
    pub fn shared_by_key(&self, key: &str) -> Result<Vec<MemoryRecord>, StoreError> {
        self.trusted()?;
        if self.schema.field_with_name("shareIdempotencyKey").is_err() {
            return Err(StoreError::Corrupt);
        }
        let table = self.table.clone();
        let predicate = format!(
            "shareIdempotencyKey = {} AND status = 'active'",
            crate::store::filter::sql_string(key)
        );
        self.executor.run(async move {
            let batches = table
                .query()
                .only_if(predicate)
                .limit(2)
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            let mut rows = Vec::new();
            for batch in batches {
                for value in row::json_rows(&batch)? {
                    rows.push(MemoryRecord::decode(value)?);
                }
            }
            Ok(rows)
        })
    }
    /// Any live shared copy prevents rollback of its origin, regardless of deleted-row prefixes.
    /// Filter before limiting: an old tombstoned copy cannot hide a later active one.
    pub fn has_live_shared_origin(&self, id: &str, agent: &str) -> Result<bool, StoreError> {
        self.trusted()?;
        if self.schema.field_with_name("sourceMemoryId").is_err() {
            return Ok(false);
        }
        if self.schema.field_with_name("sourceAgentId").is_err() {
            return Err(StoreError::Corrupt);
        }
        let table = self.table.clone();
        let predicate=format!("sourceMemoryId = {} AND sourceAgentId = {} AND (status = 'active' OR status = '' OR status IS NULL)",crate::store::filter::sql_string(id),crate::store::filter::sql_string(agent));
        self.executor.run(async move {
            let rows = table
                .query()
                .only_if(predicate)
                .limit(1)
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            Ok(rows.iter().any(|batch| batch.num_rows() > 0))
        })
    }
    /// Shared writes retain source provenance and recheck the original's tombstone registry.
    /// The registry root is the engine's configured base, never the physical shared-pool directory.
    pub fn upsert_shared(
        &self,
        rows: &[(crate::contract::MemoryRow, ShareMetadata)],
        registry_base: &Path,
    ) -> Result<(), StoreError> {
        self.writable()?;
        if !COLUMNS
            .iter()
            .all(|name| self.schema.field_with_name(name).is_ok())
        {
            return Err(StoreError::InvalidInput);
        }
        if rows.is_empty() {
            return Ok(());
        }
        let mut values = Vec::new();
        let mut plain = Vec::new();
        for (row, sharing) in rows {
            if !matches!(row.scope.as_str(), "workspace" | "user")
                || sharing.source_memory_id.is_empty()
                || sharing.source_agent_id.is_empty()
                || row.agent_id != sharing.source_agent_id
                || row.stored_by != sharing.source_agent_id
            {
                return Err(StoreError::InvalidInput);
            }
            self.validate_vector(&row.vector)?;
            let registry = crate::store::tombstone::TombstoneRegistry::new(
                registry_base,
                &sharing.source_agent_id,
            )
            .map_err(|_| StoreError::TombstoneBlocked)?;
            if registry
                .find_by_origin(&sharing.source_memory_id, false)
                .map_err(|_| StoreError::TombstoneBlocked)?
                .is_some()
            {
                return Err(StoreError::TombstoneBlocked);
            }
            crate::store::tombstone::assert_card_write_allowed(registry_base, row)?;
            let mut value = serde_json::to_value(row).map_err(|_| StoreError::Corrupt)?;
            let metadata = serde_json::to_value(sharing).map_err(|_| StoreError::Corrupt)?;
            value
                .as_object_mut()
                .ok_or(StoreError::Corrupt)?
                .extend(metadata.as_object().ok_or(StoreError::Corrupt)?.clone());
            plain.push(row.clone());
            values.push(value);
        }
        let batch = row::values_to_batch(&plain, &values, self.schema.clone())?;
        let table = self.table.clone();
        let schema = self.schema.clone();
        self.executor.run(async move {
            let batches = arrow_array::RecordBatchIterator::new(vec![Ok(batch)], schema);
            let mut merge = table.merge_insert(&["id"]);
            merge
                .when_matched_update_all(None)
                .when_not_matched_insert_all();
            merge
                .execute(Box::new(batches))
                .await
                .map_err(backend_error)?;
            Ok(())
        })
    }
}
