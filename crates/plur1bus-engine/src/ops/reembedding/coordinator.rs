//! F7-authorized, durable one-batch maintenance coordinator.
use super::{
    backend::{stable_non_vector_hash, BackendError},
    confirmation,
    coordinator_ports::{CopyBackend, MigrationProvider, MigrationRuntime},
    planner::{self, PlanError, PlanSource, ReembeddingPlan},
    state::{MigrationStateStore, StateError},
    state_json::{get_text, id_valid, integer, normalize, number, put, revision, string},
};
use crate::{
    contract::{Cancel, MaintenanceGrant, MaintenanceMethod},
    ops::{import_primitives::field, migrate::MaintenanceAudit},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, TryLockError,
    },
    time::{Duration, Instant},
};
/// Content-free coordinator failure; state and provider bodies are never formatted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinatorError {
    /// A fixed validation category.
    Invalid(&'static str),
    /// A bounded persistent-state category.
    State(&'static str),
    /// Copy backend failure.
    Backend(BackendError),
    /// Required provider capability failed.
    Provider,
    /// Both resources were attempted; these flags retain cleanup failures without error bodies.
    Cleanup {
        /// Provider release failed.
        provider: bool,
        /// Backend release failed.
        backend: bool,
    },
    /// Required host capability failed.
    Host,
    /// Audit could not be persisted; the operation did not proceed.
    Audit,
    /// Caller/grant cancellation or deadline.
    Cancelled,
    /// Another operation owns the coordinator.
    Busy,
    /// Shutdown prohibits new mutations.
    Closed,
}
impl fmt::Display for CoordinatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(s) | Self::State(s) => f.write_str(s),
            Self::Backend(e) => e.fmt(f),
            Self::Provider => f.write_str("reembedding provider unavailable"),
            Self::Host => f.write_str("reembedding host unavailable"),
            Self::Cleanup { .. } => f.write_str("reembedding coordinator shutdown failed"),
            Self::Audit => f.write_str("reembedding audit unavailable"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Busy => f.write_str("another reembedding coordinator operation is active"),
            Self::Closed => f.write_str("reembedding coordinator is shutting down"),
        }
    }
}
impl std::error::Error for CoordinatorError {}
impl From<StateError> for CoordinatorError {
    fn from(e: StateError) -> Self {
        Self::State(e.code())
    }
}
impl From<BackendError> for CoordinatorError {
    fn from(e: BackendError) -> Self {
        Self::Backend(e)
    }
}
impl From<PlanError> for CoordinatorError {
    fn from(e: PlanError) -> Self {
        match e {
            PlanError::Invalid(s) => Self::Invalid(s),
            PlanError::Cancelled => Self::Cancelled,
            _ => Self::Host,
        }
    }
}
fn invalid(s: &'static str) -> CoordinatorError {
    CoordinatorError::Invalid(s)
}
fn obj(items: Vec<(&str, Json)>) -> Json {
    Json::Object(items.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn required<'a>(v: &'a Json, k: &str) -> Result<&'a Json, CoordinatorError> {
    field(v, k).ok_or(invalid("invalid migration record"))
}
fn text(v: &Json, k: &str) -> Result<String, CoordinatorError> {
    get_text(v, k).ok_or(invalid("invalid migration record"))
}
fn array(v: &Json) -> Result<&[Json], CoordinatorError> {
    match v {
        Json::Array(v) => Ok(v),
        _ => Err(invalid("invalid migration record")),
    }
}
/// Operational bounds retained from C2. Concurrency is admitted for configuration compatibility;
/// each explicit operation still commits at most one durable batch.
#[derive(Clone, Copy, Debug)]
pub struct MigrationLimits {
    batch: usize,
    max_calls: u64,
    max_bytes: u64,
    deadline: Duration,
}
impl MigrationLimits {
    /// Validate Node's six known bounds; omitted fields use the C2 defaults.
    pub fn from_json(input: &Json) -> Result<Self, CoordinatorError> {
        let defs = [
            ("batchSize", 8, 1000),
            ("concurrency", 1, 8),
            ("maxBatchesPerOperation", 1, 1),
            ("maxCalls", 100000, 1000000),
            ("maxBytes", 4 * 1024 * 1024 * 1024, 9_007_199_254_740_991),
            ("deadlineMs", 3600000, 86400000),
        ];
        let mut values = Vec::new();
        for (name, default, max) in defs {
            let n = field(input, name)
                .map_or(Some(default), integer)
                .filter(|n| *n >= 1 && *n <= max)
                .ok_or(invalid("invalid reembedding limit"))?;
            values.push(n);
        }
        Ok(Self {
            batch: values[0] as usize,
            max_calls: values[3],
            max_bytes: values[4],
            deadline: Duration::from_millis(values[5]),
        })
    }
}
impl Default for MigrationLimits {
    fn default() -> Self {
        Self {
            batch: 8,
            max_calls: 100000,
            max_bytes: 4 * 1024 * 1024 * 1024,
            deadline: Duration::from_secs(3600),
        }
    }
}
/// A successfully persisted plan and its separately exposed operator proof.
pub struct PlannedMigration {
    plan: ReembeddingPlan,
    record: Json,
}
impl PlannedMigration {
    /// The immutable plan and explicit confirmation accessor.
    pub fn plan(&self) -> &ReembeddingPlan {
        &self.plan
    }
    /// Durable schemaVersion-1 migration record, with hash-only confirmation metadata.
    pub fn record(&self) -> &Json {
        &self.record
    }
}
impl fmt::Debug for PlannedMigration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PlannedMigration([redacted])")
    }
}
struct CachedProvider {
    digest: String,
    provider: Box<dyn MigrationProvider>,
}
struct PlannerBridge<'a> {
    backend: &'a dyn CopyBackend,
    runtime: &'a dyn MigrationRuntime,
}
impl PlanSource for PlannerBridge<'_> {
    fn inventory_active_generation(&self, c: &Cancel) -> Result<Vec<Json>, PlanError> {
        self.backend.inventory(c).map_err(|_| PlanError::Dependency)
    }
    fn free_bytes(&self, c: &Cancel) -> Result<u64, PlanError> {
        self.runtime
            .free_bytes(c)
            .map_err(|_| PlanError::Dependency)
    }
    fn target_artifacts_verified(&self, f: &Json, c: &Cancel) -> Result<bool, PlanError> {
        self.runtime
            .artifacts_verified(f, c)
            .map_err(|_| PlanError::Dependency)
    }
    fn probe_target(&self, t: &Json, c: &Cancel) -> Result<Vec<f64>, PlanError> {
        self.runtime
            .plan_probe(t, c)
            .map_err(|_| PlanError::Dependency)
    }
}
/// Storage-wide maintenance admission is always an authenticated F7 Core-link grant, never a person.
pub struct ReembeddingCoordinator {
    state: Arc<MigrationStateStore>,
    backend: Arc<dyn CopyBackend>,
    runtime: Arc<dyn MigrationRuntime>,
    audit: Arc<dyn MaintenanceAudit>,
    limits: MigrationLimits,
    operation: Mutex<Option<CachedProvider>>,
    closing: AtomicBool,
    closed: AtomicBool,
}
impl ReembeddingCoordinator {
    /// Require every productive dependency; no empty recall/probe/policy fallback is invented here.
    pub fn new(
        state: Arc<MigrationStateStore>,
        backend: Arc<dyn CopyBackend>,
        runtime: Arc<dyn MigrationRuntime>,
        audit: Arc<dyn MaintenanceAudit>,
        limits: MigrationLimits,
    ) -> Self {
        Self {
            state,
            backend,
            runtime,
            audit,
            limits,
            operation: Mutex::new(None),
            closing: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }
    }
    fn admit(
        &self,
        grant: &MaintenanceGrant,
        method: MaintenanceMethod,
        id: Option<&str>,
        cancel: &Cancel,
    ) -> Result<(), CoordinatorError> {
        grant
            .check(cancel)
            .map_err(|_| CoordinatorError::Cancelled)?;
        let target = id
            .filter(|s| id_valid(s))
            .map_or_else(|| json!({"invalid":true}), |id| json!({"id":id}));
        self.audit.append(&json!({"kind":"engine-maintenance","method":method.wire_name(),"actor":"core-maintenance","coreLink":grant.origin(),"target":target,"at":self.runtime.now_ms()})).map_err(|_|CoordinatorError::Audit)?;
        self.check(grant, cancel)
    }
    fn check(&self, grant: &MaintenanceGrant, cancel: &Cancel) -> Result<(), CoordinatorError> {
        grant.check(cancel).map_err(|_| CoordinatorError::Cancelled)
    }
    fn exclusive(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<CachedProvider>>, CoordinatorError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(CoordinatorError::Closed);
        }
        let guard = self.operation.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => CoordinatorError::Busy,
            TryLockError::Poisoned(_) => CoordinatorError::Host,
        })?;
        if self.closing.load(Ordering::Acquire) {
            return Err(CoordinatorError::Closed);
        }
        Ok(guard)
    }
    fn record(&self, id: &str) -> Result<Json, CoordinatorError> {
        self.state
            .get(id)?
            .ok_or(invalid("reembedding migration not found"))
    }
    /// Audit and persist a new plan before returning its proof to the operator.
    pub fn plan(
        &self,
        grant: &MaintenanceGrant,
        request: &Json,
        cancel: &Cancel,
    ) -> Result<PlannedMigration, CoordinatorError> {
        self.admit(
            grant,
            MaintenanceMethod::Plan,
            get_text(request, "id").as_deref(),
            cancel,
        )?;
        let _active = self.exclusive()?;
        let bridge = PlannerBridge {
            backend: self.backend.as_ref(),
            runtime: self.runtime.as_ref(),
        };
        let plan = planner::create(request, &bridge, self.runtime.now_ms() as f64, cancel)?;
        self.check(grant, cancel)?;
        let id = text(plan.plan(), "id")?;
        let generation = text(required(plan.plan(), "target")?, "generation")?;
        for other in self.state.list()? {
            if text(&other, "id")? == id
                || !matches!(text(&other, "state")?.as_str(), "completed" | "rolled_back")
            {
                continue;
            }
            if ["source", "target"].iter().any(|key| {
                field(&other, key)
                    .and_then(|v| get_text(v, "generation"))
                    .as_deref()
                    == Some(&generation)
            }) {
                return Err(invalid("target generation already belongs to a migration"));
            }
        }
        let policy = self.policy(cancel)?;
        let confirmation = parse_json(
            &serde_json::to_string(plan.confirmation().persisted())
                .map_err(|_| CoordinatorError::Host)?,
        )
        .map_err(|_| CoordinatorError::Host)?;
        let input = obj(vec![
            ("id", string(&id)),
            ("state", string("planned")),
            ("planDigest", string(plan.digest())),
            ("confirmation", confirmation),
            ("source", required(plan.plan(), "source")?.clone()),
            ("target", required(plan.plan(), "target")?.clone()),
            ("cursor", Cursor::default().json()),
            ("receipts", obj(vec![("targetCreated", Json::Bool(false))])),
            ("policyRevision", policy),
        ]);
        self.check(grant, cancel)?;
        let record = self
            .state
            .create(&input, self.runtime.now_ms() as f64, cancel)?;
        Ok(PlannedMigration { plan, record })
    }
    fn policy(&self, cancel: &Cancel) -> Result<Json, CoordinatorError> {
        Ok(self
            .runtime
            .policy_snapshot(cancel)?
            .map_or(Json::Null, |v| string(&write_json(&v))))
    }
    fn update(
        &self,
        record: &Json,
        patch: Json,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        Ok(self.state.update(
            &text(record, "id")?,
            &obj(vec![
                ("expectedRevision", number(revision(record)?)),
                ("expectedState", required(record, "state")?.clone()),
                ("patch", patch),
            ]),
            self.runtime.now_ms() as f64,
            cancel,
        )?)
    }
    fn transition(
        &self,
        record: &Json,
        to: &str,
        patch: Json,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        Ok(self.state.transition(
            &text(record, "id")?,
            &text(record, "state")?,
            to,
            &obj(vec![
                ("expectedRevision", number(revision(record)?)),
                ("patch", patch),
            ]),
            self.runtime.now_ms() as f64,
            cancel,
        )?)
    }
    fn confirmed(&self, record: &Json, proof: &str, expiry: bool) -> Result<(), CoordinatorError> {
        let metadata = serde_json::from_str(&write_json(required(record, "confirmation")?))
            .map_err(|_| invalid("invalid or expired reembedding confirmation"))?;
        let valid = if expiry {
            confirmation::verify(proof, &metadata, self.runtime.now_ms() as f64)
        } else {
            confirmation::verify_binding(proof, &metadata)
        };
        if valid {
            Ok(())
        } else {
            Err(invalid("invalid or expired reembedding confirmation"))
        }
    }
    /// Consume a planned confirmation, or continue an already confirmed/running migration.
    pub fn apply(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        proof: &str,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        self.admit(grant, MaintenanceMethod::Apply, Some(id), cancel)?;
        let mut active = self.exclusive()?;
        let mut record = self.record(id)?;
        self.confirmed(&record, proof, text(&record, "state")? == "planned")?;
        if text(&record, "state")? == "planned" {
            self.check(grant, cancel)?;
            record = self.transition(&record, "confirmed", obj(vec![]), cancel)?;
        }
        if text(&record, "state")? == "confirmed" {
            let mut receipts = field(&record, "receipts")
                .cloned()
                .unwrap_or_else(|| obj(vec![]));
            put(&mut receipts, "targetCreated", Json::Bool(false))?;
            self.check(grant, cancel)?;
            record = self.transition(
                &record,
                "running",
                obj(vec![
                    ("cursor", Cursor::read(&record)?.json()),
                    ("receipts", receipts),
                ]),
                cancel,
            )?;
        }
        if text(&record, "state")? != "running" {
            return Err(invalid(
                "reembedding apply requires planned, confirmed, or running state",
            ));
        }
        self.run(record, proof, &mut active, grant, cancel)
    }
    /// Explicitly acknowledge policy changes and commit at most one further durable batch.
    pub fn resume(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        proof: &str,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        self.admit(grant, MaintenanceMethod::Resume, Some(id), cancel)?;
        let mut active = self.exclusive()?;
        let record = self.record(id)?;
        self.confirmed(&record, proof, false)?;
        if text(&record, "state")? == "validating" {
            return Ok(record);
        }
        if text(&record, "state")? != "running" {
            return Err(invalid("reembedding resume requires running state"));
        }
        self.run(record, proof, &mut active, grant, cancel)
    }
    /// Read the requested record after the same F7 grant and audit boundary as mutations.
    pub fn status(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Option<Json>, CoordinatorError> {
        self.admit(grant, MaintenanceMethod::Status, Some(id), cancel)?;
        Ok(self.state.get(id)?)
    }
    /// Prevent new mutations, wait for the active bounded operation, then release both resources.
    pub fn shutdown(&self) -> Result<(), CoordinatorError> {
        self.closing.store(true, Ordering::Release);
        let mut active = self.operation.lock().map_err(|_| CoordinatorError::Host)?;
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let provider_error = active.as_ref().and_then(|p| p.provider.close().err());
        let backend_error = self.backend.close().err();
        *active = None;
        self.closed.store(true, Ordering::Release);
        if provider_error.is_some() || backend_error.is_some() {
            return Err(CoordinatorError::Cleanup {
                provider: provider_error.is_some(),
                backend: backend_error.is_some(),
            });
        }
        Ok(())
    }
}
#[derive(Default)]
struct Cursor {
    table: usize,
    offset: usize,
    completed: u64,
    calls: u64,
    bytes: u64,
}
impl Cursor {
    fn read(record: &Json) -> Result<Self, CoordinatorError> {
        let c = field(record, "cursor").unwrap_or(&Json::Null);
        let n = |k| {
            field(c, k)
                .map_or(Some(0), integer)
                .ok_or(invalid("invalid migration cursor"))
        };
        Ok(Self {
            table: usize::try_from(n("tableIndex")?)
                .map_err(|_| invalid("invalid migration cursor"))?,
            offset: usize::try_from(n("offset")?)
                .map_err(|_| invalid("invalid migration cursor"))?,
            completed: n("completedRows")?,
            calls: n("providerCalls")?,
            bytes: n("bytes")?,
        })
    }
    fn json(&self) -> Json {
        obj(vec![
            ("tableIndex", number(self.table as u64)),
            ("offset", number(self.offset as u64)),
            ("completedRows", number(self.completed)),
            ("providerCalls", number(self.calls)),
            ("bytes", number(self.bytes)),
        ])
    }
}
impl ReembeddingCoordinator {
    fn assert_source(
        &self,
        record: &Json,
        policy: bool,
        cancel: &Cancel,
    ) -> Result<(), CoordinatorError> {
        let inventory = self.backend.inventory(cancel)?;
        let source = required(record, "source")?;
        if inventory.len() != 1
            || get_text(&inventory[0], "generation") != get_text(source, "generation")
        {
            return Err(invalid("reembedding source generation drift"));
        }
        if field(&inventory[0], "configRevision").unwrap_or(&Json::Null)
            != field(source, "configRevision").unwrap_or(&Json::Null)
        {
            return Err(invalid("reembedding source config revision drift"));
        }
        let actual = array(required(&inventory[0], "tables")?)?
            .iter()
            .map(|t| Ok((text(t, "tableId")?, text(t, "version")?)))
            .collect::<Result<BTreeMap<_, _>, CoordinatorError>>()?;
        for table in array(required(source, "tables")?)? {
            if actual.get(&text(table, "tableId")?) != Some(&text(table, "version")?) {
                return Err(invalid("reembedding source version drift"));
            }
        }
        if policy
            && self.policy(cancel)?
                != field(record, "policyRevision")
                    .cloned()
                    .unwrap_or(Json::Null)
        {
            return Err(invalid(
                "reembedding workspace policy changed; explicit resume required",
            ));
        }
        Ok(())
    }
    fn ensure_target(
        &self,
        record: Json,
        grant: &MaintenanceGrant,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        if field(&record, "receipts").and_then(|v| field(v, "targetCreated"))
            == Some(&Json::Bool(true))
        {
            return Ok(record);
        }
        self.check(grant, cancel)?;
        match self.backend.create_target(&record, cancel) {
            Ok(()) => {}
            Err(BackendError::Exists) => {
                let target = required(&record, "target")?;
                let existing = self
                    .backend
                    .describe(&text(target, "generation")?, cancel)?;
                let wrong = get_text(&existing, "generation") != get_text(target, "generation")
                    || field(&existing, "dimensions").and_then(integer)
                        != field(required(target, "fingerprint")?, "dimensions").and_then(integer)
                    || get_text(&existing, "fingerprintId")
                        .filter(|s| !s.is_empty())
                        .is_some_and(|s| Some(s) != get_text(target, "fingerprintId"));
                if wrong
                    || !manifest_matches(
                        &existing,
                        array(required(required(&record, "source")?, "tables")?)?,
                    )
                {
                    return Err(invalid(
                        "existing target generation does not match the migration plan",
                    ));
                }
                if let (Some(a), Some(b)) =
                    (field(&existing, "identity"), field(target, "identity"))
                {
                    if !matches!(a, Json::Null) && identity_id(a)? != identity_id(b)? {
                        return Err(invalid(
                            "existing target generation does not match the migration plan",
                        ));
                    }
                }
            }
            Err(e) => return Err(e.into()),
        }
        let mut receipts = field(&record, "receipts")
            .cloned()
            .unwrap_or_else(|| obj(vec![]));
        put(&mut receipts, "targetCreated", Json::Bool(true))?;
        self.check(grant, cancel)?;
        self.update(&record, obj(vec![("receipts", receipts)]), cancel)
    }
    fn provider<'a>(
        &self,
        record: &Json,
        cache: &'a mut Option<CachedProvider>,
        grant: &MaintenanceGrant,
        cancel: &Cancel,
    ) -> Result<&'a dyn MigrationProvider, CoordinatorError> {
        let digest = text(record, "planDigest")?;
        if cache.as_ref().is_some_and(|p| p.digest != digest) {
            if let Some(p) = cache.as_ref() {
                p.provider.close()?;
            }
            *cache = None;
        }
        if cache.is_none() {
            let target = required(record, "target")?;
            let mut specification = obj(vec![(
                "fingerprint",
                required(target, "fingerprint")?.clone(),
            )]);
            if let Some(reference) = field(target, "secretRef") {
                put(&mut specification, "secretRef", reference.clone())?;
            }
            let candidate = self.runtime.create_provider(&specification, cancel)?;
            let actual = crate::store::identity::identity_id(candidate.identity()).ok();
            let expected = field(target, "identity").and_then(|value| identity_id(value).ok());
            if actual.zip(expected).is_none_or(|(a, b)| a != b) {
                candidate.close()?;
                return Err(invalid("target embedding provider identity mismatch"));
            }
            if let Err(e) = self.check(grant, cancel) {
                candidate.close()?;
                return Err(e);
            }
            *cache = Some(CachedProvider {
                digest,
                provider: candidate,
            });
        }
        cache
            .as_ref()
            .map(|p| p.provider.as_ref())
            .ok_or(CoordinatorError::Provider)
    }
    fn run(
        &self,
        mut record: Json,
        proof: &str,
        cache: &mut Option<CachedProvider>,
        grant: &MaintenanceGrant,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        self.confirmed(&record, proof, false)?;
        self.assert_source(&record, false, cancel)?;
        let policy = self.policy(cancel)?;
        if field(&record, "policyRevision").unwrap_or(&Json::Null) != &policy {
            self.check(grant, cancel)?;
            record = self.update(&record, obj(vec![("policyRevision", policy)]), cancel)?;
        }
        record = self.ensure_target(record, grant, cancel)?;
        let end = Instant::now()
            .checked_add(self.limits.deadline)
            .ok_or(CoordinatorError::Host)?;
        let cancel = cancel.limited_to(end);
        let mut cursor = Cursor::read(&record)?;
        let tables = array(required(required(&record, "source")?, "tables")?)?.to_vec();
        for (index, table) in tables.iter().enumerate().skip(cursor.table) {
            let count = field(table, "rowCount")
                .and_then(integer)
                .ok_or(invalid("invalid migration table count"))?;
            let mut offset = if index == cursor.table {
                cursor.offset
            } else {
                0
            };
            while (offset as u64) < count {
                self.check(grant, &cancel)?;
                self.assert_source(&record, true, &cancel)?;
                let table_id = text(table, "tableId")?;
                let rows =
                    self.backend
                        .read_source(&table_id, offset, self.limits.batch, &cancel)?;
                if rows.is_empty()
                    || rows.len() > self.limits.batch
                    || rows.len() as u64 > count - offset as u64
                {
                    return Err(invalid("source batch ended before inventory count"));
                }
                let calls = cursor
                    .calls
                    .checked_add(1)
                    .filter(|n| *n <= self.limits.max_calls)
                    .ok_or(invalid("reembedding provider call budget exceeded"))?;
                let bytes = write_json(&normalize(&Json::Array(rows.clone()), 0)?).len() as u64;
                let bytes = cursor
                    .bytes
                    .checked_add(bytes)
                    .filter(|n| *n <= self.limits.max_bytes)
                    .ok_or(invalid("reembedding byte budget exceeded"))?;
                let passages = rows
                    .iter()
                    .map(|r| text(r, "text").map_err(|_| invalid("source row text is invalid")))
                    .collect::<Result<Vec<_>, _>>()?;
                let provider = self.provider(&record, cache, grant, &cancel)?;
                let vectors =
                    provider.embed(&passages, crate::contract::EmbedKind::Passage, &cancel)?;
                if vectors.len() != rows.len() {
                    return Err(invalid("target embedding batch result mismatch"));
                }
                let dim = field(
                    required(required(&record, "target")?, "fingerprint")?,
                    "dimensions",
                )
                .and_then(integer)
                .ok_or(invalid("invalid target dimensions"))?;
                let mut migrated = Vec::new();
                for (row, vector) in rows.iter().zip(vectors) {
                    if vector.len() as u64 != dim || vector.iter().any(|n| !n.is_finite()) {
                        return Err(invalid("target embedding vector mismatch"));
                    }
                    let mut row = row.clone();
                    put(
                        &mut row,
                        "vector",
                        Json::Array(
                            vector
                                .into_iter()
                                .map(|n| Json::Number(ryu_js::Buffer::new().format(n).to_owned()))
                                .collect(),
                        ),
                    )?;
                    migrated.push(row);
                }
                self.check(grant, &cancel)?;
                let generation = text(required(&record, "target")?, "generation")?;
                self.backend
                    .write_target(&generation, &table_id, &migrated, &cancel)?;
                let ids = rows
                    .iter()
                    .map(|r| text(r, "id"))
                    .collect::<Result<Vec<_>, _>>()?;
                let readback = self
                    .backend
                    .read_target(&generation, &table_id, &ids, &cancel)?;
                compare_readback(&rows, &readback, dim)?;
                offset += rows.len();
                cursor = Cursor {
                    table: index,
                    offset,
                    completed: cursor
                        .completed
                        .checked_add(rows.len() as u64)
                        .ok_or(invalid("migration cursor overflow"))?,
                    calls,
                    bytes,
                };
                if offset as u64 >= count {
                    cursor.table = index + 1;
                    cursor.offset = 0;
                }
                self.check(grant, &cancel)?;
                record = self.update(&record, obj(vec![("cursor", cursor.json())]), &cancel)?;
                if cursor.table < tables.len() {
                    return Ok(record);
                }
            }
        }
        self.check(grant, &cancel)?;
        self.transition(
            &record,
            "validating",
            obj(vec![("cursor", cursor.json())]),
            &cancel,
        )
    }
    /// Verify a copied target and require real semantic validation before ready_to_switch.
    pub fn validate(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        self.admit(grant, MaintenanceMethod::Validate, Some(id), cancel)?;
        let mut cache = self.exclusive()?;
        let record = self.record(id)?;
        if text(&record, "state")? != "validating" {
            return Err(invalid("reembedding validate requires validating state"));
        }
        self.assert_source(&record, false, cancel)?;
        let generation = text(required(&record, "target")?, "generation")?;
        let mut validation = self.backend.validate(&generation, cancel)?;
        let provider = self.provider(&record, &mut cache, grant, cancel)?;
        let probes = self.runtime.validate_probes(&record, provider, cancel)?;
        if field(&probes, "semanticRecall") != Some(&Json::Bool(true)) {
            return Err(invalid("reembedding semantic recall validation failed"));
        }
        let Json::Object(fields) = probes else {
            return Err(invalid("invalid validation probes"));
        };
        for (key, value) in fields {
            put(&mut validation, &key.to_utf8_lossy(), value)?;
        }
        let mut receipts = field(&record, "receipts")
            .cloned()
            .unwrap_or_else(|| obj(vec![]));
        put(&mut receipts, "validation", validation)?;
        self.check(grant, cancel)?;
        self.transition(
            &record,
            "ready_to_switch",
            obj(vec![("receipts", receipts)]),
            cancel,
        )
    }
}
fn identity_id(value: &Json) -> Result<String, CoordinatorError> {
    let value = serde_json::from_str(&write_json(value)).map_err(|_| CoordinatorError::Provider)?;
    let identity = crate::embedding::identity::identity_from_value(&value)
        .map_err(|_| CoordinatorError::Provider)?;
    crate::store::identity::identity_id(&identity).map_err(|_| CoordinatorError::Provider)
}
fn manifest_matches(existing: &Json, tables: &[Json]) -> bool {
    let Some(Json::Object(declared)) = field(existing, "tables") else {
        return true;
    };
    if declared.len() != tables.len() {
        return false;
    }
    tables.iter().all(|table| {
        let Some(id) = get_text(table, "tableId") else {
            return false;
        };
        let Some(row) = declared
            .iter()
            .find(|(k, _)| k.to_utf8_lossy() == id)
            .map(|(_, v)| v)
        else {
            return false;
        };
        get_text(row, "sourceVersion") == get_text(table, "version")
            && field(row, "sourceRows").and_then(integer)
                == field(table, "rowCount").and_then(integer)
            && field(row, "writtenRows")
                .and_then(integer)
                .zip(field(table, "rowCount").and_then(integer))
                .is_some_and(|(w, s)| w <= s)
    })
}
fn compare_readback(source: &[Json], target: &[Json], dim: u64) -> Result<(), CoordinatorError> {
    if source.len() != target.len() {
        return Err(invalid("target readback row count mismatch"));
    }
    let mut by_id = BTreeMap::new();
    for row in target {
        if by_id.insert(text(row, "id")?, row).is_some() {
            return Err(invalid("target readback duplicate row"));
        }
    }
    for row in source {
        let target = by_id
            .get(&text(row, "id")?)
            .ok_or(invalid("target readback missing row"))?;
        if stable_non_vector_hash(row)? != stable_non_vector_hash(target)? {
            return Err(invalid("target readback metadata mismatch"));
        }
        let vectors = array(required(target, "vector")?)?;
        if vectors.len() as u64 != dim
            || vectors.iter().any(
                |v| !matches!(v,Json::Number(n) if n.parse::<f64>().is_ok_and(|n|n.is_finite())),
            )
        {
            return Err(invalid("target readback vector mismatch"));
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "coordinator_tests.rs"]
mod tests;
