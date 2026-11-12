//! Bounded private nearest-candidate projection; no full text/vector table materialization.
use super::*;
use lancedb::query::Select;
use serde::Deserialize;
#[derive(Deserialize)]
pub(crate) struct NormalCandidateHit {
    pub id: String,
    pub vector: Vec<f32>,
    #[serde(rename = "_distance")]
    pub distance: f32,
}
impl Store {
    /// Fixed original bindings precede nearest-row limits. Only IDs/vectors/distance are read.
    pub(crate) fn search_private_normal_candidates(
        &self,
        vector: &[f32],
        limit: usize,
        agent: &str,
        owner: &str,
        workspace: &str,
    ) -> Result<Vec<NormalCandidateHit>, StoreError> {
        let max =
            (64 * 1024 * 1024 / (vector.len().saturating_mul(4).saturating_add(128))).min(50_000);
        if limit == 0 || limit > max {
            return Err(StoreError::InvalidInput);
        }
        self.trusted()?;
        self.validate_vector(vector)?;
        let quote = super::super::filter::sql_string;
        let filter=format!("{} AND agentId = {} AND storedBy = {} AND scope = 'agent-private' AND ownerUserId = {} AND workspaceKey = {}",super::super::filter::CAPTURE_DUPLICATE_FILTER,quote(agent),quote(agent),quote(owner),quote(workspace));
        let table = self.table.clone();
        let vector = vector.to_vec();
        self.executor.run(async move {
            let batches = table
                .vector_search(vector)
                .map_err(backend_error)?
                .only_if(filter)
                .select(Select::columns(&["id", "vector"]))
                .limit(limit)
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            let mut result = Vec::new();
            for batch in batches {
                for value in row::json_rows(&batch)? {
                    let hit: NormalCandidateHit =
                        serde_json::from_value(value).map_err(|_| StoreError::Corrupt)?;
                    if hit.id.len() > 128
                        || !hit.distance.is_finite()
                        || hit.distance < 0.
                        || hit.vector.iter().any(|v| !v.is_finite())
                    {
                        return Err(StoreError::Corrupt);
                    }
                    result.push(hit);
                }
            }
            Ok(result)
        })
    }
}
