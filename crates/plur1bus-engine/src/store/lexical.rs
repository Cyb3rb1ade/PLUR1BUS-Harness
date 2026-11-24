//! Derived lexical terms for a physical memories table (RE-D15).
use super::{backend_error, paths, row, Store, StoreError};
use crate::text::analyzer::{analyze_de, analyze_en, ANALYZER_ID};
use arrow_array::{ArrayRef, RecordBatch, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lancedb::{
    index::{
        scalar::{FtsIndexBuilder, FullTextSearchQuery},
        Index,
    },
    query::{ExecutableQuery, QueryBase, Select},
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Duration};

const COLUMNS: [&str; 5] = ["id", "analyzer_id", "content_hash", "de", "en"];

fn params() -> FtsIndexBuilder {
    FtsIndexBuilder::default()
        .base_tokenizer("whitespace".into())
        .lower_case(false)
        .stem(false)
        .ascii_folding(false)
        .remove_stop_words(false)
        .max_token_length(None)
        .with_position(false)
}

impl Store {
    fn lexical_path(&self) -> Result<String, StoreError> {
        self.trusted()?;
        paths::assert_trusted_path(&self.path.join("_lexical.lance"))?;
        paths::assert_trusted_path(&self.path.join("lexical-state.json"))?;
        self.directory
            .lance_path()
            .to_str()
            .map(str::to_owned)
            .ok_or(StoreError::InvalidInput)
    }

    /// Build or repair on writable routes. Historical read-only routes consume available indices.
    pub(crate) fn prepare_lexical_recall(&self) -> Result<(), StoreError> {
        if self.mode == super::OpenMode::ReadWrite {
            self.ensure_text_index()?;
        }
        Ok(())
    }

    /// Reconcile derived terms with the authoritative memories version before publishing its watermark.
    pub fn ensure_text_index(&self) -> Result<(), StoreError> {
        self.writable()?;
        let path = self.lexical_path()?;
        let watermark = self.directory.lance_path().join("lexical-state.json");
        // Different leases and processes may maintain the same physical store.
        // The operating system releases this lock on process exit, including a crash.
        let name = "lexical-write.lock";
        let guard = match self.directory.open_file(name) {
            Ok(file) => file,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => match self.directory.create_file(name) {
                Ok(file) => file,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::AlreadyExists,
                }) => self.directory.open_file(name)?,
                Err(error) => return Err(error),
            },
            Err(error) => return Err(error),
        };
        guard
            .lock()
            .map_err(|error| StoreError::Io { kind: error.kind() })?;
        let exists = self.path.join("_lexical.lance").is_dir();
        let memories = self.table.clone();
        self.executor.run(async move {
            let version = memories.version().await.map_err(backend_error)?;
            let marker =
                serde_json::json!({"memoriesVersion":version,"analyzerId":ANALYZER_ID}).to_string();
            if exists && std::fs::read_to_string(&watermark).ok().as_ref() == Some(&marker) {
                return Ok(());
            }
            let db = lancedb::connect(&path)
                .read_consistency_interval(Duration::ZERO)
                .execute()
                .await
                .map_err(backend_error)?;
            let schema = Arc::new(Schema::new(
                COLUMNS
                    .map(|name| Field::new(name, DataType::Utf8, false))
                    .to_vec(),
            ));
            let table = if exists {
                db.open_table("_lexical").execute().await
            } else {
                db.create_empty_table("_lexical", schema.clone())
                    .execute()
                    .await
            }
            .map_err(backend_error)?;
            let mut old = HashMap::new();
            let mut stream = table
                .query()
                .select(Select::columns(&COLUMNS[..3]))
                .execute()
                .await
                .map_err(backend_error)?;
            while let Some(batch) = stream.try_next().await.map_err(backend_error)? {
                for value in row::json_rows(&batch)? {
                    old.insert(
                        value["id"].as_str().ok_or(StoreError::Corrupt)?.to_owned(),
                        (
                            value["analyzer_id"].as_str().unwrap_or_default().to_owned(),
                            value["content_hash"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        ),
                    );
                }
            }
            let mut stream = memories
                .query()
                .select(Select::columns(&["id", "text", "summary", "status"]))
                .execute()
                .await
                .map_err(backend_error)?;
            while let Some(batch) = stream.try_next().await.map_err(backend_error)? {
                let mut changed = Vec::new();
                for value in row::json_rows(&batch)? {
                    let id = value["id"].as_str().ok_or(StoreError::Corrupt)?;
                    let status = value["status"].as_str().unwrap_or_default();
                    if !matches!(status, "" | "active") {
                        continue;
                    }
                    let text = value["text"].as_str().unwrap_or_default();
                    let summary = value["summary"].as_str().unwrap_or_default();
                    let hash = format!(
                        "{:x}",
                        Sha256::new()
                            .chain_update(text)
                            .chain_update([0])
                            .chain_update(summary)
                            .chain_update([0])
                            .chain_update(status)
                            .finalize()
                    );
                    if old
                        .remove(id)
                        .is_some_and(|(a, h)| a == ANALYZER_ID && h == hash)
                    {
                        continue;
                    }
                    let content = format!("{text} {summary}");
                    changed.push([
                        id.to_owned(),
                        ANALYZER_ID.to_owned(),
                        hash,
                        analyze_de(&content).join(" "),
                        analyze_en(&content).join(" "),
                    ]);
                }
                if !changed.is_empty() {
                    let arrays = (0..COLUMNS.len())
                        .map(|i| {
                            Arc::new(StringArray::from_iter_values(
                                changed.iter().map(|r| r[i].as_str()),
                            )) as ArrayRef
                        })
                        .collect();
                    let batch = RecordBatch::try_new(schema.clone(), arrays)
                        .map_err(|_| StoreError::Corrupt)?;
                    let batches = RecordBatchIterator::new(vec![Ok(batch)], schema.clone());
                    let mut merge = table.merge_insert(&["id"]);
                    merge
                        .when_matched_update_all(None)
                        .when_not_matched_insert_all();
                    merge
                        .execute(Box::new(batches))
                        .await
                        .map_err(backend_error)?;
                }
            }
            let gone: Vec<_> = old.into_keys().collect();
            for chunk in gone.chunks(100) {
                let ids = chunk
                    .iter()
                    .map(|id| crate::store::filter::sql_string(id))
                    .collect::<Vec<_>>()
                    .join(",");
                table
                    .delete(&format!("id IN ({ids})"))
                    .await
                    .map_err(backend_error)?;
            }
            let indices = table.list_indices().await.map_err(backend_error)?;
            for field in ["de", "en"] {
                if !indices.iter().any(|index| index.columns == [field]) {
                    table
                        .create_index(&[field], Index::FTS(params()))
                        .execute()
                        .await
                        .map_err(backend_error)?;
                }
            }
            crate::store::atomic_write::atomic_write(&watermark, marker.as_bytes())
                .map_err(|e| StoreError::Io { kind: e.kind() })
        })
    }

    /// Search indexed and pending fragments. Callers hydrate the IDs before the row ACL.
    pub fn lexical_ids(&self, query: &str, limit: usize) -> Result<Vec<String>, StoreError> {
        let path = self.lexical_path()?;
        if limit == 0 || !self.path.join("_lexical.lance").is_dir() {
            return Ok(Vec::new());
        }
        let mut terms = analyze_de(query);
        terms.extend(analyze_en(query));
        terms.sort();
        terms.dedup();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        self.executor.run(async move {
            let db = lancedb::connect(&path)
                .read_consistency_interval(Duration::ZERO)
                .execute()
                .await
                .map_err(backend_error)?;
            let table = db
                .open_table("_lexical")
                .execute()
                .await
                .map_err(backend_error)?;
            let query = FullTextSearchQuery::new(terms.join(" "))
                .with_columns(&["de".into(), "en".into()])
                .map_err(|_| StoreError::InvalidInput)?;
            let mut stream = table
                .query()
                .select(Select::columns(&["id"]))
                .full_text_search(query)
                .limit(limit)
                .execute()
                .await
                .map_err(backend_error)?;
            let mut ids = Vec::new();
            while let Some(batch) = stream.try_next().await.map_err(backend_error)? {
                for row in row::json_rows(&batch)? {
                    ids.push(row["id"].as_str().ok_or(StoreError::Corrupt)?.to_owned());
                }
            }
            Ok(ids)
        })
    }
}
