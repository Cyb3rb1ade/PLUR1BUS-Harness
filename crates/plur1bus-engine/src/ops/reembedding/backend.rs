//! Isolated Lance generation copying. The coordinator owns authorization and switching.
use super::state_json::{id_valid, normalize};
use crate::{
    contract::{Cancel, StoreError},
    store::{
        atomic_write::atomic_write,
        directory::TrustedDirectory,
        lance::{
            migration_table::{MigrationAccess, MigrationTable},
            OpenMode,
        },
        lock::JobLock,
        paths::{assert_trusted_path, secure_dir},
    },
    text::{
        js::locale_compare,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
/// Fixed categories; neither filesystem paths nor row content appears in diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendError {
    /// Invalid input/schema/manifest.
    Invalid,
    /// Existing generation already has a complete manifest.
    Exists,
    /// A persisted target row conflicts with the resumed input.
    Conflict,
    /// Source schema/version/metadata or target validation differs.
    Drift,
    /// Source/target path is not trusted.
    UnsafePath,
    /// Another writer owns the target generation.
    Busy,
    /// Caller cancellation or deadline.
    Cancelled,
    /// The backend was closed.
    Closed,
    /// A filesystem or Lance operation failed.
    Storage,
}
impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid reembedding data",
            Self::Exists => "target generation already exists",
            Self::Conflict => "target row conflict",
            Self::Drift => "reembedding source or target drift",
            Self::UnsafePath => "unsafe reembedding path",
            Self::Busy => "reembedding generation busy",
            Self::Cancelled => "cancelled",
            Self::Closed => "reembedding backend closed",
            Self::Storage => "reembedding storage unavailable",
        })
    }
}
impl std::error::Error for BackendError {}
impl From<StoreError> for BackendError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::UntrustedPath => Self::UnsafePath,
            StoreError::Busy => Self::Busy,
            StoreError::InvalidInput | StoreError::Corrupt => Self::Invalid,
            _ => Self::Storage,
        }
    }
}
fn io(_: std::io::Error) -> BackendError {
    BackendError::Storage
}
fn check(cancel: &Cancel) -> Result<(), BackendError> {
    cancel.check().map_err(|_| BackendError::Cancelled)
}
/// Validate a single persisted generation ID before constructing any path.
pub(crate) fn generation(id: &str) -> Result<(), BackendError> {
    if id_valid(id) && id.len() <= 64 {
        Ok(())
    } else {
        Err(BackendError::Invalid)
    }
}
fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn integer(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && (0. ..=9_007_199_254_740_991.).contains(n) && n.fract() == 0.)
        .map(|n| n as u64)
}
/// Read the same bounded generation declaration used by migration validation.
pub(crate) fn read_generation_manifest(
    directory: &TrustedDirectory,
    generation: &str,
) -> Result<Value, StoreError> {
    const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
    let file = directory.open_file("generation.json")?;
    let mut bytes = Vec::new();
    if file.metadata()?.len() > MAX_MANIFEST_BYTES {
        return Err(StoreError::Corrupt);
    }
    file.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(StoreError::Corrupt);
    }
    directory.assert_unchanged()?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
    if value["schemaVersion"] != 1
        || value["generation"] != generation
        || integer(&value["dimensions"]).unwrap_or(0) == 0
    {
        return Err(StoreError::Corrupt);
    }
    for (id, table) in value["tables"].as_object().ok_or(StoreError::Corrupt)? {
        partition(id).map_err(|_| StoreError::Corrupt)?;
        if table["sourceVersion"].as_str().is_none_or(str::is_empty)
            || integer(&table["sourceRows"]).is_none()
            || integer(&table["writtenRows"]).is_none()
        {
            return Err(StoreError::Corrupt);
        }
    }
    Ok(value)
}

