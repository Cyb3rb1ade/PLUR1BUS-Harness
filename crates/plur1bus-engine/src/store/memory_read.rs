//! Bounded card acquisition for foreground list operations, matching the Node SQL plan.
use super::{backend_error, Store};
use crate::{
    contract::{MemoryRow, StoreError},
    store::{row, shared_row::MemoryRecord},
};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase, Select};

impl Store {
    /// Acquire a caller-bounded live prefix before request ACL filtering.
    /// Time queries first project timestamps so newest-first selection never truncates
    /// by physical storage order. Topic queries retain Node's acquisition-before-epistemic
    /// filtering behavior. No bi-temporal validAt predicate is applied by MemoryOps.
    pub fn memory_candidates(
        &self,
        vector: Option<&[f32]>,
        window: Option<(f64, f64)>,
        limit: usize,
        now: i64,
    ) -> Result<Vec<(MemoryRow, Option<f64>)>, StoreError> {
        self.memory_records(vector, window, limit, now)
            .map(|records| {
                records
                    .into_iter()
                    .map(|(record, score)| (record.row, score))
                    .collect()
            })
    }
    /// Same acquisition with shared-copy provenance retained from each row snapshot.
    pub fn memory_records(
        &self,
        vector: Option<&[f32]>,
        window: Option<(f64, f64)>,
        limit: usize,
        now: i64,
    ) -> Result<Vec<(MemoryRecord, Option<f64>)>, StoreError> {
        self.trusted()?;
        let limit = limit.max(1);
        let table = self.table.clone();
        let lifecycle = format!("(status = 'active' OR status IS NULL) AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > {now})");
        if let Some(vector) = vector {
            self.validate_vector(vector)?;
            let vector = vector.to_vec();
            return self.executor.run(async move {
                let batches = table
                    .vector_search(vector)
                    .map_err(backend_error)?
                    .only_if(lifecycle)
                    .limit(limit)
                    .execute()
                    .await
                    .map_err(backend_error)?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(backend_error)?;
                let mut output = Vec::new();
                for batch in batches {
                    for mut value in row::json_rows(&batch)? {
                        let distance = value
                            .as_object_mut()
                            .and_then(|row| row.remove("_distance"))
                            .and_then(|v| v.as_f64());
                        let score = row::distance_to_score(distance);
                        output.push((MemoryRecord::decode(value)?, Some(score)));
                    }
                }
                Ok(output)
            });
        }
        let (since, until) = window.ok_or(StoreError::InvalidInput)?;
        if !since.is_finite() || !until.is_finite() {
            return Err(StoreError::InvalidInput);
        }
        let epistemic = if self.schema.field_with_name("epistemicStatus").is_ok() {
            " AND (epistemicStatus IS NULL OR epistemicStatus != 'invalidated')"
        } else {
            ""
        };
        let predicate = format!(
            "({lifecycle}){epistemic} AND createdAt >= {} AND createdAt <= {}",
            since.floor(),
            until.floor()
        );
        self.executor.run(async move {
            let batches = table
                .query()
                .only_if(predicate.clone())
                .select(Select::columns(&["createdAt"]))
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            let mut times = Vec::new();
            for batch in batches {
                for value in row::json_rows(&batch)? {
                    times.push(value["createdAt"].as_f64().ok_or(StoreError::Corrupt)?);
                }
            }
            if times.is_empty() {
                return Ok(Vec::new());
            }
            times.sort_by(|a, b| b.total_cmp(a));
            let boundary = times[limit.min(times.len()) - 1];
            let predicate = if times.len() > limit {
                format!("{predicate} AND createdAt >= {}", boundary.floor())
            } else {
                predicate
            };
            let batches = table
                .query()
                .only_if(predicate)
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
            rows.sort_by(|a, b| {
                b.row
                    .created_at
                    .as_f64()
                    .unwrap_or(0.)
                    .total_cmp(&a.row.created_at.as_f64().unwrap_or(0.))
            });
            rows.truncate(limit);
            Ok(rows.into_iter().map(|row| (row, None)).collect())
        })
    }
}
