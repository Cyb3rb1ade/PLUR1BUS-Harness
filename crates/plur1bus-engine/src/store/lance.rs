//! Synchronous store boundary over one dedicated Tokio runtime per store.
use super::{
    identity::canonical_identity, paths, row, schema_version, RowFilter, RowPatch, Scored,
    StoreSchemaVersion,
};
use crate::contract::{MemoryRow, StoreError, VectorSpaceIdentity};
use arrow_schema::SchemaRef;
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Whether an opened handle permits mutations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenMode {
    /// Inspect only.
    ReadOnly,
    /// Permit commits.
    ReadWrite,
}
/// The recorded vector-space identity compared with the requested one.
#[derive(Clone, Debug)]
pub enum IdentityStatus {
    /// A validated recorded identity.
    Verified,
    /// No identity table exists.
    Missing,
    /// The recorded identity differs from the request.
    Mismatch {
        /// The identity found on disk.
        found: Box<VectorSpaceIdentity>,
    },
}

type Work = Box<dyn FnOnce(&tokio::runtime::Runtime) + Send>;
struct Executor {
    sender: Option<mpsc::Sender<Work>>,
    thread: Option<JoinHandle<()>>,
}
impl Executor {
    fn new() -> Result<Self, StoreError> {
        let (sender, receiver) = mpsc::channel::<Work>();
        let (ready, result) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("engine-store".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => {
                        let _ = ready.send(Ok(()));
                        for work in receiver {
                            work(&runtime);
                        }
                    }
                    Err(error) => {
                        let _ = ready.send(Err(StoreError::Io { kind: error.kind() }));
                    }
                }
            })
            .map_err(|error| StoreError::Io { kind: error.kind() })?;
        result.recv().map_err(|_| StoreError::Unavailable)??;
        Ok(Self {
            sender: Some(sender),
            thread: Some(thread),
        })
    }
    fn run<F, T>(&self, future: F) -> Result<T, StoreError>
    where
        F: Future<Output = Result<T, StoreError>> + Send + 'static,
        T: Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .as_ref()
            .ok_or(StoreError::Unavailable)?
            .send(Box::new(move |runtime| {
                let _ = sender.send(runtime.block_on(future));
            }))
            .map_err(|_| StoreError::Unavailable)?;
        receiver.recv().map_err(|_| StoreError::Unavailable)?
    }
}
impl Drop for Executor {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A physical `memories` table, its metadata and its runtime boundary.
pub struct Store {
    path: PathBuf,
    table: lancedb::Table,
    identity: Option<VectorSpaceIdentity>,
    status: IdentityStatus,
    schema_version: StoreSchemaVersion,
    schema: SchemaRef,
    identity_schema: Option<SchemaRef>,
    mode: OpenMode,
    executor: Executor,
    directory: super::directory::TrustedDirectory,
}
impl Store {
    /// Open an existing physical store without migrating its schema.
    pub fn open(
        path: &Path,
        mode: OpenMode,
        expected: Option<&VectorSpaceIdentity>,
    ) -> Result<Self, StoreError> {
        Self::open_with_executor(path, mode, expected, Executor::new()?)
    }
    fn open_with_executor(
        path: &Path,
        mode: OpenMode,
        expected: Option<&VectorSpaceIdentity>,
        executor: Executor,
    ) -> Result<Self, StoreError> {
        paths::assert_trusted_path(path)?;
        paths::assert_trusted_path(&path.join("memories.lance"))?;
        paths::assert_trusted_path(&path.join("_embedding_identity.lance"))?;
        if !path.is_dir() {
            return Err(StoreError::Unavailable);
        }
        let path = path
            .canonicalize()
            .map_err(|error| StoreError::Io { kind: error.kind() })?;
        let directory = super::directory::TrustedDirectory::open(&path)?;
        let path_text = directory
            .lance_path()
            .to_str()
            .ok_or(StoreError::InvalidInput)?
            .to_owned();
        let (table, identity, schema, identity_schema) = executor.run(async move {
            let connection = lancedb::connect(&path_text)
                .read_consistency_interval(Duration::ZERO)
                .execute()
                .await
                .map_err(backend_error)?;
            let table = connection
                .open_table("memories")
                .execute()
                .await
                .map_err(backend_error)?;
            let schema = table.schema().await.map_err(backend_error)?;
            let names = connection
                .table_names()
                .execute()
                .await
                .map_err(backend_error)?;
            let (identity, identity_schema) =
                if names.iter().any(|name| name == "_embedding_identity") {
                    let metadata = connection
                        .open_table("_embedding_identity")
                        .execute()
                        .await
                        .map_err(backend_error)?;
                    let identity_schema = metadata.schema().await.map_err(backend_error)?;
                    let batches = metadata
                        .query()
                        .limit(2)
                        .execute()
                        .await
                        .map_err(backend_error)?
                        .try_collect::<Vec<_>>()
                        .await
                        .map_err(backend_error)?;
                    let records = batches
                        .iter()
                        .map(row::json_rows)
                        .collect::<Result<Vec<_>, _>>()?
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>();
                    if records.len() != 1 {
                        return Err(StoreError::Corrupt);
                    }
                    let text = records[0]["identity"].as_str().ok_or(StoreError::Corrupt)?;
                    let identity: VectorSpaceIdentity =
                        serde_json::from_str(text).map_err(|_| StoreError::Corrupt)?;
                    let (identity, _, _) =
                        canonical_identity(&identity).map_err(|_| StoreError::Corrupt)?;
                    (Some(identity), Some(identity_schema))
                } else {
                    (None, None)
                };
            Ok((table, identity, schema, identity_schema))
        })?;
        let status = match (&identity, expected) {
            (Some(found), Some(expected))
                if super::identity::identity_id(found)?
                    != super::identity::identity_id(expected)? =>
            {
                IdentityStatus::Mismatch {
                    found: Box::new(found.clone()),
                }
            }
            (Some(_), _) => IdentityStatus::Verified,
            (None, _) => IdentityStatus::Missing,
        };
        if mode == OpenMode::ReadWrite && matches!(status, IdentityStatus::Mismatch { .. }) {
            return Err(StoreError::IdentityMismatch);
        }
        let dim = match schema
            .field_with_name("vector")
            .map_err(|_| StoreError::Corrupt)?
            .data_type()
        {
            arrow_schema::DataType::FixedSizeList(_, dim) => *dim as usize,
            _ => return Err(StoreError::Corrupt),
        };
        row::validate_schema(&schema, dim)?;
        if let Some(identity) = &identity {
            if identity.dimension.as_u64() != Some(dim as u64) {
                return Err(StoreError::Corrupt);
            }
        }
        Ok(Self {
            path: path.clone(),
            table,
            identity,
            status,
            schema_version: schema_version::read(&path)?,
            schema,
            identity_schema,
            mode,
            executor,
            directory,
        })
    }

