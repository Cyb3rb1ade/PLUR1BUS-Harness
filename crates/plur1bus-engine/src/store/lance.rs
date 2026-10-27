//! Synchronous store boundary over one dedicated Tokio runtime per store.
use super::{row, schema_version, RowFilter, StoreSchemaVersion};
use crate::contract::{MemoryRow, StoreError, VectorSpaceIdentity};
use arrow_schema::SchemaRef;
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use std::future::Future;
use std::path::Path;
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
        found: VectorSpaceIdentity,
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
    table: lancedb::Table,
    identity: Option<VectorSpaceIdentity>,
    status: IdentityStatus,
    schema_version: StoreSchemaVersion,
    schema: SchemaRef,
    identity_schema: Option<SchemaRef>,
    mode: OpenMode,
    executor: Executor,
}
impl Store {
    /// Open an existing physical store without migrating its schema.
    pub fn open(
        path: &Path,
        mode: OpenMode,
        expected: Option<&VectorSpaceIdentity>,
    ) -> Result<Self, StoreError> {
        let path_text = path.to_str().ok_or(StoreError::Corrupt)?.to_owned();
        let executor = Executor::new()?;
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
                    (Some(identity), Some(identity_schema))
                } else {
                    (None, None)
                };
            Ok((table, identity, schema, identity_schema))
        })?;
        let status = match (&identity, expected) {
            (Some(found), Some(expected))
                if serde_json::to_value(found).ok() != serde_json::to_value(expected).ok() =>
            {
                IdentityStatus::Mismatch {
                    found: found.clone(),
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
        if schema != row::arrow_schema(dim)? {
            return Err(StoreError::Corrupt);
        }
        Ok(Self {
            table,
            identity,
            status,
            schema_version: schema_version::read(path)?,
            schema,
            identity_schema,
            mode,
            executor,
        })
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
    pub fn count(&self, _filter: &RowFilter) -> Result<usize, StoreError> {
        let table = self.table.clone();
        self.executor
            .run(async move { table.count_rows(None).await.map_err(backend_error) })
    }
    /// Read committed rows up to the requested limit.
    pub fn scan(&self, _filter: &RowFilter, limit: usize) -> Result<Vec<MemoryRow>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let table = self.table.clone();
        self.executor.run(async move {
            let batches = table
                .query()
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
}
fn backend_error(_: lancedb::Error) -> StoreError {
    StoreError::Unavailable
}
