//! Read copied tables without schema validation, migrations, metadata writes or vector normalization.
use super::{backend_error, Executor};
use crate::{
    contract::{Cancel, StoreError},
    store::{directory::TrustedDirectory, paths::assert_trusted_path, row},
    text::js::js_trim,
};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase, Select};
use std::{path::Path, time::Duration};

/// A raw persisted vector and its nonempty trimmed passage.
#[derive(Clone, Debug)]
pub struct ProbeRow {
    /// Stored passage, with Node's whitespace trimming.
    pub text: String,
    /// Persisted components widened for the Node cosine calculation.
    pub vector: Vec<f64>,
}
/// Nonempty finite components with positive squared norm, as in the Node probe.
pub fn valid_vector(vector: &[f64]) -> bool {
    !vector.is_empty()
        && vector.iter().all(|v| v.is_finite())
        && vector.iter().map(|v| v * v).sum::<f64>() > 0.
}
/// Read at most sixteen valid rows in batches of two hundred, retaining legacy status fallback.
/// The held directory is checked before and after the read; no create/open-for-write API is used.
pub fn read(path: &Path, cancel: &Cancel) -> Result<Vec<ProbeRow>, StoreError> {
    assert_trusted_path(path)?;
    assert_trusted_path(&path.join("memories.lance"))?;
    let directory = TrustedDirectory::open(path)?;
    let uri = directory
        .lance_path()
        .to_str()
        .ok_or(StoreError::InvalidInput)?
        .to_owned();
    let executor = Executor::new()?;
    let cancel = cancel.clone();
    let rows = executor.run(async move {
        let connection = lancedb::connect(&uri)
            .read_consistency_interval(Duration::ZERO)
            .execute()
            .await
            .map_err(backend_error)?;
        let table = connection
            .open_table("memories")
            .execute()
            .await
            .map_err(backend_error)?;
        let mut rows = Vec::new();
        let mut offset = 0;
        let mut with_status = true;
        while rows.len() < 16 {
            if cancel.is_cancelled() {
                return Err(StoreError::Unavailable);
            }
            let mut query = table
                .query()
                .select(Select::columns(&["text", "vector"]))
                .limit(200)
                .offset(offset);
            if with_status {
                query = query.only_if("status IS NULL OR status = 'active' OR status = ''");
            }
            let result = async { query.execute().await?.try_collect::<Vec<_>>().await }.await;
            let batches = match result {
                Ok(batches) => batches,
                Err(_) if with_status => {
                    with_status = false;
                    offset = 0;
                    continue;
                }
                Err(_) => break,
            };
            let mut count = 0;
            for batch in batches {
                count += batch.num_rows();
                for row in row::json_rows(&batch)? {
                    let text = js_trim(row["text"].as_str().unwrap_or(""));
                    let Some(vector) = row["vector"]
                        .as_array()
                        .and_then(|v| v.iter().map(|v| v.as_f64()).collect::<Option<Vec<_>>>())
                    else {
                        continue;
                    };
                    if !text.is_empty() && valid_vector(&vector) {
                        rows.push(ProbeRow {
                            text: text.to_owned(),
                            vector,
                        });
                        if rows.len() == 16 {
                            break;
                        }
                    }
                }
                if rows.len() == 16 {
                    break;
                }
            }
            if count < 200 {
                break;
            }
            offset += count;
        }
        Ok(rows)
    })?;
    directory.assert_unchanged()?;
    Ok(rows)
}
