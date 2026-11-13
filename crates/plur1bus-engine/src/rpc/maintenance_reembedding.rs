//! RE-D166: the F7 re-embedding coordinator composed over the process store base.
//!
//! The library decides every outcome. This adapter resolves the active generation exactly as
//! the pin's composition root does (`createLanceGenerationBackend` in `engine/create-engine.js`),
//! binds the existing provider factory, policy store and maintenance audit, and projects the
//! coordinator's records onto the wire. One coordinator per process: at most one plan, apply,
//! resume or validate holds it at a time; a second gets the library's busy refusal.
use crate::rpc::{
    engine::host_normalized_embedding,
    methods::{reembedding_text, REEMBEDDING_FIELD},
    seams::Seam,
};
use crate::{
    contract::{
        Cancel, CancelReason, Cancelled, EmbedError, EmbedKind, EngineError, HostError,
        HostServices, MaintenanceGrant, MaintenanceMethod, MemoryOpError, MemoryOpErrorCode,
        StoreError, VectorSpaceIdentity,
    },
    ops::{
        migrate::MaintenanceAudit,
        reembedding::{
            backend::{self, BackendConfig, BackendError, GenerationBackend},
            coordinator::{CoordinatorError, MigrationLimits, ReembeddingCoordinator},
            coordinator_ports::{CopyBackend, MigrationProvider, MigrationRuntime},
            id_valid, projection,
            runtime::NativeRuntime,
            state::MigrationStateStore,
        },
    },
    store::directory::TrustedDirectory,
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Private process hook for the re-embedding process tests: while `<dir>/hold` exists, a
/// seam target batch waits (bounded, cancellable) after writing `<dir>/held`.
pub(super) const HOLD_VARIABLE: &str = "PLUR1BUS_TEST_REEMBEDDING_HOLD";
const HOLD_LIMIT: Duration = Duration::from_secs(60);

pub(super) struct Reembedding {
    host: Arc<dyn HostServices>,
    base: PathBuf,
    audit: Arc<dyn MaintenanceAudit>,
    seam: Option<SeamTarget>,
    coordinator: Mutex<Option<Arc<ReembeddingCoordinator>>>,
}

#[derive(Clone)]
struct SeamTarget {
    hold: Option<PathBuf>,
}

impl Reembedding {
    pub(super) fn new(
        host: Arc<dyn HostServices>,
        base: PathBuf,
        audit: Arc<dyn MaintenanceAudit>,
        seam: Option<Seam>,
        hold: Option<PathBuf>,
    ) -> Self {
        Self {
            host,
            base,
            audit,
            seam: seam.map(|_| SeamTarget { hold }),
            coordinator: Mutex::new(None),
        }
    }

    /// The composed coordinator. Construction only checks paths and reads the selected
    /// generation manifest; a failure is audited like any admitted call and answered closed.
    fn coordinator(
        &self,
        grant: &MaintenanceGrant,
        method: MaintenanceMethod,
        id: Option<&str>,
        cancel: &Cancel,
    ) -> Result<Arc<ReembeddingCoordinator>, EngineError> {
        grant.check(cancel)?;
        let mut slot = self
            .coordinator
            .lock()
            .map_err(|_| EngineError::from(StoreError::Unavailable))?;
        if let Some(coordinator) = slot.as_ref() {
            return Ok(coordinator.clone());
        }
        match self.compose() {
            Ok(coordinator) => {
                *slot = Some(coordinator.clone());
                Ok(coordinator)
            }
            Err(error) => {
                self.audit_refused(grant, method, id)?;
                Err(error)
            }
        }
    }

    /// The coordinator's own audit envelope for a call it never saw (composition failure, an
    /// unreadable request): method, Core link and only a valid migration ID, as `admit` does.
    fn audit_refused(
        &self,
        grant: &MaintenanceGrant,
        method: MaintenanceMethod,
        id: Option<&str>,
    ) -> Result<(), EngineError> {
        let target = id
            .filter(|id| id_valid(id))
            .map_or_else(|| json!({"invalid":true}), |id| json!({"id":id}));
        self.audit.append(&json!({"kind":"engine-maintenance","method":method.wire_name(),"actor":"core-maintenance","coreLink":grant.origin(),"target":target,"at":self.host.now_ms()}))
    }

    fn compose(&self) -> Result<Arc<ReembeddingCoordinator>, EngineError> {
        let config = backend_config(self.host.as_ref(), &self.base)?;
        let root = config.active_root.clone();
        let backend = Arc::new(GenerationBackend::new(config).map_err(backend_error)?);
        let state = Arc::new(MigrationStateStore::new(&self.base).map_err(|_| storage())?);
        let native = NativeRuntime::new(self.host.clone(), backend.clone(), &self.base)
            .map_err(|_| EngineError::from(HostError::Unavailable))?;
        let runtime: Arc<dyn MigrationRuntime> = match &self.seam {
            Some(seam) => Arc::new(SeamRuntime {
                inner: native,
                seam: seam.clone(),
            }),
            None => Arc::new(native),
        };
        let backend: Arc<dyn CopyBackend> = backend;
        Ok(Arc::new(
            ReembeddingCoordinator::new(
                state,
                backend,
                runtime,
                self.audit.clone(),
                MigrationLimits::default(),
            )
            .with_compaction_root(root),
        ))
    }

    pub(super) fn plan(
        &self,
        grant: &MaintenanceGrant,
        request: &Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        let id = request.get("id").and_then(Value::as_str);
        let coordinator = self.coordinator(grant, MaintenanceMethod::Plan, id, cancel)?;
        let Ok(raw) = parse_json(&request.to_string()) else {
            self.audit_refused(grant, MaintenanceMethod::Plan, id)?;
            return Err(invalid());
        };
        let planned = coordinator
            .plan(grant, &raw, cancel)
            .map_err(|error| failure(error, grant, cancel))?;
        let plan = planned.plan();
        // The operator proof goes to the Core once, as at the pin; state and audit keep its hash.
        Ok(json!({
            "plan": value(plan.plan())?,
            "planDigest": plan.digest(),
            "confirmation": {
                "token": plan.confirmation().expose_token(),
                "persisted": serde_json::to_value(plan.confirmation().persisted()).map_err(|_| storage())?,
            },
            "record": value(planned.record())?,
        }))
    }

    pub(super) fn apply(
        &self,
        grant: &MaintenanceGrant,
        request: &Value,
        cancel: &Cancel,
        resume: bool,
    ) -> Result<Value, EngineError> {
        let id = request.get("id").and_then(Value::as_str);
        let method = if resume {
            MaintenanceMethod::Resume
        } else {
            MaintenanceMethod::Apply
        };
        let coordinator = self.coordinator(grant, method, id, cancel)?;
        // A missing ID or proof goes to the coordinator as empty: it audits the call and refuses
        // it with its own categories (M-1).
        let id = id.unwrap_or_default();
        let token = request
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let outcome = if resume {
            coordinator.resume(grant, id, token, cancel)
        } else {
            coordinator.apply(grant, id, token, cancel)
        };
        value(&outcome.map_err(|error| failure(error, grant, cancel))?)
    }

    pub(super) fn status(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        let coordinator = self.coordinator(grant, MaintenanceMethod::Status, Some(id), cancel)?;
        match coordinator
            .status(grant, id, cancel)
            .map_err(|error| failure(error, grant, cancel))?
        {
            Some(record) => value(&record),
            None => Ok(Value::Null),
        }
    }

    pub(super) fn validate(
        &self,
        grant: &MaintenanceGrant,
        id: &str,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        let coordinator = self.coordinator(grant, MaintenanceMethod::Validate, Some(id), cancel)?;
        let outcome = coordinator.validate(grant, id, cancel);
        value(&outcome.map_err(|error| failure(error, grant, cancel))?)
    }
}

/// The pin's backend roots: the store base is the state root, the active data root and shared
/// base follow the namespace layout, inside the selected generation when one is configured.
fn backend_config(host: &dyn HostServices, base: &Path) -> Result<BackendConfig, EngineError> {
    let config = host.config();
    let raw = serde_json::to_value(&config).map_err(|_| invalid())?;
    let normalized = host_normalized_embedding(&raw, host)?;
    let fingerprint = crate::embedding::fingerprint::fingerprint_from_normalized(&normalized)
        .map_err(|_| invalid())?;
    let fingerprint_id = crate::embedding::fingerprint::fingerprint_record_id(&fingerprint)
        .map_err(|_| invalid())?;
    let (layout_base, writer) = crate::recall::namespaces::writer_layout(base, &config)?;
    let (selection, selection_text, generation, data_root) = match &config.reembedding {
        None => (
            json!({"mode":"legacy"}),
            r#"{"mode":"legacy"}"#.to_owned(),
            "legacy-active".to_owned(),
            layout_base,
        ),
        Some(selected) => {
            let id = selected.active_generation.clone();
            backend::generation(&id).map_err(backend_error)?;
            if selected.fingerprint_id != fingerprint_id
                || selected.dimensions.as_f64() != fingerprint["dimensions"].as_f64()
            {
                return Err(StoreError::IdentityMismatch.into());
            }
            let root = TrustedDirectory::open(&layout_base)?
                .open_child("generations")?
                .open_child(&id)?;
            let manifest = backend::read_generation_manifest(&root, &id)?;
            if manifest["fingerprintId"] != fingerprint_id.as_str()
                || manifest["dimensions"].as_f64() != selected.dimensions.as_f64()
            {
                return Err(StoreError::IdentityMismatch.into());
            }
            let text = format!(
                r#"{{"mode":"generation","generation":{}}}"#,
                serde_json::to_string(&id).map_err(|_| invalid())?
            );
            (
                json!({"mode":"generation","generation":id}),
                text,
                id,
                root.path().to_owned(),
            )
        }
    };
    let active_root = writer
        .as_ref()
        .map_or_else(|| data_root.clone(), |name| data_root.join(name));
    // Node: sha256(JSON.stringify({fingerprintId, selection, namespaceMode, activeWriteNamespace})).
    let revision = format!(
        r#"{{"fingerprintId":{},"selection":{},"namespaceMode":{},"activeWriteNamespace":{}}}"#,
        serde_json::to_string(&fingerprint_id).map_err(|_| invalid())?,
        selection_text,
        if writer.is_some() {
            r#""named""#
        } else {
            r#""legacy-flat""#
        },
        serde_json::to_string(&writer).map_err(|_| invalid())?,
    );
    Ok(BackendConfig {
        state_root: base.to_owned(),
        active_root,
        active_shared_base: data_root,
        namespace: writer,
        active_generation: generation,
        active_selection: selection,
        active_fingerprint: fingerprint,
        active_secret_ref: projection::redacted_secret_ref(normalized.as_value())
            .map_err(|_| invalid())?,
        config_revision: Some(format!("{:x}", Sha256::digest(revision.as_bytes()))),
    })
}

fn value(raw: &Json) -> Result<Value, EngineError> {
    serde_json::from_str(&write_json(raw)).map_err(|_| storage())
}

fn invalid() -> EngineError {
    MemoryOpError::new(MemoryOpErrorCode::InvalidInput).into()
}

fn storage() -> EngineError {
    MemoryOpError::new(MemoryOpErrorCode::Storage).into()
}

fn code(code: MemoryOpErrorCode) -> EngineError {
    MemoryOpError::new(code).into()
}

fn backend_error(error: BackendError) -> EngineError {
    match error {
        BackendError::Invalid => invalid(),
        BackendError::Exists | BackendError::Conflict | BackendError::Drift => {
            code(MemoryOpErrorCode::Conflict)
        }
        BackendError::UnsafePath => StoreError::UntrustedPath.into(),
        BackendError::Busy => code(MemoryOpErrorCode::LockBusy),
        BackendError::Cancelled => EngineError::Cancelled(Cancelled {
            reason: CancelReason::Caller,
        }),
        BackendError::Closed => EngineError::NotAvailable {
            reason: "closed".into(),
        },
        BackendError::Storage => storage(),
    }
}

/// One of the pin's fixed texts the Core's driver classifies (RE-D166/R1): carried in the
/// existing `Invalid` variant and sent by `dispatch_maintenance` only from its static allowlist.
fn classified(category: &str) -> EngineError {
    EngineError::Invalid {
        field: REEMBEDDING_FIELD.into(),
        message: category.into(),
    }
}

/// The coordinator's fixed categories onto the existing wire vocabulary; no record, path or
/// provider body reaches the error. Source drift, a changed policy, an invalid confirmation,
/// an unchanged fingerprint and another active migration keep the pin's own text (R1).
fn failure(error: CoordinatorError, grant: &MaintenanceGrant, cancel: &Cancel) -> EngineError {
    match error {
        CoordinatorError::Invalid(category) if reembedding_text(category).is_some() => {
            classified(category)
        }
        CoordinatorError::State("reembedding_active_conflict") => {
            classified("another reembedding migration is active")
        }
        CoordinatorError::Invalid(category) => match category {
            "target generation already belongs to a migration"
            | "existing target generation does not match the migration plan" => {
                code(MemoryOpErrorCode::Conflict)
            }
            "reembedding migration not found" => code(MemoryOpErrorCode::NotFound),
            _ => invalid(),
        },
        CoordinatorError::State(category) => match category {
            "reembedding_revision_conflict" => code(MemoryOpErrorCode::Conflict),
            "busy" => code(MemoryOpErrorCode::LockBusy),
            "invalid" => invalid(),
            "cancelled" => cancelled(grant, cancel),
            _ => storage(),
        },
        CoordinatorError::Backend(BackendError::Cancelled) | CoordinatorError::Cancelled => {
            cancelled(grant, cancel)
        }
        CoordinatorError::Backend(error) => backend_error(error),
        CoordinatorError::Provider => EmbedError::Unavailable.into(),
        CoordinatorError::Host => HostError::Unavailable.into(),
        CoordinatorError::Cleanup { .. } | CoordinatorError::Audit => storage(),
        CoordinatorError::Busy => code(MemoryOpErrorCode::LockBusy),
        CoordinatorError::Closed => EngineError::NotAvailable {
            reason: "closed".into(),
        },
    }
}

/// The revoked link or caller cancellation that ended the call; otherwise the coordinator's
/// own operation deadline.
fn cancelled(grant: &MaintenanceGrant, cancel: &Cancel) -> EngineError {
    grant
        .check(cancel)
        .err()
        .unwrap_or(EngineError::Cancelled(Cancelled {
            reason: CancelReason::Deadline,
        }))
}

/// The pin's test-only `reembeddingTargetProvider`: a flat unit vector of the target width,
/// so a migration under a process seam never loads or calls a target model. Every other
/// capability is the production runtime's.
struct SeamRuntime {
    inner: NativeRuntime,
    seam: SeamTarget,
}

impl MigrationRuntime for SeamRuntime {
    fn now_ms(&self) -> i64 {
        self.inner.now_ms()
    }
    fn free_bytes(&self, cancel: &Cancel) -> Result<u64, CoordinatorError> {
        self.inner.free_bytes(cancel)
    }
    fn artifacts_verified(
        &self,
        fingerprint: &Json,
        cancel: &Cancel,
    ) -> Result<bool, CoordinatorError> {
        self.inner.artifacts_verified(fingerprint, cancel)
    }
    fn plan_probe(&self, target: &Json, cancel: &Cancel) -> Result<Vec<f64>, CoordinatorError> {
        let provider = self.target(target, cancel)?;
        let mut vectors = provider.vectors(1);
        vectors.pop().ok_or(CoordinatorError::Provider)
    }
    fn create_provider(
        &self,
        target: &Json,
        cancel: &Cancel,
    ) -> Result<Box<dyn MigrationProvider>, CoordinatorError> {
        Ok(Box::new(self.target(target, cancel)?))
    }
    fn policy_snapshot(&self, cancel: &Cancel) -> Result<Option<Json>, CoordinatorError> {
        self.inner.policy_snapshot(cancel)
    }
    fn validate_probes(
        &self,
        record: &Json,
        provider: &dyn MigrationProvider,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        self.inner.validate_probes(record, provider, cancel)
    }
}

impl SeamRuntime {
    fn target(&self, target: &Json, cancel: &Cancel) -> Result<FlatTarget, CoordinatorError> {
        cancel.check().map_err(|_| CoordinatorError::Cancelled)?;
        let target: Value = serde_json::from_str(&write_json(target))
            .map_err(|_| CoordinatorError::Invalid("invalid target provider specification"))?;
        let fingerprint = &target["fingerprint"];
        let width = fingerprint["dimensions"]
            .as_u64()
            .and_then(|width| usize::try_from(width).ok())
            .filter(|width| *width > 0)
            .ok_or(CoordinatorError::Invalid("invalid target dimensions"))?;
        let identity = crate::embedding::identity::identity_from_value(fingerprint)
            .map_err(|_| CoordinatorError::Provider)?;
        let (identity, _, _) = crate::store::identity::canonical_identity(&identity)
            .map_err(|_| CoordinatorError::Provider)?;
        Ok(FlatTarget {
            identity,
            width,
            hold: self.seam.hold.clone(),
        })
    }
}

struct FlatTarget {
    identity: VectorSpaceIdentity,
    width: usize,
    hold: Option<PathBuf>,
}

impl FlatTarget {
    fn vectors(&self, count: usize) -> Vec<Vec<f64>> {
        let mut vector = vec![0.0; self.width];
        vector[0] = 1.0;
        vec![vector; count]
    }

    /// Bounded and cancellable: the caller's cancellation or the hook's limit ends the wait.
    fn wait_hold(&self, cancel: &Cancel) -> Result<(), CoordinatorError> {
        let Some(directory) = &self.hold else {
            return Ok(());
        };
        let hold = directory.join("hold");
        if !hold.exists() {
            return Ok(());
        }
        std::fs::write(directory.join("held"), b"").map_err(|_| CoordinatorError::Provider)?;
        let until = Instant::now() + HOLD_LIMIT;
        while hold.exists() {
            if cancel.check().is_err() {
                // Proof for the process tests that the revoked grant, not the process end,
                // ended the batch.
                let _ = std::fs::write(directory.join("cancelled"), b"");
                return Err(CoordinatorError::Cancelled);
            }
            if Instant::now() >= until {
                return Err(CoordinatorError::Provider);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}

impl MigrationProvider for FlatTarget {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f64>>, CoordinatorError> {
        cancel.check().map_err(|_| CoordinatorError::Cancelled)?;
        if kind == EmbedKind::Passage {
            self.wait_hold(cancel)?;
        }
        cancel.check().map_err(|_| CoordinatorError::Cancelled)?;
        Ok(self.vectors(texts.len()))
    }
    fn close(&self) -> Result<(), CoordinatorError> {
        Ok(())
    }
}