    /// Create a new physical agent store using the pinned Node SDK's default table options.
    pub fn create(
        path: &Path,
        identity: &VectorSpaceIdentity,
        dim: usize,
    ) -> Result<Self, StoreError> {
        let (identity, json, id) = canonical_identity(identity)?;
        if identity.dimension.as_u64() != Some(dim as u64) {
            return Err(StoreError::InvalidInput);
        }
        paths::assert_trusted_path(path)?;
        if path.join("memories.lance").exists() {
            return Err(StoreError::InvalidInput);
        }
        let base = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or(StoreError::InvalidInput)?;
        schema_version::initialize_base(
            base,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            env!("CARGO_PKG_VERSION"),
        )?;
        paths::secure_dir(path)?;
        let schema = row::arrow_schema(dim)?;
        let directory = super::directory::TrustedDirectory::open(path)?;
        let path_text = directory
            .lance_path()
            .to_str()
            .ok_or(StoreError::InvalidInput)?
            .to_owned();
        let executor = Executor::new()?;
        executor.run(async move {
            let connection = lancedb::connect(&path_text)
                .read_consistency_interval(Duration::ZERO)
                .execute()
                .await
                .map_err(backend_error)?;
            // Node MemoryDB passes no createTable option: the identical pinned Rust backend defaults apply.
            connection
                .create_empty_table("memories", schema)
                .execute()
                .await
                .map_err(backend_error)?;
            let schema = std::sync::Arc::new(arrow_schema::Schema::new(vec![
                arrow_schema::Field::new("identity", arrow_schema::DataType::Utf8, true),
                arrow_schema::Field::new("identityId", arrow_schema::DataType::Utf8, true),
            ]));
            let batch = arrow_array::RecordBatch::try_new(
                schema.clone(),
                vec![
                    std::sync::Arc::new(arrow_array::StringArray::from(vec![json])),
                    std::sync::Arc::new(arrow_array::StringArray::from(vec![id])),
                ],
            )
            .map_err(|_| StoreError::Corrupt)?;
            connection
                .create_table(
                    "_embedding_identity",
                    arrow_array::RecordBatchIterator::new(vec![Ok(batch)], schema),
                )
                .execute()
                .await
                .map_err(backend_error)?;
            Ok(())
        })?;
        Self::open_with_executor(path, OpenMode::ReadWrite, Some(&identity), executor)
    }
    /// The recorded identity, when present.
    pub fn identity(&self) -> Option<&VectorSpaceIdentity> {
        self.identity.as_ref()
    }
    /// The identity comparison performed at open.
    pub fn identity_status(&self) -> IdentityStatus {
        self.status.clone()
    }
    /// The persisted schema marker; no migration is performed.
    pub fn schema_version(&self) -> StoreSchemaVersion {
        self.schema_version
    }
    /// The memory table's exact Arrow schema.
    pub fn arrow_schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    /// Neutral schemas of the memory and optional identity table.
    pub fn schema_text(&self) -> String {
        let mut text = format!("[memories]\n{}", row::schema_text(&self.schema));
        if let Some(schema) = &self.identity_schema {
            text.push_str(&format!(
                "[_embedding_identity]\n{}",
                row::schema_text(schema)
            ));
        }
        text
    }
    /// Count committed memory rows.
    pub fn count(&self, filter: &RowFilter) -> Result<usize, StoreError> {
        self.trusted()?;
        let table = self.table.clone();
        let filter = filter.to_sql();
        self.executor
            .run(async move { table.count_rows(Some(filter)).await.map_err(backend_error) })
    }
    /// Read committed rows up to the requested limit.
    pub fn scan(&self, filter: &RowFilter, limit: usize) -> Result<Vec<MemoryRow>, StoreError> {
        self.trusted()?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let table = self.table.clone();
        let filter = filter.to_sql();
        self.executor.run(async move {
            let batches = table
                .query()
                .only_if(filter)
                .limit(limit)
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            row::from_batches(&batches)
        })
    }
    /// Read one row by its exact persisted identifier.
    pub fn get(&self, id: &str) -> Result<Option<MemoryRow>, StoreError> {
        self.trusted()?;
        let table = self.table.clone();
        let filter = format!("id = '{}'", id.replace('\\', "\\\\").replace('\'', "''"));
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
            Ok(row::from_batches(&batches)?.into_iter().next())
        })
    }
    fn tombstone_context<'a>(&self, row: &'a MemoryRow) -> std::borrow::Cow<'a, MemoryRow> {
        if !row.agent_id.is_empty() || !row.stored_by.is_empty() {
            return std::borrow::Cow::Borrowed(row);
        }
        let mut context = row.clone();
        context.agent_id = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned();
        std::borrow::Cow::Owned(context)
    }
    fn trusted(&self) -> Result<(), StoreError> {
        self.directory.assert_unchanged()?;
        paths::assert_trusted_path(&self.path)?;
        paths::assert_trusted_path(&self.path.join("memories.lance"))
    }
    fn writable(&self) -> Result<(), StoreError> {
        self.trusted()?;
        if self.mode == OpenMode::ReadOnly {
            Err(StoreError::ReadOnly)
        } else {
            Ok(())
        }
    }
    /// Search using Lance's default metric and safely rendered predicates.
    pub fn search(
        &self,
        vector: &[f32],
        limit: usize,
        filter: &RowFilter,
    ) -> Result<Vec<Scored<MemoryRow>>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.trusted()?;
        self.validate_vector(vector)?;
        let table = self.table.clone();
        let vector = vector.to_vec();
        let filter = filter.to_sql();
        self.executor.run(async move {
            let batches = table
                .vector_search(vector)
                .map_err(backend_error)?
                .only_if(filter)
                .limit(limit)
                .execute()
                .await
                .map_err(backend_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(backend_error)?;
            let mut rows = Vec::new();
            for batch in batches {
                for mut value in row::json_rows(&batch)? {
                    let distance = value
                        .as_object_mut()
                        .and_then(|row| row.remove("_distance"))
                        .and_then(|value| value.as_f64())
                        .ok_or(StoreError::Corrupt)? as f32;
                    rows.push(Scored {
                        row: serde_json::from_value(value).map_err(|_| StoreError::Corrupt)?,
                        distance,
                    });
                }
            }
            Ok(rows)
        })
    }
    fn validate_vector(&self, vector: &[f32]) -> Result<(), StoreError> {
        let dim = match self
            .schema
            .field_with_name("vector")
            .map_err(|_| StoreError::Corrupt)?
            .data_type()
        {
            arrow_schema::DataType::FixedSizeList(_, dim) => *dim as usize,
            _ => return Err(StoreError::Corrupt),
        };
        if vector.len() != dim || vector.iter().any(|value| !value.is_finite()) {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
    /// Merge rows on their ID; success is returned only after Lance commits.
    pub fn upsert(&self, rows: &[MemoryRow]) -> Result<(), StoreError> {
        self.writable()?;
        if rows.is_empty() {
            return Ok(());
        }
        for row in rows {
            super::tombstone::assert_card_write_allowed(
                self.path.parent().ok_or(StoreError::InvalidInput)?,
                self.tombstone_context(row).as_ref(),
            )?;
            self.validate_vector(&row.vector)?;
        }
        let batch = row::to_batch(rows, self.schema.clone())?;
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
    /// Patch selected columns without dropping the row's other persisted values.
    pub fn patch(&self, id: &str, patch: &RowPatch) -> Result<(), StoreError> {
        self.writable()?;
        if patch.text.is_some() || patch.summary.is_some() {
            if let Some(existing) = self.get(id)? {
                super::tombstone::assert_patch_write_allowed(
                    self.path.parent().ok_or(StoreError::InvalidInput)?,
                    self.tombstone_context(&existing).as_ref(),
                    patch,
                )?;
            }
        }
        if let Some(vector) = &patch.vector {
            self.validate_vector(vector)?;
        }
        let values = serde_json::to_value(patch).map_err(|_| StoreError::InvalidInput)?;
        let values = values
            .as_object()
            .ok_or(StoreError::InvalidInput)?
            .iter()
            .map(|(column, value)| Ok((column.clone(), update_literal(value)?)))
            .collect::<Result<Vec<_>, StoreError>>()?;
        if values.is_empty() {
            return Ok(());
        }
        let table = self.table.clone();
        let predicate = format!("id = {}", super::filter::sql_string(id));
        self.executor.run(async move {
            let mut update = table.update().only_if(predicate);
            for (column, value) in values {
                update = update.column(column, value);
            }
            update.execute().await.map_err(backend_error)?;
            Ok(())
        })
    }

    /// Delete matching safe IDs and report how many committed rows matched.
    pub fn delete(&self, ids: &[&str]) -> Result<usize, StoreError> {
        self.writable()?;
        let filter = RowFilter {
            ids: Some(ids.iter().map(|id| (*id).to_owned()).collect()),
            ..Default::default()
        }
        .to_sql();
        let table = self.table.clone();
        self.executor.run(async move {
            let count = table
                .count_rows(Some(filter.clone()))
                .await
                .map_err(backend_error)?;
            table.delete(&filter).await.map_err(backend_error)?;
            Ok(count)
        })
    }

    /// Remove expired non-core rows that are not marked never-forget, as Node does.
    pub fn purge_expired(&self, now: i64) -> Result<usize, StoreError> {
        self.writable()?;
        if !(0..=1_000_000_000_000_000).contains(&now) {
            return Err(StoreError::InvalidInput);
        }
        let filter=format!("expiresAt > 0 AND expiresAt < {now} AND (neverForget IS NULL OR neverForget = 0) AND (memoryClass IS NULL OR memoryClass != 'core')");
        let table = self.table.clone();
        self.executor.run(async move {
            let count = table
                .count_rows(Some(filter.clone()))
                .await
                .map_err(backend_error)?;
            table.delete(&filter).await.map_err(backend_error)?;
            Ok(count)
        })
    }
    /// Share the pin's five-minute purge throttle across handles for the same physical database.
    pub fn purge_expired_throttled(&self, now: i64) -> Result<usize, StoreError> {
        self.writable()?;
        const PURGE_THROTTLE_MS: i64 = 300_000;
        static LAST: std::sync::OnceLock<
            std::sync::Mutex<std::collections::BTreeMap<PathBuf, i64>>,
        > = std::sync::OnceLock::new();
        {
            let mut last = LAST
                .get_or_init(Default::default)
                .lock()
                .map_err(|_| StoreError::Unavailable)?;
            if last
                .get(&self.path)
                .is_some_and(|last| *last != 0 && now - *last < PURGE_THROTTLE_MS)
            {
                return Ok(0);
            }
            last.insert(self.path.clone(), now);
        }
        self.purge_expired(now)
    }
    /// Compact fragments and retain at least the Node policy's default 24 hours of versions.
    pub fn optimize(&self) -> Result<(), StoreError> {
        self.writable()?;
        let table = self.table.clone();
        self.executor.run(async move {
            table
                .optimize(lancedb::table::OptimizeAction::Compact {
                    options: Default::default(),
                    remap_options: None,
                })
                .await
                .map_err(backend_error)?;
            table
                .optimize(lancedb::table::OptimizeAction::Prune {
                    older_than: Some(chrono::Duration::hours(24)),
                    delete_unverified: Some(false),
                    error_if_tagged_old_versions: None,
                })
                .await
                .map_err(backend_error)?;
            Ok(())
        })
    }
}
fn backend_error(_: lancedb::Error) -> StoreError {
    StoreError::Unavailable
}

// The SDK's update-value renderer differs from its WHERE safety helper: only quotes
// are escaped in string values; doubling backslashes here would change persisted text.
fn update_literal(value: &serde_json::Value) -> Result<String, StoreError> {
    match value {
        serde_json::Value::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
        serde_json::Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(update_literal)
                .collect::<Result<Vec<_>, _>>()?
                .join(", ")
        )),
        _ => Err(StoreError::InvalidInput),
    }
}
