//! Narrow raw-Arrow access for generation copying, preserving columns outside MemoryRow.
use super::{backend_error, Executor, OpenMode};
use crate::{
    contract::{Cancel, StoreError},
    store::{
        directory::TrustedDirectory,
        paths::{assert_trusted_path, secure_dir},
    },
};
use arrow_array::{RecordBatch, RecordBatchIterator};
use arrow_schema::{DataType, SchemaRef};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use serde_json::Value;
use std::{future::Future, path::Path, sync::Arc, time::Duration};
/// One shared dedicated executor for all tables in a reembedding backend.
pub(crate) struct MigrationAccess {
    executor: Arc<Executor>,
}
impl MigrationAccess {
    pub(crate) fn new() -> Result<Self, StoreError> {
        Ok(Self {
            executor: Arc::new(Executor::new()?),
        })
    }
    pub(crate) fn open(
        &self,
        path: &Path,
        name: &str,
        mode: OpenMode,
        cancel: &Cancel,
    ) -> Result<MigrationTable, StoreError> {
        table_name(name)?;
        check(cancel)?;
        assert_trusted_path(path)?;
        let leaf = path.join(format!("{name}.lance"));
        assert_trusted_path(&leaf)?;
        if !leaf.is_dir() {
            return Err(StoreError::Unavailable);
        }
        let directory = TrustedDirectory::open(path)?;
        let uri = directory
            .lance_path()
            .to_str()
            .ok_or(StoreError::InvalidInput)?
            .to_owned();
        let name = name.to_owned();
        let cancel = cancel.clone();
        let table = self.executor.run(async move {
            let db = wait(
                lancedb::connect(&uri)
                    .read_consistency_interval(Duration::ZERO)
                    .execute(),
                &cancel,
            )
            .await?;
            wait(db.open_table(&name).execute(), &cancel).await
        })?;
        directory.assert_unchanged()?;
        Ok(MigrationTable {
            executor: self.executor.clone(),
            table,
            directory,
            mode,
        })
    }
    pub(crate) fn create(
        &self,
        path: &Path,
        name: &str,
        schema: SchemaRef,
        cancel: &Cancel,
    ) -> Result<MigrationTable, StoreError> {
        table_name(name)?;
        check(cancel)?;
        secure_dir(path)?;
        assert_trusted_path(&path.join(format!("{name}.lance")))?;
        let directory = TrustedDirectory::open(path)?;
        let uri = directory
            .lance_path()
            .to_str()
            .ok_or(StoreError::InvalidInput)?
            .to_owned();
        let name = name.to_owned();
        let cancel = cancel.clone();
        let table = self.executor.run(async move {
            let db = wait(lancedb::connect(&uri).execute(), &cancel).await?;
            wait(db.create_empty_table(&name, schema).execute(), &cancel).await
        })?;
        directory.assert_unchanged()?;
        Ok(MigrationTable {
            executor: self.executor.clone(),
            table,
            directory,
            mode: OpenMode::ReadWrite,
        })
    }
}
fn table_name(name: &str) -> Result<(), StoreError> {
    if matches!(name, "memories" | "_embedding_identity") {
        Ok(())
    } else {
        Err(StoreError::InvalidInput)
    }
}
fn check(cancel: &Cancel) -> Result<(), StoreError> {
    cancel.check().map_err(|_| StoreError::Unavailable)
}
async fn wait<T>(
    future: impl Future<Output = lancedb::Result<T>>,
    cancel: &Cancel,
) -> Result<T, StoreError> {
    let mut future = std::pin::pin!(future);
    loop {
        check(cancel)?;
        match tokio::time::timeout(Duration::from_millis(25), &mut future).await {
            Ok(result) => {
                check(cancel)?;
                return result.map_err(backend_error);
            }
            Err(_) => continue,
        }
    }
}
/// A capability-held table. The source is read-only; only isolated target handles permit writes.
pub(crate) struct MigrationTable {
    executor: Arc<Executor>,
    table: lancedb::Table,
    directory: TrustedDirectory,
    mode: OpenMode,
}
impl MigrationTable {
    fn run<T: Send + 'static>(
        &self,
        cancel: &Cancel,
        operation: impl FnOnce(
            lancedb::Table,
            Cancel,
        )
            -> std::pin::Pin<Box<dyn Future<Output = Result<T, StoreError>> + Send>>,
    ) -> Result<T, StoreError> {
        check(cancel)?;
        self.directory.assert_unchanged()?;
        let result = self
            .executor
            .run(operation(self.table.clone(), cancel.clone()))?;
        self.directory.assert_unchanged()?;
        check(cancel)?;
        Ok(result)
    }
    pub(crate) fn schema(&self, cancel: &Cancel) -> Result<SchemaRef, StoreError> {
        self.run(cancel, |t, c| {
            Box::pin(async move { wait(t.schema(), &c).await })
        })
    }
    pub(crate) fn version(&self, cancel: &Cancel) -> Result<u64, StoreError> {
        self.run(cancel, |t, c| {
            Box::pin(async move {
                wait(t.checkout_latest(), &c).await?;
                wait(t.version(), &c).await
            })
        })
    }
    pub(crate) fn count(&self, cancel: &Cancel) -> Result<usize, StoreError> {
        self.run(cancel, |t, c| {
            Box::pin(async move { wait(t.count_rows(None), &c).await })
        })
    }
    pub(crate) fn read(
        &self,
        offset: usize,
        limit: usize,
        filter: Option<String>,
        cancel: &Cancel,
    ) -> Result<Vec<Value>, StoreError> {
        if limit == 0 || limit > 10001 {
            return Err(StoreError::InvalidInput);
        }
        self.run(cancel, |t, c| {
            Box::pin(async move {
                wait(t.checkout_latest(), &c).await?;
                let mut query = t.query().offset(offset).limit(limit);
                if let Some(filter) = filter {
                    query = query.only_if(filter);
                }
                let mut stream = wait(query.execute(), &c).await?;
                let mut rows = Vec::new();
                while let Some(batch) = wait(stream.try_next(), &c).await? {
                    rows.extend(json_rows(&batch)?);
                }
                Ok(rows)
            })
        })
    }
    pub(crate) fn add(&self, rows: Vec<Value>, cancel: &Cancel) -> Result<(), StoreError> {
        if self.mode != OpenMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        if rows.is_empty() || rows.len() > 10000 {
            return Err(StoreError::InvalidInput);
        }
        self.run(cancel, |t, c| {
            Box::pin(async move {
                let schema = wait(t.schema(), &c).await?;
                let decoded_schema = Arc::new(arrow_schema::Schema::new_with_metadata(
                    schema
                        .fields()
                        .iter()
                        .map(|f| {
                            Arc::new(f.as_ref().clone().with_data_type(json_type(f.data_type())))
                        })
                        .collect::<Vec<_>>(),
                    schema.metadata().clone(),
                ));
                let mut decoder = arrow_json::ReaderBuilder::new(decoded_schema)
                    .with_strict_mode(true)
                    .build_decoder()
                    .map_err(|_| StoreError::Corrupt)?;
                decoder.serialize(&rows).map_err(|_| StoreError::Corrupt)?;
                let batch = decoder
                    .flush()
                    .map_err(|_| StoreError::Corrupt)?
                    .ok_or(StoreError::Corrupt)?;
                let options = arrow_cast::CastOptions {
                    safe: false,
                    ..Default::default()
                };
                let columns = batch
                    .columns()
                    .iter()
                    .zip(schema.fields())
                    .map(|(column, field)| {
                        arrow_cast::cast_with_options(column, field.data_type(), &options)
                            .map_err(|_| StoreError::Corrupt)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let batch = RecordBatch::try_new(schema.clone(), columns)
                    .map_err(|_| StoreError::Corrupt)?;
                check(&c)?;
                let reader = RecordBatchIterator::new(vec![Ok(batch)], schema);
                wait(t.add(Box::new(reader)).execute(), &c).await?;
                Ok(())
            })
        })
    }
    pub(crate) fn search(
        &self,
        vector: Vec<f32>,
        limit: usize,
        cancel: &Cancel,
    ) -> Result<Vec<Value>, StoreError> {
        if !(1..=100).contains(&limit) || vector.is_empty() || vector.iter().any(|n| !n.is_finite())
        {
            return Err(StoreError::InvalidInput);
        }
        self.run(cancel, |t, c| {
            Box::pin(async move {
                let query = t.vector_search(vector).map_err(backend_error)?.limit(limit);
                let mut stream = wait(query.execute(), &c).await?;
                let mut rows = Vec::new();
                while let Some(batch) = wait(stream.try_next(), &c).await? {
                    rows.extend(json_rows(&batch)?);
                }
                Ok(rows)
            })
        })
    }
    pub(crate) fn delete(&self, filter: String, cancel: &Cancel) -> Result<(), StoreError> {
        if self.mode != OpenMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        self.run(cancel, |t, c| {
            Box::pin(async move {
                wait(t.delete(&filter), &c).await?;
                Ok(())
            })
        })
    }
}
fn json_rows(batch: &RecordBatch) -> Result<Vec<Value>, StoreError> {
    let mut writer = arrow_json::WriterBuilder::new()
        .with_explicit_nulls(true)
        .build::<_, arrow_json::writer::JsonArray>(Vec::new());
    writer.write(batch).map_err(|_| StoreError::Corrupt)?;
    writer.finish().map_err(|_| StoreError::Corrupt)?;
    let mut rows: Vec<Value> =
        serde_json::from_slice(&writer.into_inner()).map_err(|_| StoreError::Corrupt)?;
    for row in &mut rows {
        for field in batch.schema().fields() {
            if let Some(v) = row.get_mut(field.name()) {
                widen(v, field.data_type())?;
            }
        }
    }
    Ok(rows)
}
fn widen(value: &mut Value, data_type: &DataType) -> Result<(), StoreError> {
    if value.is_null() {
        return Ok(());
    }
    match data_type {
        DataType::Float32 => {
            let n = value.as_f64().ok_or(StoreError::Corrupt)? as f32;
            *value = serde_json::json!(f64::from(n));
        }
        DataType::List(child) | DataType::LargeList(child) | DataType::FixedSizeList(child, _) => {
            for v in value.as_array_mut().ok_or(StoreError::Corrupt)? {
                widen(v, child.data_type())?;
            }
        }
        DataType::Struct(fields) => {
            for field in fields {
                if let Some(v) = value.get_mut(field.name()) {
                    widen(v, field.data_type())?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

// Arrow JSON does not decode fixed-size lists. Decode ordinary lists, then strictly cast
// back to the original schema; invalid widths error instead of silently producing nulls.
fn json_type(t: &DataType) -> DataType {
    match t {
        DataType::FixedSizeList(child, _) | DataType::List(child) => DataType::List(Arc::new(
            child
                .as_ref()
                .clone()
                .with_data_type(json_type(child.data_type())),
        )),
        DataType::LargeList(child) => DataType::LargeList(Arc::new(
            child
                .as_ref()
                .clone()
                .with_data_type(json_type(child.data_type())),
        )),
        DataType::Struct(fields) => DataType::Struct(
            fields
                .iter()
                .map(|f| Arc::new(f.as_ref().clone().with_data_type(json_type(f.data_type()))))
                .collect(),
        ),
        other => other.clone(),
    }
}
