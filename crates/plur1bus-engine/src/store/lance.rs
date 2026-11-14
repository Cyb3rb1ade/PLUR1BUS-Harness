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
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

/// Bounded read-only vector inspection for copied legacy tables.
#[path = "adopt_probe.rs"]
pub mod adopt_probe;

#[path = "migration_table.rs"]
pub(crate) mod migration_table;

#[path = "capture_compare.rs"]
mod capture_compare;
#[path = "daily_decay.rs"]
mod daily_decay;
/// Bounded fragment statistics and compaction (RE-D161).
#[path = "fragment_optimize.rs"]
pub mod fragment_optimize;
#[path = "memory_read.rs"]
mod memory_read;
#[path = "shared_store.rs"]
mod shared_store;

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
    pinned_roots: Vec<Arc<super::directory::TrustedDirectory>>,
}
impl Store {
    /// Open an existing physical store without migrating its schema.
    pub fn open(
        path: &Path,
        mode: OpenMode,
        expected: Option<&VectorSpaceIdentity>,
    ) -> Result<Self, StoreError> {
        Self::open_with_executor(path, mode, expected, Executor::new()?, false)
    }
    /// Explicit shared writer recovery; reads never admit a partially migrated provenance schema.
    pub fn open_shared_write(path: &Path) -> Result<Self, StoreError> {
        Self::open_with_executor(path, OpenMode::ReadWrite, None, Executor::new()?, true)
    }
    fn open_with_executor(
        path: &Path,
        mode: OpenMode,
        expected: Option<&VectorSpaceIdentity>,
        executor: Executor,
        partial_sharing: bool,
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
        row::validate_shared_schema(&schema, dim, partial_sharing)?;
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
            pinned_roots: Vec::new(),
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
            let schema = Arc::new(arrow_schema::Schema::new(vec![
                arrow_schema::Field::new("identity", arrow_schema::DataType::Utf8, true),
                arrow_schema::Field::new("identityId", arrow_schema::DataType::Utf8, true),
            ]));
            let batch = arrow_array::RecordBatch::try_new(
                schema.clone(),
                vec![
                    Arc::new(arrow_array::StringArray::from(vec![json])),
                    Arc::new(arrow_array::StringArray::from(vec![id])),
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
        Self::open_with_executor(path, OpenMode::ReadWrite, Some(&identity), executor, false)
    }
    /// Internal physical route binding for durable original-caller receipts.
    pub(crate) fn physical_binding(&self) -> Result<(PathBuf, (u64, u64)), StoreError> {
        self.trusted()?;
        Ok((
            self.directory.path().to_owned(),
            self.directory.identity_parts(),
        ))
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
    /// Inspect missing owner keys without reading any memory content or assigning ownership.
    pub fn count_ownerless_rows(&self) -> Result<usize, StoreError> {
        self.trusted()?;
        let table = self.table.clone();
        let has_owner = self.schema.field_with_name("ownerUserId").is_ok();
        let predicate = has_owner.then(|| "ownerUserId IS NULL OR ownerUserId = ''".to_owned());
        self.executor
            .run(async move { table.count_rows(predicate).await.map_err(backend_error) })
    }

    /// Read committed rows up to the requested limit.
    pub fn scan(&self, filter: &RowFilter, limit: usize) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_where(filter.to_sql(), limit)
    }

    /// Pinned reminder-key lookup. Caller-bound capture code authenticates returned row ownership.
    pub(crate) fn capture_reminders(
        &self,
        agent: &str,
        workspace: &str,
        key: &str,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        use super::filter::sql_string;
        self.scan_where(format!("memoryKind = 'reminder' AND storedBy = {} AND workspaceKey = {} AND reminderKey = {}",
            sql_string(agent), sql_string(workspace), sql_string(key)), 20)
    }

    pub(crate) fn reminders_for_dispatch(
        &self,
        scope: &RowFilter,
        now: i64,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_where(format!("{} AND {}", scope.to_sql(), reminder_due(now)), 50)
    }

    pub(crate) fn rem_candidates(
        &self,
        scope: &RowFilter,
        week: std::ops::Range<i64>,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_page(rem_candidate_predicate(scope, week), offset, limit)
    }

    pub(crate) fn skill_evidence(
        &self,
        scope: &RowFilter,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_where(
            format!(
                "{} AND id != '__schema__' AND
                 (memoryClass IS NULL OR memoryClass != 'dream') AND
                 epistemicStatus IN ('observed', 'corroborated', 'trusted') AND
                 category IN ('decision', 'fact', 'strategy', 'preference', 'workspace_rule', 'user_preference')",
                scope.to_sql(),
            ),
            limit,
        )
    }

    pub(crate) fn rem_neighbors(
        &self,
        scope: &RowFilter,
        week: std::ops::Range<i64>,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Scored<MemoryRow>>, StoreError> {
        self.search_where(vector, limit, rem_candidate_predicate(scope, week))
    }

    pub(crate) fn reminders_for_recall(
        &self,
        scope: &RowFilter,
        now: i64,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_where(
            format!(
                "{} AND ({} OR (reminderStatus = 'pending' AND remindAt > 0 AND remindAt <= {now}))",
                scope.to_sql(), reminder_due(now)
            ),
            50,
        )
    }

    pub(crate) fn dispatch_reminder(
        &self,
        scope: &RowFilter,
        row: &MemoryRow,
        patch: &RowPatch,
        due_at: Option<i64>,
    ) -> Result<usize, StoreError> {
        use super::filter::{sql_string, uuid};
        self.writable()?;
        if !uuid(&row.id) {
            return Err(StoreError::InvalidInput);
        }
        let binding = [
            ("id", row.id.as_str()),
            ("storedBy", row.stored_by.as_str()),
            ("workspaceKey", row.workspace_key.as_str()),
            ("text", row.text.as_str()),
            ("reminderStatus", row.reminder_status.as_str()),
        ]
        .map(|(column, value)| format!("{column} = {}", sql_string(value)))
        .join(" AND ");
        let due = due_at.map_or_else(|| "true".into(), reminder_due);
        let predicate = format!(
            "{} AND {due} AND {binding} AND remindAt = {} AND COALESCE(dispatchCount, 0) = {} AND versionNumber = {} AND updatedAt = {}",
            scope.to_sql(), row.remind_at, row.dispatch_count, row.version_number, row.updated_at,
        );
        self.patch_where(predicate, patch)
    }

    /// Read the pinned bounded page of unconfirmed criticals for an exact background owner.
    pub(crate) fn stale_criticals(
        &self,
        scope: &RowFilter,
        cutoff: i64,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_where(stale_critical_predicate(scope, cutoff), 500)
    }

    /// Expire the same row only if its live scope, type and unconfirmed status still match.
    pub(crate) fn expire_critical(
        &self,
        scope: &RowFilter,
        cutoff: i64,
        row: &MemoryRow,
    ) -> Result<usize, StoreError> {
        use super::filter::sql_string;
        self.writable()?;
        let predicate = format!(
            "{} AND id = {} AND type = {} AND agentId = {} AND storedBy = {} AND workspaceKey = {}",
            stale_critical_predicate(scope, cutoff),
            sql_string(&row.id),
            sql_string(&row.type_),
            sql_string(&row.agent_id),
            sql_string(&row.stored_by),
            sql_string(&row.workspace_key)
        );
        let table = self.table.clone();
        self.executor.run(async move {
            let result = table
                .update()
                .only_if(predicate)
                .column("confirmed", "true")
                .column("type", "'note'")
                .execute()
                .await
                .map_err(backend_error)?;
            usize::try_from(result.rows_updated).map_err(|_| StoreError::Corrupt)
        })
    }

    pub(crate) fn recent_unclassified(
        &self,
        scope: &RowFilter,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_where(unclassified_predicate(scope), 500)
    }

    pub(crate) fn classify_critical_row(
        &self,
        scope: &RowFilter,
        row: &MemoryRow,
        kind: &str,
    ) -> Result<usize, StoreError> {
        use super::filter::{sql_string, uuid};
        self.writable()?;
        if !uuid(&row.id)
            || (kind != "fakt"
                && kind != "note"
                && !crate::capture::critical::TYPES.contains(&kind))
        {
            return Err(StoreError::InvalidInput);
        }
        let binding = [
            ("id", row.id.as_str()),
            ("agentId", row.agent_id.as_str()),
            ("storedBy", row.stored_by.as_str()),
            ("workspaceKey", row.workspace_key.as_str()),
            ("text", row.text.as_str()),
            ("summary", row.summary.as_str()),
            ("sourceMessageRole", row.source_message_role.as_str()),
        ]
        .map(|(column, value)| format!("{column} = {}", sql_string(value)))
        .join(" AND ");
        let predicate = format!(
            "{} AND {binding} AND versionNumber = {} AND updatedAt = {}",
            unclassified_predicate(scope),
            row.version_number,
            row.updated_at,
        );
        let kind = sql_string(kind);
        let table = self.table.clone();
        self.executor.run(async move {
            let result = table
                .update()
                .only_if(predicate)
                .column("type", kind)
                .execute()
                .await
                .map_err(backend_error)?;
            usize::try_from(result.rows_updated).map_err(|_| StoreError::Corrupt)
        })
    }

    pub(crate) fn pending_job_refinement(
        &self,
        scope: &RowFilter,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_page(
            format!("{} AND {REFINE_PENDING}", scope.to_sql()),
            offset,
            limit,
        )
    }

    pub(crate) fn refine_pending_row(
        &self,
        scope: &RowFilter,
        row: &MemoryRow,
        patch: &RowPatch,
    ) -> Result<usize, StoreError> {
        use super::filter::{sql_string, uuid};
        self.writable()?;
        if !uuid(&row.id) {
            return Err(StoreError::InvalidInput);
        }
        let binding = [
            ("id", row.id.as_str()),
            ("agentId", row.agent_id.as_str()),
            ("storedBy", row.stored_by.as_str()),
            ("workspaceKey", row.workspace_key.as_str()),
            ("text", row.text.as_str()),
            ("category", row.category.as_str()),
            ("emotionStatus", row.emotion_status.as_str()),
            ("importanceStatus", row.importance_status.as_str()),
        ]
        .map(|(column, value)| {
            if value.is_empty() {
                format!("({column} IS NULL OR {column} = '')")
            } else {
                format!("{column} = {}", sql_string(value))
            }
        })
        .join(" AND ");
        let status = RowFilter {
            status: Some(if row.status.is_empty() {
                "active".into()
            } else {
                row.status.clone()
            }),
            ..RowFilter::default()
        }
        .to_sql();
        let predicate = format!(
            "{} AND {REFINE_PENDING} AND {binding} AND {status} AND versionNumber = {} AND updatedAt = {} AND importance = {}",
            scope.to_sql(), row.version_number, row.updated_at, row.importance,
        );
        self.patch_where(predicate, patch)
    }

    pub(crate) fn gc_rows(
        &self,
        scope: &RowFilter,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_page(gc_predicate(scope), offset, limit)
    }

    pub(crate) fn archive_gc_row(
        &self,
        scope: &RowFilter,
        row: &MemoryRow,
    ) -> Result<usize, StoreError> {
        self.writable()?;
        use super::filter::sql_string;
        let binding = [
            ("id", row.id.as_str()),
            ("agentId", row.agent_id.as_str()),
            ("storedBy", row.stored_by.as_str()),
            ("workspaceKey", row.workspace_key.as_str()),
            ("text", row.text.as_str()),
            ("summary", row.summary.as_str()),
        ]
        .map(|(column, value)| format!("{column} = {}", sql_string(value)))
        .join(" AND ");
        let predicate =
            format!(
            "{} AND {binding} AND versionNumber = {} AND memoryStrength = {} AND updatedAt = {}",
            gc_predicate(scope), row.version_number, row.memory_strength, row.updated_at
        );
        let table = self.table.clone();
        self.executor.run(async move {
            let result = table
                .update()
                .only_if(predicate)
                .column("status", "'archived'")
                .execute()
                .await
                .map_err(backend_error)?;
            usize::try_from(result.rows_updated).map_err(|_| StoreError::Corrupt)
        })
    }

    fn scan_where(&self, filter: String, limit: usize) -> Result<Vec<MemoryRow>, StoreError> {
        self.scan_page(filter, 0, limit)
    }

    fn scan_page(
        &self,
        filter: String,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, StoreError> {
        self.trusted()?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let table = self.table.clone();
        self.executor.run(async move {
            let batches = table
                .query()
                .only_if(filter)
                .offset(offset)
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
    pub(crate) fn bind_pool_roots(
        &mut self,
        roots: Vec<Arc<super::directory::TrustedDirectory>>,
    ) -> Result<(), StoreError> {
        for root in &roots {
            root.assert_unchanged()?;
            if !self.path.starts_with(root.path()) {
                return Err(StoreError::UntrustedPath);
            }
        }
        self.pinned_roots = roots;
        self.trusted()
    }
    fn trusted(&self) -> Result<(), StoreError> {
        for root in &self.pinned_roots {
            root.assert_unchanged()?;
        }
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
        self.search_where(vector, limit, filter.to_sql())
    }
    /// Capture's exact duplicate acquisition. Ordinary search/filter semantics are unchanged.
    pub fn search_capture_duplicates(
        &self,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<Scored<MemoryRow>>, StoreError> {
        self.search_where(
            vector,
            limit,
            super::filter::CAPTURE_DUPLICATE_FILTER.to_owned(),
        )
    }
    fn search_where(
        &self,
        vector: &[f32],
        limit: usize,
        filter: String,
    ) -> Result<Vec<Scored<MemoryRow>>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.trusted()?;
        self.validate_vector(vector)?;
        let table = self.table.clone();
        let vector = vector.to_vec();
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
                        row: row::decode_row(value)?,
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
        self.patch_where(format!("id = {}", super::filter::sql_string(id)), patch)?;
        Ok(())
    }

    fn patch_where(&self, predicate: String, patch: &RowPatch) -> Result<usize, StoreError> {
        let values = serde_json::to_value(patch).map_err(|_| StoreError::InvalidInput)?;
        let values = values
            .as_object()
            .ok_or(StoreError::InvalidInput)?
            .iter()
            .map(|(column, value)| Ok((column.clone(), update_literal(value)?)))
            .collect::<Result<Vec<_>, StoreError>>()?;
        if values.is_empty() {
            return Ok(0);
        }
        let table = self.table.clone();
        self.executor.run(async move {
            let mut update = table.update().only_if(predicate);
            for (column, value) in values {
                update = update.column(column, value);
            }
            let result = update.execute().await.map_err(backend_error)?;
            usize::try_from(result.rows_updated).map_err(|_| StoreError::Corrupt)
        })
    }

    /// Delete these IDs and report how many committed rows matched. As Node's `MemoryDB.delete`
    /// throws for an ID that is not a UUID, any such ID refuses the call before anything is
    /// deleted. Every ID is deleted, in lists of at most 100 like Node's SQL helper renders. Each
    /// count is taken just before its delete, so a concurrent writer can make it differ.
    pub fn delete(&self, ids: &[&str]) -> Result<usize, StoreError> {
        self.writable()?;
        if !ids.iter().all(|id| super::filter::uuid(id)) {
            return Err(StoreError::InvalidInput);
        }
        let filters = ids
            .chunks(100)
            .map(|chunk| {
                RowFilter {
                    ids: Some(chunk.iter().map(|id| (*id).to_owned()).collect()),
                    ..Default::default()
                }
                .to_sql()
            })
            .collect::<Vec<_>>();
        let table = self.table.clone();
        self.executor.run(async move {
            let mut deleted = 0;
            for filter in filters {
                deleted += table
                    .count_rows(Some(filter.clone()))
                    .await
                    .map_err(backend_error)?;
                table.delete(&filter).await.map_err(backend_error)?;
            }
            Ok(deleted)
        })
    }

    /// Remove only a still-private row of the capture turn named by its durable plan.
    /// The ownership predicates are evaluated by Lance at the deletion commit too.
    pub(crate) fn delete_capture_replay_row(
        &self,
        id: &str,
        agent: &str,
        run: &str,
    ) -> Result<(), StoreError> {
        self.writable()?;
        if !super::filter::uuid(id) || agent.is_empty() || run.is_empty() {
            return Err(StoreError::InvalidInput);
        }
        let quote = super::filter::sql_string;
        let filter = format!(
            "id = {} AND storedBy = {} AND sourceTurnId = {} AND scope = 'agent-private' AND ownerUserId = '' AND agentId = '' AND workspaceId = '' AND workspaceKey = ''",
            quote(id), quote(agent), quote(run),
        );
        let table = self.table.clone();
        self.executor.run(async move {
            table.delete(&filter).await.map_err(backend_error)?;
            Ok(())
        })?;
        if self.get(id)?.is_some() {
            return Err(StoreError::Corrupt);
        }
        Ok(())
    }

    /// Purge only expired rows with the exact proved private background owner.
    pub(crate) fn purge_job_expired(
        &self,
        request: &crate::context::RequestContext,
        now: i64,
    ) -> Result<usize, StoreError> {
        use super::filter::sql_string;
        let owner = sql_string(&request.owner_user_id);
        let workspace = sql_string(&request.workspace_key);
        let agent = sql_string(request.agent_id.as_str());
        self.purge_expired_where(now, &format!(
            "scope = 'agent-private' AND agentId = {agent} AND storedBy = {agent} \
             AND ownerUserId = {owner} AND workspaceId = {workspace} AND workspaceKey = {workspace} \
             AND (memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = '')"
        ))
    }

    /// Remove expired non-core rows that are not marked never-forget, as Node does.
    pub fn purge_expired(&self, now: i64) -> Result<usize, StoreError> {
        self.purge_expired_where(now, "true")
    }
    fn purge_expired_where(&self, now: i64, scope: &str) -> Result<usize, StoreError> {
        self.writable()?;
        if !(0..=1_000_000_000_000_000).contains(&now) {
            return Err(StoreError::InvalidInput);
        }
        let filter = format!(
            "({scope}) AND expiresAt > 0 AND expiresAt < {now} AND (neverForget IS NULL OR neverForget = 0) \
             AND (memoryClass IS NULL OR memoryClass != 'core')"
        );
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
}
fn backend_error(_: lancedb::Error) -> StoreError {
    StoreError::Unavailable
}

fn gc_predicate(scope: &RowFilter) -> String {
    format!(
        "{} AND (status IS NULL OR status IN ('', 'active', 'superseded')) \
         AND (neverForget IS NULL OR neverForget != 1) \
         AND (memoryClass IS NULL OR memoryClass != 'core')",
        scope.to_sql()
    )
}

const REFINE_PENDING: &str = "(emotionStatus = 'pending_t3' OR importanceStatus = 'pending')";

fn reminder_due(now: i64) -> String {
    format!(
        "remindAt > 0 AND remindAt <= {now} AND
        (reminderStatus IN ('scheduled', 'due') OR
          (reminderStatus = 'failed' AND nextDispatchAttemptAt > 0 AND nextDispatchAttemptAt <= {now}))"
    )
}

fn rem_candidate_predicate(scope: &RowFilter, week: std::ops::Range<i64>) -> String {
    let std::ops::Range { start, end } = week;
    format!(
        "{} AND id != '__schema__' AND
        ((sourceTimestamp > 0 AND sourceTimestamp >= {start} AND sourceTimestamp < {end}) OR
         ((sourceTimestamp = 0 OR sourceTimestamp IS NULL) AND createdAt >= {start} AND createdAt < {end})) AND
        (memoryClass IS NULL OR memoryClass != 'dream') AND
        (epistemicStatus IS NULL OR epistemicStatus != 'invalidated')",
        scope.to_sql()
    )
}

fn unclassified_predicate(scope: &RowFilter) -> String {
    format!(
        "{} AND (type IS NULL OR type = '' OR type = 'memory') \
         AND (origin IS NULL OR origin != 'dream') \
         AND (memoryClass IS NULL OR memoryClass != 'dream') \
         AND (epistemicStatus IS NULL OR lower(trim(epistemicStatus)) != 'invalidated')",
        scope.to_sql(),
    )
}

fn stale_critical_predicate(scope: &RowFilter, cutoff: i64) -> String {
    let kinds = crate::capture::critical::TYPES
        .iter()
        .map(|kind| super::filter::sql_string(kind))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{} AND createdAt <= {} AND type IN ({}) \
         AND (confirmed IS NULL OR confirmed = false) \
         AND (epistemicStatus IS NULL OR lower(trim(epistemicStatus)) != 'invalidated')",
        scope.to_sql(),
        cutoff,
        kinds
    )
}

fn update_literal(value: &serde_json::Value) -> Result<String, StoreError> {
    match value {
        serde_json::Value::String(value) => Ok(super::filter::sql_string(value)),
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

#[path = "normal_candidates.rs"]
mod normal_candidates;