/// Exact Node stable hash: retain all unknown metadata except vector/fingerprint and top-level `_` fields.
pub fn stable_non_vector_hash(row: &Json) -> Result<String, BackendError> {
    let Json::Object(fields) = normalize(row, 0).map_err(|_| BackendError::Invalid)? else {
        return Err(BackendError::Invalid);
    };
    let projected = Json::Object(
        fields
            .into_iter()
            .filter(|(k, _)| {
                let s = k.to_utf8_lossy();
                s != "vector" && s != "embeddingFingerprint" && !s.starts_with('_')
            })
            .collect(),
    );
    fn sorted(v: Json) -> Json {
        match v {
            Json::Object(mut f) => {
                f.sort_by(|(a, _), (b, _)| a.as_utf16_units().cmp(b.as_utf16_units()));
                Json::Object(f.into_iter().map(|(k, v)| (k, sorted(v))).collect())
            }
            Json::Array(v) => Json::Array(v.into_iter().map(sorted).collect()),
            other => other,
        }
    }
    let canonical = normalize(&sorted(projected), 0).map_err(|_| BackendError::Invalid)?;
    Ok(format!(
        "{:x}",
        Sha256::digest(write_json(&canonical).as_bytes())
    ))
}
fn row_hash(row: &Value) -> Result<String, BackendError> {
    stable_non_vector_hash(&parse_json(&row.to_string()).map_err(|_| BackendError::Invalid)?)
}
fn dimensions(schema: &Schema) -> Result<usize, BackendError> {
    match schema
        .field_with_name("vector")
        .map_err(|_| BackendError::Invalid)?
        .data_type()
    {
        DataType::FixedSizeList(_, n) if *n > 0 => Ok(*n as usize),
        _ => Err(BackendError::Invalid),
    }
}
fn target_schema(schema: &Schema, dim: usize) -> Result<SchemaRef, BackendError> {
    let n = i32::try_from(dim)
        .ok()
        .filter(|n| *n > 0)
        .ok_or(BackendError::Invalid)?;
    dimensions(schema)?;
    let fields = schema
        .fields()
        .iter()
        .map(|f| {
            if f.name() == "vector" {
                Arc::new(f.as_ref().clone().with_data_type(DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, true)),
                    n,
                )))
            } else {
                f.clone()
            }
        })
        .collect::<Vec<_>>();
    Ok(Arc::new(Schema::new_with_metadata(
        fields,
        schema.metadata().clone(),
    )))
}
#[derive(Clone)]
enum Partition {
    Private(String),
    Shared(String, String),
}
fn partition(id: &str) -> Result<Partition, BackendError> {
    let parts = id.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        [agent, "memories"] => {
            crate::context::safe_agent_id(agent).map_err(|_| BackendError::Invalid)?;
            Ok(Partition::Private((*agent).into()))
        }
        ["shared", kind, key, "memories"] if matches!(*kind, "workspaces" | "users") => {
            let prefix = if *kind == "workspaces" { "w-" } else { "u-" };
            if key.len() != 64
                || !key.starts_with(prefix)
                || !key[2..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(BackendError::Invalid);
            }
            Ok(Partition::Shared((*kind).into(), (*key).into()))
        }
        _ => Err(BackendError::Invalid),
    }
}
/// Host-resolved roots and active generation. These are never read from migration request paths.
pub struct BackendConfig {
    /// Engine-owned state root containing `generations`.
    pub state_root: PathBuf,
    /// Selected active private-data root (already includes any namespace).
    pub active_root: PathBuf,
    /// Base for the active `.plur1bus-shared` tree.
    pub active_shared_base: PathBuf,
    /// Namespace added beneath new generation roots, if configured.
    pub namespace: Option<String>,
    /// Current generation label.
    pub active_generation: String,
    /// Exact active selection (`legacy` or `generation`).
    pub active_selection: Value,
    /// Host's actual vector-space fingerprint.
    pub active_fingerprint: Value,
    /// Reference only; no resolved secret.
    pub active_secret_ref: Option<Value>,
    /// Current configuration revision for drift checks.
    pub config_revision: Option<String>,
}
/// Real Lance copy backend, with read-only source handles and serialized target mutations.
pub struct GenerationBackend {
    config: BackendConfig,
    access: MigrationAccess,
    handles: Mutex<BTreeMap<PathBuf, Arc<MigrationTable>>>,
    writer: Mutex<()>,
    closed: AtomicBool,
}
impl GenerationBackend {
    /// Bind trusted roots without creating source, target or manifest files.
    pub fn new(config: BackendConfig) -> Result<Self, BackendError> {
        generation(&config.active_generation)?;
        if config.namespace.as_ref().is_some_and(|s| {
            s.is_empty()
                || s.len() > 64
                || !s.as_bytes()[0].is_ascii_alphanumeric()
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        }) {
            return Err(BackendError::Invalid);
        }
        for path in [
            &config.state_root,
            &config.active_root,
            &config.active_shared_base,
        ] {
            assert_trusted_path(path)?;
        }
        if integer(&config.active_fingerprint["dimensions"]).unwrap_or(0) == 0 {
            return Err(BackendError::Invalid);
        }
        let selection = &config.active_selection;
        if !((selection["mode"] == "legacy" && selection.as_object().is_some_and(|v| v.len() == 1))
            || (selection["mode"] == "generation"
                && selection["generation"] == config.active_generation
                && selection.as_object().is_some_and(|v| v.len() == 2)))
        {
            return Err(BackendError::Invalid);
        }
        Ok(Self {
            config,
            access: MigrationAccess::new()?,
            handles: Mutex::new(BTreeMap::new()),
            writer: Mutex::new(()),
            closed: AtomicBool::new(false),
        })
    }
    fn check(&self, cancel: &Cancel) -> Result<(), BackendError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(BackendError::Closed);
        }
        check(cancel)
    }
    fn root(&self, id: &str) -> Result<PathBuf, BackendError> {
        generation(id)?;
        Ok(self.config.state_root.join("generations").join(id))
    }
    fn path(&self, id: &str, target: Option<&str>) -> Result<PathBuf, BackendError> {
        let part = partition(id)?;
        let (base, shared) = if let Some(g) = target {
            let base = self.root(g)?;
            let private = self
                .config
                .namespace
                .as_ref()
                .map_or_else(|| base.clone(), |n| base.join(n));
            (private, base)
        } else {
            (
                self.config.active_root.clone(),
                self.config.active_shared_base.clone(),
            )
        };
        Ok(match part {
            Partition::Private(agent) => base.join(agent),
            Partition::Shared(kind, key) => shared.join(".plur1bus-shared").join(kind).join(key),
        })
    }
    fn table(
        &self,
        id: &str,
        target: Option<&str>,
        cancel: &Cancel,
    ) -> Result<Arc<MigrationTable>, BackendError> {
        self.check(cancel)?;
        let path = self.path(id, target)?;
        let mut handles = self.handles.lock().map_err(|_| BackendError::Storage)?;
        if let Some(table) = handles.get(&path) {
            return Ok(table.clone());
        }
        let table = Arc::new(self.access.open(
            &path,
            "memories",
            if target.is_some() {
                OpenMode::ReadWrite
            } else {
                OpenMode::ReadOnly
            },
            cancel,
        )?);
        handles.insert(path, table.clone());
        Ok(table)
    }
    fn manifest(&self, id: &str) -> Result<Value, BackendError> {
        let root = self.root(id)?;
        let dir = TrustedDirectory::open(&root)?;
        read_generation_manifest(&dir, id).map_err(BackendError::from)
    }
    fn save(&self, id: &str, value: &Value) -> Result<(), BackendError> {
        let path = self.root(id)?.join("generation.json");
        assert_trusted_path(&path)?;
        atomic_write(
            &path,
            serde_json::to_vec(value)
                .map_err(|_| BackendError::Invalid)?
                .as_slice(),
        )
        .map_err(io)
    }
    /// Read the completed manifest without altering any target data.
    pub fn describe(&self, id: &str, cancel: &Cancel) -> Result<Value, BackendError> {
        self.check(cancel)?;
        self.manifest(id)
    }
    /// Inventory private and shared tables without creating absent roots or opening a writer.
    pub fn inventory(&self, cancel: &Cancel) -> Result<Value, BackendError> {
        self.check(cancel)?;
        let mut tables = Vec::new();
        for (name, path, is_dir) in entries(&self.config.active_root, cancel)? {
            if [".plur1bus-shared", "control", "generations"].contains(&name.as_str())
                || name.starts_with('_')
            {
                continue;
            }
            if !is_dir {
                continue;
            }
            if let Some(t) = self.inventory_table(&format!("{name}/memories"), &path, cancel)? {
                tables.push(t);
            }
        }
        for kind in ["workspaces", "users"] {
            let root = self
                .config
                .active_shared_base
                .join(".plur1bus-shared")
                .join(kind);
            for (name, path, is_dir) in entries(&root, cancel)? {
                if !is_dir {
                    continue;
                }
                let id = format!("shared/{kind}/{name}/memories");
                partition(&id)?;
                if let Some(t) = self.inventory_table(&id, &path, cancel)? {
                    tables.push(t);
                }
            }
        }
        tables.sort_by(|a, b| {
            locale_compare(
                a["tableId"].as_str().unwrap_or(""),
                b["tableId"].as_str().unwrap_or(""),
            )
        });
        let mut record = json!({"generation":self.config.active_generation,"selection":self.config.active_selection,"configRevision":self.config.config_revision,"fingerprint":self.config.active_fingerprint,"tables":tables});
        if let Some(v) = &self.config.active_secret_ref {
            record["secretRef"] = v.clone();
        }
        self.check(cancel)?;
        Ok(json!([record]))
    }
    fn inventory_table(
        &self,
        id: &str,
        path: &Path,
        cancel: &Cancel,
    ) -> Result<Option<Value>, BackendError> {
        let leaf = path.join("memories.lance");
        assert_trusted_path(&leaf)?;
        if !leaf.try_exists().map_err(io)? {
            return Ok(None);
        }
        if !leaf.is_dir() {
            return Err(BackendError::UnsafePath);
        }
        partition(id)?;
        let table = self.table(id, None, cancel)?;
        let dim = dimensions(table.schema(cancel)?.as_ref())?;
        if Some(dim as u64) != integer(&self.config.active_fingerprint["dimensions"]) {
            return Err(BackendError::Drift);
        }
        Ok(Some(
            json!({"tableId":id,"version":table.version(cancel)?.to_string(),"rowCount":table.count(cancel)?,"estimatedBytes":directory_bytes(path,cancel)?,"dimensions":dim}),
        ))
    }
    /// Read a bounded source batch at the currently visible Lance version.
    pub fn read_source(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
        cancel: &Cancel,
    ) -> Result<Vec<Value>, BackendError> {
        self.check(cancel)?;
        if limit > 10000 {
            return Err(BackendError::Invalid);
        }
        Ok(self
            .table(id, None, cancel)?
            .read(offset, limit, None, cancel)?)
    }
    /// Create only quarantined target tables; publish generation.json after every table and identity exists.
    pub fn create_generation(
        &self,
        id: &str,
        fingerprint_id: Option<&str>,
        dim: usize,
        tables: &[Value],
        identity: Option<&Value>,
        cancel: &Cancel,
    ) -> Result<Value, BackendError> {
        self.check(cancel)?;
        let _serial = self.writer.lock().map_err(|_| BackendError::Storage)?;
        let parent = self.config.state_root.join("generations");
        let lease = JobLock::acquire(&parent, "reembedding-generation", Duration::from_secs(30))
            .map_err(|_| BackendError::Busy)?;
        let root = self.root(id)?;
        assert_trusted_path(&root)?;
        if self.config.active_root.starts_with(&root)
            || self.config.active_shared_base.starts_with(&root)
        {
            return Err(BackendError::UnsafePath);
        }
        let complete = root.join("generation.json");
        assert_trusted_path(&complete)?;
        if complete.try_exists().map_err(io)? {
            return Err(BackendError::Exists);
        }
        let mut declarations = serde_json::Map::new();
        for t in tables {
            let name = t["tableId"].as_str().ok_or(BackendError::Invalid)?;
            partition(name)?;
            let version = t["version"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or(BackendError::Invalid)?;
            let rows = integer(&t["rowCount"]).ok_or(BackendError::Invalid)?;
            if declarations
                .insert(
                    name.into(),
                    json!({"sourceVersion":version,"sourceRows":rows,"writtenRows":0}),
                )
                .is_some()
            {
                return Err(BackendError::Invalid);
            }
        }
        if dim == 0 || dim > i32::MAX as usize {
            return Err(BackendError::Invalid);
        }
        let mut manifest = json!({"schemaVersion":1,"generation":id,"fingerprintId":fingerprint_id,"dimensions":dim,"tables":declarations});
        let canonical = identity
            .map(|v| {
                let value = crate::embedding::identity::identity_from_value(v)
                    .map_err(|_| BackendError::Invalid)?;
                crate::store::identity::canonical_identity(&value).map_err(BackendError::from)
            })
            .transpose()?;
        if let Some((_, raw, key)) = &canonical {
            manifest["identity"] = serde_json::from_str(raw).map_err(|_| BackendError::Invalid)?;
            manifest["identityId"] = json!(key);
            if integer(&manifest["identity"]["dimension"]) != Some(dim as u64) {
                return Err(BackendError::Invalid);
            }
        }
        secure_dir(&root)?;
        for descriptor in tables {
            self.check(cancel)?;
            if !lease.heartbeat().unwrap_or(false) {
                return Err(BackendError::Busy);
            }
            let table_id = descriptor["tableId"]
                .as_str()
                .ok_or(BackendError::Invalid)?;
            let source_path = self.path(table_id, None)?;
            let path = self.path(table_id, Some(id))?;
            if path.starts_with(&source_path) || source_path.starts_with(&path) {
                return Err(BackendError::UnsafePath);
            }
            let source = self.table(table_id, None, cancel)?;
            let schema = target_schema(source.schema(cancel)?.as_ref(), dim)?;
            let leaf = path.join("memories.lance");
            assert_trusted_path(&leaf)?;
            let target = if leaf.try_exists().map_err(io)? {
                let t = self
                    .access
                    .open(&path, "memories", OpenMode::ReadWrite, cancel)?;
                if t.count(cancel)? != 0 || *t.schema(cancel)? != *schema {
                    return Err(BackendError::Drift);
                }
                t
            } else {
                self.access.create(&path, "memories", schema, cancel)?
            };
            self.handles
                .lock()
                .map_err(|_| BackendError::Storage)?
                .insert(path.clone(), Arc::new(target));
            if let Some((_, raw, key)) = &canonical {
                let identity_leaf = path.join("_embedding_identity.lance");
                assert_trusted_path(&identity_leaf)?;
                if identity_leaf.try_exists().map_err(io)? {
                    let table = self.access.open(
                        &path,
                        "_embedding_identity",
                        OpenMode::ReadOnly,
                        cancel,
                    )?;
                    let rows = table.read(0, 2, None, cancel)?;
                    if rows.len() != 1
                        || rows[0]["identity"] != *raw
                        || rows[0]["identityId"] != *key
                    {
                        return Err(BackendError::Drift);
                    }
                } else {
                    let schema = Arc::new(Schema::new(vec![
                        Field::new("identity", DataType::Utf8, false),
                        Field::new("identityId", DataType::Utf8, false),
                    ]));
                    self.access
                        .create(&path, "_embedding_identity", schema, cancel)?
                        .add(vec![json!({"identity":raw,"identityId":key})], cancel)?;
                }
            }
        }
        self.check(cancel)?;
        if !lease.heartbeat().unwrap_or(false) {
            return Err(BackendError::Busy);
        }
        self.save(id, &manifest)?;
        Ok(manifest)
    }
    /// Read target rows in requested ID order, refusing duplicate persisted UUIDs.
    pub fn read_target(
        &self,
        generation: &str,
        id: &str,
        ids: &[String],
        cancel: &Cancel,
    ) -> Result<Vec<Value>, BackendError> {
        self.check(cancel)?;
        let manifest = self.manifest(generation)?;
        if manifest["tables"].get(id).is_none() {
            return Err(BackendError::Invalid);
        }
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let filter = id_filter(ids)?;
        let rows = self.table(id, Some(generation), cancel)?.read(
            0,
            ids.len() + 1,
            Some(filter),
            cancel,
        )?;
        let mut by_id = BTreeMap::new();
        for row in rows {
            let id = row["id"].as_str().ok_or(BackendError::Drift)?.to_owned();
            if by_id.insert(id, row).is_some() {
                return Err(BackendError::Drift);
            }
        }
        Ok(ids.iter().filter_map(|id| by_id.get(id).cloned()).collect())
    }
    /// Idempotently append one bounded batch and reconcile its durable manifest count after readback.
    pub fn write_target(
        &self,
        generation: &str,
        id: &str,
        raw: &[Value],
        cancel: &Cancel,
    ) -> Result<Value, BackendError> {
        self.check(cancel)?;
        let _serial = self.writer.lock().map_err(|_| BackendError::Storage)?;
        let lease = JobLock::acquire(
            &self.config.state_root.join("generations"),
            "reembedding-generation",
            Duration::from_secs(30),
        )
        .map_err(|_| BackendError::Busy)?;
        let mut manifest = self.manifest(generation)?;
        if manifest["tables"].get(id).is_none() {
            return Err(BackendError::Invalid);
        }
        let dim = integer(&manifest["dimensions"]).ok_or(BackendError::Invalid)? as usize;
        if raw.is_empty() || raw.len() > 10000 {
            return Err(BackendError::Invalid);
        }
        let mut seen = BTreeSet::new();
        let mut rows = Vec::new();
        let mut ids = Vec::new();
        for row in raw {
            let id = row["id"]
                .as_str()
                .filter(|s| uuid(s))
                .ok_or(BackendError::Invalid)?;
            if !seen.insert(id) {
                return Err(BackendError::Invalid);
            }
            let mut normalized = row.clone();
            normalized["vector"] = json!(vector(row, dim)?);
            ids.push(id.to_owned());
            rows.push(normalized);
        }
        let existing = self.read_target(generation, id, &ids, cancel)?;
        let by_id = existing
            .iter()
            .map(|r| (r["id"].as_str().unwrap_or(""), r))
            .collect::<BTreeMap<_, _>>();
        let mut additions = Vec::new();
        for row in &rows {
            let row_id = row["id"].as_str().ok_or(BackendError::Invalid)?;
            if let Some(prior) = by_id.get(row_id) {
                if row_hash(prior)? != row_hash(row)? || vector(prior, dim)? != vector(row, dim)? {
                    return Err(BackendError::Conflict);
                }
            } else {
                additions.push(row.clone());
            }
        }
        let added = additions.len();
        let table = self.table(id, Some(generation), cancel)?;
        let source_rows =
            integer(&manifest["tables"][id]["sourceRows"]).ok_or(BackendError::Invalid)?;
        if table.count(cancel)? as u64 + added as u64 > source_rows {
            return Err(BackendError::Drift);
        }
        self.check(cancel)?;
        if !lease.heartbeat().unwrap_or(false) {
            return Err(BackendError::Busy);
        }
        if !additions.is_empty() {
            table.add(additions, cancel)?;
        }
        let count = table.count(cancel)? as u64;
        if count > source_rows {
            return Err(BackendError::Drift);
        }
        self.check(cancel)?;
        if !lease.heartbeat().unwrap_or(false) {
            return Err(BackendError::Busy);
        }
        if integer(&manifest["tables"][id]["writtenRows"]) != Some(count) {
            manifest["tables"][id]["writtenRows"] = json!(count);
            self.save(generation, &manifest)?;
        }
        Ok(json!({"added":added,"existing":rows.len()-added}))
    }
    /// Validate every target row against the fixed source version, preserving all non-vector fields.
    pub fn validate(&self, generation: &str, cancel: &Cancel) -> Result<Value, BackendError> {
        self.check(cancel)?;
        let manifest = self.manifest(generation)?;
        let dim = integer(&manifest["dimensions"]).ok_or(BackendError::Invalid)? as usize;
        let mut total = 0_u64;
        for (id, descriptor) in manifest["tables"]
            .as_object()
            .ok_or(BackendError::Invalid)?
        {
            self.check(cancel)?;
            let target = self.table(id, Some(generation), cancel)?;
            let source = self.table(id, None, cancel)?;
            if dimensions(target.schema(cancel)?.as_ref())? != dim
                || target.count(cancel)? as u64
                    != integer(&descriptor["sourceRows"]).ok_or(BackendError::Invalid)?
                || json!(source.version(cancel)?.to_string()) != descriptor["sourceVersion"]
            {
                return Err(BackendError::Drift);
            }
            let mut offset = 0;
            let mut seen = BTreeSet::new();
            loop {
                let batch = target.read(offset, 1000, None, cancel)?;
                if batch.is_empty() {
                    break;
                }
                let mut ids = Vec::new();
                for row in &batch {
                    let id = row["id"]
                        .as_str()
                        .filter(|s| uuid(s))
                        .ok_or(BackendError::Drift)?;
                    if !seen.insert(id.to_owned()) {
                        return Err(BackendError::Drift);
                    }
                    vector(row, dim)?;
                    ids.push(id.to_owned());
                }
                let source_rows = source.read(0, ids.len() + 1, Some(id_filter(&ids)?), cancel)?;
                let mut originals = BTreeMap::new();
                for row in &source_rows {
                    let key = row["id"].as_str().ok_or(BackendError::Drift)?;
                    if originals.insert(key, row).is_some() {
                        return Err(BackendError::Drift);
                    }
                }
                for row in &batch {
                    let original = originals
                        .get(row["id"].as_str().ok_or(BackendError::Drift)?)
                        .ok_or(BackendError::Drift)?;
                    if row_hash(original)? != row_hash(row)? {
                        return Err(BackendError::Drift);
                    }
                }
                offset += batch.len();
                if batch.len() < 1000 {
                    break;
                }
            }
            if json!(source.version(cancel)?.to_string()) != descriptor["sourceVersion"]
                || offset as u64
                    != integer(&descriptor["sourceRows"]).ok_or(BackendError::Invalid)?
            {
                return Err(BackendError::Drift);
            }
            total += offset as u64;
        }
        Ok(
            json!({"tables":manifest["tables"].as_object().ok_or(BackendError::Invalid)?.len(),"rows":total,"dimensions":dim}),
        )
    }
    /// Semantic validation uses only the quarantined target generation.
    pub fn search(
        &self,
        generation: &str,
        id: &str,
        query: &[f64],
        limit: usize,
        cancel: &Cancel,
    ) -> Result<Vec<Value>, BackendError> {
        self.check(cancel)?;
        let manifest = self.manifest(generation)?;
        if manifest["tables"].get(id).is_none() {
            return Err(BackendError::Invalid);
        }
        let dim = integer(&manifest["dimensions"]).ok_or(BackendError::Invalid)? as usize;
        let vector = vector(&json!({"vector":query}), dim)?
            .into_iter()
            .map(|n| n as f32)
            .collect();
        Ok(self
            .table(id, Some(generation), cancel)?
            .search(vector, limit, cancel)?)
    }
    /// Remove only the UUID explicitly supplied by the validation probe owner.
    /// The runtime probe must durably audit this cleanup before calling the backend.
    pub fn remove_probe(
        &self,
        generation: &str,
        id: &str,
        probe_id: &str,
        cancel: &Cancel,
    ) -> Result<(), BackendError> {
        self.check(cancel)?;
        if !uuid(probe_id) {
            return Err(BackendError::Invalid);
        }
        let _serial = self.writer.lock().map_err(|_| BackendError::Storage)?;
        let lease = JobLock::acquire(
            &self.config.state_root.join("generations"),
            "reembedding-generation",
            Duration::from_secs(30),
        )
        .map_err(|_| BackendError::Busy)?;
        let manifest = self.manifest(generation)?;
        if manifest["tables"].get(id).is_none() {
            return Err(BackendError::Invalid);
        }
        self.check(cancel)?;
        if !lease.heartbeat().unwrap_or(false) {
            return Err(BackendError::Busy);
        }
        Ok(self
            .table(id, Some(generation), cancel)?
            .delete(format!("id = '{}'", probe_id), cancel)?)
    }
    /// Release cached handles and permanently close this backend.
    pub fn close(&self) -> Result<(), BackendError> {
        self.closed.store(true, Ordering::Release);
        self.handles
            .lock()
            .map_err(|_| BackendError::Storage)?
            .clear();
        Ok(())
    }
}
fn entries(path: &Path, cancel: &Cancel) -> Result<Vec<(String, PathBuf, bool)>, BackendError> {
    check(cancel)?;
    assert_trusted_path(path)?;
    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(io(e)),
    };
    let mut out = Vec::new();
    for e in entries {
        check(cancel)?;
        let e = e.map_err(io)?;
        let kind = e.file_type().map_err(io)?;
        if kind.is_symlink() {
            return Err(BackendError::UnsafePath);
        }
        let name = e
            .file_name()
            .into_string()
            .map_err(|_| BackendError::UnsafePath)?;
        out.push((name, e.path(), kind.is_dir()));
    }
    Ok(out)
}
fn directory_bytes(path: &Path, cancel: &Cancel) -> Result<u64, BackendError> {
    check(cancel)?;
    assert_trusted_path(path)?;
    let m = fs::symlink_metadata(path).map_err(io)?;
    if m.is_file() {
        return Ok(m.len());
    }
    if !m.is_dir() {
        return Err(BackendError::UnsafePath);
    }
    let mut size = 0_u64;
    for (_, p, _) in entries(path, cancel)? {
        size = size
            .checked_add(directory_bytes(&p, cancel)?)
            .ok_or(BackendError::Invalid)?;
    }
    Ok(size)
}

fn id_filter(ids: &[String]) -> Result<String, BackendError> {
    if ids.is_empty() || ids.len() > 10000 || ids.iter().any(|s| !uuid(s)) {
        return Err(BackendError::Invalid);
    }
    Ok(format!(
        "id IN ({})",
        ids.iter()
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(",")
    ))
}
fn vector(row: &Value, dim: usize) -> Result<Vec<f64>, BackendError> {
    let values = row["vector"]
        .as_array()
        .filter(|v| v.len() == dim)
        .ok_or(BackendError::Invalid)?;
    values
        .iter()
        .map(|n| {
            let n = n.as_f64().ok_or(BackendError::Invalid)?;
            let stored = n as f32;
            if !n.is_finite() || !stored.is_finite() {
                return Err(BackendError::Invalid);
            }
            Ok(f64::from(stored))
        })
        .collect()
}
#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;
