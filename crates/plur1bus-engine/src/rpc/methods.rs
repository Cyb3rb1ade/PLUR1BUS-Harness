//! Typed method dispatch and bounded, body-free failures for the engine endpoint.

use crate::contract::{
    AgentContext, Cancel, CancelReason, EmbedError, Engine, EngineError, HistoryFilter, HostError,
    MaintenanceGrant, MaintenanceMethod, MaintenanceOps, MemoryCurationAction, MemoryOpErrorCode,
    Principal, RunOptions, SnapshotFailure, SnapshotGrant, SnapshotMethod, SnapshotOps, StoreError,
};
use crate::ops::snapshot::SnapshotError;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// A JSON-RPC failure containing only fixed diagnostic vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WireError {
    pub(crate) code: i32,
    pub(crate) error: &'static str,
    pub(crate) reason: &'static str,
    pub(crate) message: &'static str,
    pub(crate) ids: Option<BTreeMap<String, String>>,
}

impl WireError {
    fn application(error: &'static str, reason: &'static str, message: &'static str) -> Self {
        Self {
            code: -32000,
            error,
            reason,
            message,
            ids: None,
        }
    }

    pub(crate) fn invalid_params() -> Self {
        Self {
            code: -32602,
            error: "E_INVALID_PARAMS",
            reason: "invalid-input",
            message: "invalid engine method parameters",
            ids: None,
        }
    }

    pub(crate) fn not_available() -> Self {
        Self::application(
            "E_NOT_AVAILABLE",
            "operation-unavailable",
            "engine operation unavailable",
        )
    }

    pub(crate) fn engine_busy() -> Self {
        Self::application(
            "E_NOT_AVAILABLE",
            "engine-busy",
            "engine request capacity is busy",
        )
    }

    pub(crate) fn response_too_large() -> Self {
        Self {
            reason: "response-too-large",
            message: "engine response exceeds frame limit",
            ..Self::invalid_params()
        }
    }

    pub(crate) fn internal() -> Self {
        Self::application("E_INTERNAL", "internal", "engine operation failed")
    }

    pub(crate) fn method_not_found() -> Self {
        Self {
            code: -32601,
            error: "E_INTERNAL",
            reason: "method-not-found",
            message: "engine method not found",
            ids: None,
        }
    }

    fn cancelled(reason: CancelReason) -> Self {
        Self::application(
            "E_NOT_AVAILABLE",
            match reason {
                CancelReason::Caller => "aborted",
                CancelReason::Deadline => "timeout",
            },
            "engine operation cancelled",
        )
    }
}

impl From<EngineError> for WireError {
    fn from(error: EngineError) -> Self {
        match error {
            EngineError::Cancelled(error)
            | EngineError::Embedding(EmbedError::Cancelled(error))
            | EngineError::Host(HostError::Cancelled(error)) => Self::cancelled(error.reason),
            EngineError::Invalid { .. } | EngineError::Store(StoreError::InvalidInput) => {
                Self::invalid_params()
            }
            EngineError::NotAvailable { reason } => Self::application(
                "E_NOT_AVAILABLE",
                match reason.as_str() {
                    "composition-pending" => "composition-pending",
                    "closed" => "closed",
                    "engine-closed" => "engine-closed",
                    "embedding-unavailable" => "embedding-unavailable",
                    "reranker-unavailable" => "reranker-unavailable",
                    "host-unavailable" => "host-unavailable",
                    // The server's saturation reason, also a mutation gate still held after
                    // its wait (RE-D165): temporarily busy, retry.
                    "engine-busy" => "engine-busy",
                    _ => "operation-unavailable",
                },
                "engine operation unavailable",
            ),
            EngineError::Store(error) => match error {
                StoreError::IdentityMismatch => Self::application(
                    "E_CONFLICT",
                    "embedding-identity-mismatch",
                    "embedding identity mismatch",
                ),
                StoreError::Unavailable => Self::application(
                    "E_NOT_AVAILABLE",
                    "store-unavailable",
                    "engine store unavailable",
                ),
                StoreError::Corrupt => Self::application(
                    "E_STORAGE",
                    "store-corrupt",
                    "engine store metadata is invalid",
                ),
                StoreError::Busy => {
                    Self::application("E_LOCKED", "lock-busy", "engine store is busy")
                }
                StoreError::ReadOnly => {
                    Self::application("E_DENIED", "read-only", "engine store is read-only")
                }
                StoreError::UntrustedPath => Self::application(
                    "E_DENIED",
                    "untrusted-path",
                    "engine store path is not trusted",
                ),
                StoreError::TombstoneBlocked => Self::application(
                    "E_CONFLICT",
                    "tombstone-blocked",
                    "engine write blocked by tombstone",
                ),
                StoreError::Io { .. } => {
                    Self::application("E_STORAGE", "store-io", "engine store operation failed")
                }
                StoreError::InvalidInput => Self::invalid_params(),
            },
            EngineError::Embedding(error) => match error {
                EmbedError::Unavailable => Self::application(
                    "E_NOT_AVAILABLE",
                    "embedding-unavailable",
                    "embedding provider unavailable",
                ),
                EmbedError::ProviderFailed { .. } => Self::application(
                    "E_NOT_AVAILABLE",
                    "provider-failed",
                    "embedding provider failed",
                ),
                EmbedError::InvalidVector | EmbedError::DimensionMismatch { .. } => {
                    Self::application(
                        "E_NOT_AVAILABLE",
                        "invalid-vector",
                        "embedding provider returned an invalid vector",
                    )
                }
                EmbedError::Cancelled(error) => Self::cancelled(error.reason),
            },
            EngineError::Host(error) => match error {
                HostError::Unavailable => Self::application(
                    "E_NOT_AVAILABLE",
                    "host-unavailable",
                    "engine host service unavailable",
                ),
                HostError::Denied => Self::application(
                    "E_DENIED",
                    "host-denied",
                    "engine host policy denied the operation",
                ),
                HostError::InvalidResponse => Self::application(
                    "E_INTERNAL",
                    "host-invalid-response",
                    "engine host returned an invalid response",
                ),
                HostError::Failed => {
                    Self::application("E_INTERNAL", "host-failed", "engine host operation failed")
                }
                HostError::Cancelled(error) => Self::cancelled(error.reason),
            },
            EngineError::MemoryOp(error) => {
                let (code, reason) = match &error.code {
                    MemoryOpErrorCode::NotFound => ("E_NOT_FOUND", "not-found"),
                    MemoryOpErrorCode::Denied => ("E_DENIED", "denied"),
                    MemoryOpErrorCode::InvalidInput => ("E_INVALID_PARAMS", "invalid-input"),
                    MemoryOpErrorCode::ApprovalRequired => {
                        ("E_APPROVAL_REQUIRED", "approval-required")
                    }
                    MemoryOpErrorCode::Conflict => ("E_CONFLICT", "conflict"),
                    MemoryOpErrorCode::Storage => ("E_STORAGE", "storage"),
                    MemoryOpErrorCode::Unsupported => ("E_NOT_AVAILABLE", "unsupported"),
                    MemoryOpErrorCode::IdentityAlreadyBound => {
                        ("E_CONFLICT", "identity-already-bound")
                    }
                    MemoryOpErrorCode::LedgerCorrupt => ("E_STORAGE", "ledger-corrupt"),
                    MemoryOpErrorCode::LockLost => ("E_LOCKED", "lock-lost"),
                    MemoryOpErrorCode::LockBusy => ("E_LOCKED", "lock-busy"),
                    MemoryOpErrorCode::EmbedderUnavailable => {
                        ("E_NOT_AVAILABLE", "EMBEDDER_UNAVAILABLE")
                    }
                    MemoryOpErrorCode::EmbeddingIdentityMismatch => {
                        ("E_CONFLICT", "EMBEDDING_IDENTITY_MISMATCH")
                    }
                };
                let mut wire = Self::application(code, reason, "engine memory operation failed");
                if code == "E_INVALID_PARAMS" {
                    wire.code = -32602;
                }
                if !error.detail().is_empty() {
                    wire.ids = Some(
                        error
                            .detail()
                            .iter()
                            .map(|(name, value)| {
                                (name.as_str().to_owned(), value.as_str().to_owned())
                            })
                            .collect(),
                    );
                }
                wire
            }
        }
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, WireError> {
    serde_json::from_value(value).map_err(|_| WireError::invalid_params())
}

fn required<T: DeserializeOwned>(params: &Value, name: &str) -> Result<T, WireError> {
    decode(
        params
            .get(name)
            .ok_or_else(WireError::invalid_params)?
            .clone(),
    )
}

fn optional_object<T: DeserializeOwned>(params: &Value, name: &str) -> Result<T, WireError> {
    decode(params.get(name).cloned().unwrap_or_else(|| json!({})))
}

fn string<'a>(params: &'a Value, name: &str) -> Result<&'a str, WireError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(WireError::invalid_params)
}

fn encode(value: impl Serialize) -> Result<Value, WireError> {
    serde_json::to_value(value).map_err(|_| WireError::internal())
}

fn result(value: Result<impl Serialize, EngineError>) -> Result<Value, WireError> {
    encode(value.map_err(WireError::from)?)
}

/// The field of an `EngineError::Invalid` that carries one of the fixed re-embedding texts.
pub(crate) const REEMBEDDING_FIELD: &str = "engine.reembedding";

/// RE-D166/R1: the only re-embedding texts that reach the wire. Each is the pin's own constant
/// (`9f34008c`), which the Core's migration driver (`packages/core/src/embedding-migrate/driver.ts`)
/// classifies by text. No text is built from request or store data; any other re-embedding
/// failure keeps the generic text of its class. Fixture: `tests/fixtures/ops/reembedding-wire-errors.json`.
pub(crate) const REEMBEDDING_ERRORS: [(&str, &str, &str); 7] = [
    // lib/reembedding/coordinator.js:120; driver.ts:114 → source-drift (final).
    (
        "reembedding source generation drift",
        "E_CONFLICT",
        "conflict",
    ),
    // coordinator.js:123; driver.ts:114 → source-drift (final).
    (
        "reembedding source config revision drift",
        "E_CONFLICT",
        "conflict",
    ),
    // coordinator.js:128, without the `: <tableId>` suffix; driver.ts:114 → source-drift (final).
    ("reembedding source version drift", "E_CONFLICT", "conflict"),
    // coordinator.js:133; driver.ts:114 → source-drift (final).
    (
        "reembedding workspace policy changed; explicit resume required",
        "E_CONFLICT",
        "conflict",
    ),
    // coordinator.js:220,303,321; driver.ts:115 → confirmation-invalid (final).
    (
        "invalid or expired reembedding confirmation",
        "E_INVALID_PARAMS",
        "invalid-input",
    ),
    // planner.js:115; driver.ts:183 → nothing to migrate (compatible).
    (
        "reembedding plan does not change the embedding fingerprint",
        "E_INVALID_PARAMS",
        "invalid-input",
    ),
    // state-store.js:247; driver.ts:187 → migration-active with its expiry.
    (
        "another reembedding migration is active",
        "E_CONFLICT",
        "conflict",
    ),
];

/// The allowlisted static text for a re-embedding failure category, if any.
pub(crate) fn reembedding_text(category: &str) -> Option<&'static str> {
    REEMBEDDING_ERRORS
        .iter()
        .find(|(text, _, _)| *text == category)
        .map(|(text, _, _)| *text)
}

fn maintenance_error(error: EngineError) -> WireError {
    if let EngineError::Invalid { field, message } = &error {
        if field == REEMBEDDING_FIELD {
            if let Some((text, code, reason)) = REEMBEDDING_ERRORS
                .iter()
                .find(|(text, _, _)| *text == message.as_str())
            {
                let mut wire = WireError::application(code, reason, text);
                if *code == "E_INVALID_PARAMS" {
                    wire.code = -32602;
                }
                return wire;
            }
        }
    }
    WireError::from(error)
}

fn maintenance_result(value: Result<Value, EngineError>) -> Result<Value, WireError> {
    value.map_err(maintenance_error)
}

/// Only the authenticated server adapter can supply a maintenance grant.
pub(super) fn dispatch_maintenance(
    operations: &dyn MaintenanceOps,
    method: MaintenanceMethod,
    params: &Value,
    grant: &MaintenanceGrant,
    cancel: &Cancel,
) -> Result<Value, WireError> {
    let request = || {
        params
            .get("request")
            .cloned()
            .ok_or_else(WireError::not_available)
    };
    match method {
        MaintenanceMethod::Migrate => result(operations.migrate(
            grant,
            required(params, "from")?,
            required(params, "to")?,
            cancel,
        )),
        MaintenanceMethod::Plan => maintenance_result(operations.plan(grant, request()?, cancel)),
        MaintenanceMethod::Apply => maintenance_result(operations.apply(grant, request()?, cancel)),
        MaintenanceMethod::Resume => {
            maintenance_result(operations.resume(grant, request()?, cancel))
        }
        MaintenanceMethod::Status => {
            let id = params["id"].as_str().ok_or_else(WireError::not_available)?;
            maintenance_result(operations.status(grant, id, cancel))
        }
        MaintenanceMethod::Validate => {
            let id = params["request"]["id"]
                .as_str()
                .ok_or_else(WireError::not_available)?;
            maintenance_result(operations.validate(grant, id, cancel))
        }
        MaintenanceMethod::Switch | MaintenanceMethod::Rollback => {
            let request = request()?;
            let field = |name| request[name].as_str().ok_or_else(WireError::invalid_params);
            let id = field("id")?;
            if method == MaintenanceMethod::Switch {
                maintenance_result(operations.switch_selection(grant, id, field("token")?, cancel))
            } else {
                maintenance_result(operations.rollback_plan(grant, id, field("newId")?, cancel))
            }
        }
    }
}

/// RE-D170: the snapshot categories on the wire, as the Core's `admin.backup.snapshot`
/// reports `source-busy` and `insufficient-disk` (E_STORAGE).
fn snapshot_error(failure: SnapshotFailure) -> WireError {
    let error = match failure {
        SnapshotFailure::Engine(error) => return WireError::from(error),
        SnapshotFailure::Snapshot(error) => error,
    };
    let code = match error {
        SnapshotError::NotFound => "E_NOT_FOUND",
        SnapshotError::UnsafePath => "E_DENIED",
        SnapshotError::Cancelled => return WireError::cancelled(CancelReason::Caller),
        SnapshotError::DigestMismatch
        | SnapshotError::SourceBusy
        | SnapshotError::InsufficientDisk
        | SnapshotError::Storage => "E_STORAGE",
    };
    WireError::application(code, error.reason(), "engine snapshot operation failed")
}

/// The three snapshot methods outside the grant branch: never served (RE-D170).
pub(crate) fn core_link_required() -> WireError {
    WireError::application(
        "E_UNAUTHORIZED",
        "core-link-required",
        "engine authentication required",
    )
}

/// Only the authenticated server adapter can supply a snapshot grant.
pub(super) fn dispatch_snapshot(
    operations: &dyn SnapshotOps,
    method: SnapshotMethod,
    params: &Value,
    grant: &SnapshotGrant,
    cancel: &Cancel,
) -> Result<Value, WireError> {
    let path = |name: &str| match string(params, name) {
        Ok(path) => Ok(std::path::Path::new(path)),
        Err(_) => Err(refuse_snapshot(operations, method, grant, cancel)),
    };
    match method {
        SnapshotMethod::Create => {
            operations.create(grant, path("out")?, params["label"].as_str(), cancel)
        }
        SnapshotMethod::Verify => operations.verify(grant, path("dir")?, cancel),
        SnapshotMethod::Reapply => operations.reapply(grant, cancel),
    }
    .map_err(snapshot_error)
}

/// Invalid parameters of a granted snapshot call: audited as `{"invalid":true}` (create and
/// reapply), then answered as invalid. A failed audit answers its own failure.
pub(super) fn refuse_snapshot(
    operations: &dyn SnapshotOps,
    method: SnapshotMethod,
    grant: &SnapshotGrant,
    cancel: &Cancel,
) -> WireError {
    match operations.refuse(grant, method, cancel) {
        Ok(()) => WireError::invalid_params(),
        Err(failure) => snapshot_error(failure),
    }
}

fn projection(params: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|name| {
                params
                    .get(*name)
                    .cloned()
                    .map(|value| ((*name).to_owned(), value))
            })
            .collect::<Map<String, Value>>(),
    )
}

fn refresh(params: &Value) -> Result<bool, WireError> {
    params
        .get("refresh")
        .map(|value| decode(value.clone()))
        .unwrap_or(Ok(false))
}

fn top_n(params: &Value) -> Result<usize, WireError> {
    let number = params
        .get("topN")
        .and_then(Value::as_f64)
        .ok_or_else(WireError::invalid_params)?;
    // The wire says number but the native service requires an exact, representable count.
    if number < 0.0 || number.fract() != 0.0 || number >= usize::MAX as f64 {
        return Err(WireError::invalid_params());
    }
    Ok(number as usize)
}

/// Dispatch validated schema parameters through the existing native service ports.
/// Process authentication, lifecycle handles and capture receipts belong to the server.
pub(crate) fn dispatch(
    engine: &dyn Engine,
    method: &str,
    params: &Value,
    cancel: &Cancel,
) -> Result<Value, WireError> {
    // Bound native embedding/rerank allocations independently of the NDJSON input
    // limit: short texts can produce much larger vector responses.
    let batch_field = match method {
        "engine.embedding.embed" => Some("texts"),
        "engine.embedding.rerank" => Some("docs"),
        _ => None,
    };
    if batch_field
        .and_then(|field| params.get(field))
        .and_then(Value::as_array)
        .is_some_and(|values| values.len() > 128)
    {
        return Err(WireError {
            reason: "embedding-batch-too-large",
            message: "embedding batch exceeds 128 items",
            ..WireError::invalid_params()
        });
    }
    // Cancel-aware ports own their cancellation result: recall can degrade, and
    // a job registry can record a skipped run. Preserve those native semantics.
    if !matches!(
        method,
        "engine.recall"
            | "engine.jobs.run"
            | "engine.embedding.embed"
            | "engine.embedding.rerank"
            | "engine.embedding.probe"
            | "engine.models.warm"
            | "engine.memory.import"
            | "engine.memory.rebind"
            | "engine.memory.unbind"
            | "engine.memory.unimport"
    ) {
        cancel
            .check()
            .map_err(|error| WireError::cancelled(error.reason))?;
    }
    match method {
        "engine.recall" => result(engine.recall(
            required(params, "query")?,
            optional_object(params, "options")?,
            cancel,
        )),
        "engine.checkpoint" => {
            result(engine.checkpoint(&required(params, "agentId")?, required(params, "reason")?))
        }
        "engine.systemSupplement" => encode(engine.system_supplement()),
        "engine.jobs.list" => encode(engine.jobs().list()),
        "engine.jobs.run" => {
            let opts: RunOptions = decode(projection(params, &["trigger", "dryRun"]))?;
            result(engine.jobs().run(
                required(params, "job")?,
                &required(params, "agentId")?,
                opts,
                cancel,
            ))
        }
        "engine.jobs.history" => {
            let filter: HistoryFilter = decode(projection(params, &["job", "since", "limit"]))?;
            result(engine.jobs().history(&required(params, "agentId")?, filter))
        }
        "engine.embedding.embed" => result(engine.embedding().embed(
            &required::<Vec<String>>(params, "texts")?,
            required(params, "kind")?,
            &required(params, "identity")?,
            cancel,
        )),
        "engine.embedding.rerank" => result(engine.embedding().rerank(
            string(params, "query")?,
            &required::<Vec<String>>(params, "docs")?,
            top_n(params)?,
            cancel,
        )),
        "engine.embedding.probe" => result(engine.embedding().probe(refresh(params)?, cancel)),
        "engine.embedding.identities" => encode(engine.embedding().identities()),
        "engine.embedding.serve" => {
            // RE-03's native port only describes its existing in-process transport;
            // it cannot honor the wire's optional listener address.
            if params.get("address").is_some() {
                return Err(WireError::not_available());
            }
            result(engine.embedding().serve())
        }
        "engine.embedding.fingerprint" => {
            let normalized = required(params, "normalized")?;
            let fingerprint_id = crate::embedding::fingerprint::try_fingerprint_id(&normalized)
                .map_err(|_| WireError::invalid_params())?;
            Ok(json!({"fingerprintId": fingerprint_id}))
        }
        "engine.config.normalizeEmbedding" => {
            let raw = params.get("raw").ok_or_else(WireError::invalid_params)?;
            let normalized = crate::embedding::normalize::normalize_embedding_config(raw)
                .map_err(|_| WireError::invalid_params())?;
            Ok(json!({"normalized": normalized}))
        }
        "engine.models" | "engine.models.status" => encode(engine.models().status()),
        "engine.models.warm" => result(engine.models().warm(cancel, refresh(params)?)),
        "engine.stores.adopt" => result(engine.stores().adopt(required(params, "req")?)),
        // RE-D170: served only through the server's Core snapshot grant branch.
        "engine.snapshot.create" | "engine.snapshot.verify" | "engine.tombstones.reapply" => {
            Err(core_link_required())
        }
        // These frozen native methods require a principal/context that this wire
        // contract does not carry. RE-07 must supply an explicit adapter. Its
        // runtime re-embedding request/id arguments must also remain unconsumed.
        "engine.admin.reembedding.plan"
        | "engine.admin.reembedding.apply"
        | "engine.admin.reembedding.resume"
        | "engine.admin.reembedding.validate"
        | "engine.admin.reembedding.rollback"
        | "engine.admin.reembedding.status"
        | "engine.admin.reembedding.switch"
        | "engine.admin.workspacePolicy.get"
        | "engine.admin.workspacePolicy.list"
        | "engine.admin.workspacePolicy.set"
        | "engine.admin.migrate" => Err(WireError::not_available()),
        name if name.starts_with("engine.memory.")
            || matches!(
                name,
                "engine.admin.share"
                    | "engine.admin.forget"
                    | "engine.admin.obsidian.detect"
                    | "engine.admin.obsidian.prepare"
                    | "engine.admin.obsidian.confirm"
            ) =>
        {
            let principal: Principal = required(params, "p")?;
            let agent: AgentContext = required(params, "a")?;
            dispatch_contextual(engine, method, params, cancel, &principal, &agent)
        }
        _ => Err(WireError::method_not_found()),
    }
}

fn dispatch_contextual(
    engine: &dyn Engine,
    method: &str,
    params: &Value,
    cancel: &Cancel,
    principal: &Principal,
    agent: &AgentContext,
) -> Result<Value, WireError> {
    let memory = engine.memory();
    match method {
        "engine.memory.list" => result(memory.list(required(params, "q")?, principal, agent)),
        "engine.memory.show" => result(memory.show(string(params, "id")?, principal, agent)),
        "engine.memory.forget" => result(memory.forget(string(params, "id")?, principal, agent)),
        "engine.memory.correct" => result(memory.correct(
            string(params, "id")?,
            string(params, "newText")?,
            principal,
            agent,
        )),
        "engine.memory.share" => result(memory.share(
            string(params, "id")?,
            required(params, "target")?,
            optional_object(params, "opts")?,
            principal,
            agent,
        )),
        "engine.memory.state" => result(memory.state(principal, agent)),
        "engine.memory.propose" => result(memory.propose(
            string(params, "sharedId")?,
            string(params, "newText")?,
            optional_object(params, "opts")?,
            principal,
            agent,
        )),
        "engine.memory.proposals.list" => result(memory.proposals().list(
            required(params, "q")?,
            principal,
            agent,
        )),
        "engine.memory.proposals.accept" => result(memory.proposals().accept(
            string(params, "proposalId")?,
            principal,
            agent,
        )),
        "engine.memory.proposals.reject" => result(memory.proposals().reject(
            string(params, "proposalId")?,
            optional_object(params, "opts")?,
            principal,
            agent,
        )),
        "engine.memory.import" => {
            result(memory.import(required(params, "req")?, cancel, principal, agent))
        }
        "engine.memory.rebind" => {
            result(memory.rebind(required(params, "req")?, cancel, principal, agent))
        }
        "engine.memory.unbind" => {
            result(memory.unbind(required(params, "req")?, cancel, principal, agent))
        }
        "engine.memory.unimport" => {
            result(memory.unimport(required(params, "req")?, cancel, principal, agent))
        }
        "engine.memory.link" => result(memory.link(
            string(params, "id")?,
            required(params, "req")?,
            principal,
            agent,
        )),
        "engine.memory.stats" => {
            let ids: Option<Vec<String>> = params.get("ids").cloned().map(decode).transpose()?;
            result(memory.stats(ids.as_deref(), principal, agent))
        }
        "engine.memory.promote" => {
            result(memory.promote(required(params, "req")?, principal, agent))
        }
        "engine.memory.curation.list" => result(memory.curation().list(
            required(params, "q")?,
            principal,
            agent,
        )),
        "engine.memory.curation.resolve"
        | "engine.memory.curation.keep"
        | "engine.memory.curation.drop" => {
            let action = match method {
                "engine.memory.curation.keep" => MemoryCurationAction::Keep,
                "engine.memory.curation.drop" => MemoryCurationAction::Drop,
                _ => required(params, "action")?,
            };
            result(
                memory
                    .curation()
                    .resolve(string(params, "id")?, action, principal, agent),
            )
        }
        "engine.admin.share" => result(engine.admin().share(
            string(params, "id")?,
            required(params, "target")?,
            optional_object(params, "opts")?,
            principal,
            agent,
        )),
        "engine.admin.forget" => result(engine.admin().forget(
            string(params, "id")?,
            principal,
            agent,
        )),
        "engine.admin.obsidian.detect" => result(engine.admin().obsidian().detect(
            optional_object(params, "opts")?,
            principal,
            agent,
        )),
        "engine.admin.obsidian.prepare" => result(engine.admin().obsidian().prepare(
            string(params, "vaultPath")?,
            principal,
            agent,
        )),
        "engine.admin.obsidian.confirm" => result(engine.admin().obsidian().confirm(
            string(params, "nonce")?,
            principal,
            agent,
        )),
        _ => Err(WireError::method_not_found()),
    }
}

#[cfg(test)]
mod tests {
    // Tests fail immediately on invalid fixtures or failed cleanup; no unchecked values reach production.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::{
        contract::{testing::FakeHost, MemoryOpError},
        rpc::{engine::ProcessEngine, seams::Seam},
    };
    use std::sync::Arc;

    fn engine() -> (tempfile::TempDir, ProcessEngine) {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let config = serde_json::from_value(json!({})).unwrap();
        let host = Arc::new(FakeHost::new(root.path().into(), config));
        let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
        (root, engine)
    }

    fn context() -> Value {
        json!({
            "p": {"agentId":"main","workspace":"workspace:v1:test","channel":"test",
                "accountId":"test","chat":{"id":"test","kind":"direct"},"trust":"proved"},
            "a": {"origin":"user","background":false}
        })
    }

    #[test]
    fn errors_retain_only_stable_categories() {
        let secret = "Bearer-private-provider-body";
        for error in [
            EngineError::NotAvailable {
                reason: secret.repeat(1000),
            },
            EngineError::Invalid {
                field: secret.into(),
                message: secret.repeat(1000),
            },
        ] {
            let wire = WireError::from(error);
            assert!(!format!("{wire:?}").contains(secret));
            assert!(wire.message.len() < 128);
            assert!(wire.reason.len() < 128);
        }
        assert_eq!(
            WireError::from(EngineError::NotAvailable {
                reason: "composition-pending".into()
            })
            .error,
            "E_NOT_AVAILABLE"
        );
        let error = MemoryOpError::new(MemoryOpErrorCode::NotFound).with_detail(
            crate::contract::ErrorId::new("sourceId").unwrap(),
            crate::contract::ErrorId::new("card-123").unwrap(),
        );
        let wire = WireError::from(EngineError::MemoryOp(error));
        assert_eq!((wire.error, wire.reason), ("E_NOT_FOUND", "not-found"));
        assert_eq!(wire.ids.unwrap()["sourceId"], "card-123");
    }

    #[test]
    fn identities_and_embeddings_come_from_the_engine_service() {
        let (_root, engine) = engine();
        let cancel = Cancel::never();
        let identities =
            dispatch(&engine, "engine.embedding.identities", &json!({}), &cancel).unwrap();
        assert_eq!(
            identities,
            serde_json::to_value(engine.embedding().identities()).unwrap()
        );
        assert_eq!(identities[0]["dimensions"], 384);
        let vectors = dispatch(
            &engine,
            "engine.embedding.embed",
            &json!({
                "texts":["a query"],"kind":"query","identity":identities[0]
            }),
            &cancel,
        )
        .unwrap();
        assert_eq!(vectors[0].as_array().unwrap().len(), 384);
        assert_eq!(
            dispatch(&engine, "engine.models", &json!({}), &cancel).unwrap(),
            dispatch(&engine, "engine.models.status", &json!({}), &cancel).unwrap()
        );
    }

    #[test]
    fn normalization_and_fingerprint_use_the_existing_embedding_implementation() {
        let (_root, engine) = engine();
        let raw = json!({"provider":"openai","model":"text-embedding-3-small","dimensions":384});
        let normalized = dispatch(
            &engine,
            "engine.config.normalizeEmbedding",
            &json!({"raw":raw}),
            &Cancel::never(),
        )
        .unwrap();
        let direct = crate::embedding::normalize::normalize_embedding_config(&raw).unwrap();
        assert_eq!(
            normalized["normalized"],
            serde_json::to_value(&direct).unwrap()
        );
        let fingerprint = dispatch(
            &engine,
            "engine.embedding.fingerprint",
            &normalized,
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            fingerprint["fingerprintId"],
            crate::embedding::fingerprint::try_fingerprint_id(&direct).unwrap()
        );
    }

    #[test]
    fn generated_schema_methods_all_have_a_dispatch_route() {
        let (_root, engine) = engine();
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../packages/rpc-schema/schema/rpc.schema.json"
        ))
        .unwrap();
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/rpc-schema/fixtures/methods");
        for method in schema["$defs"]["methods"].as_object().unwrap().keys() {
            if !method.starts_with("engine.")
                || matches!(
                    method.as_str(),
                    "engine.auth"
                        | "engine.open"
                        | "engine.agent.close"
                        | "engine.status"
                        | "engine.adopt"
                        | "engine.shutdown"
                        | "engine.capture"
                        | "engine.capture.wait"
                        | "engine.capture.abort"
                        | "engine.channels.register"
                        | "engine.tokens.count"
                        | "engine.tokens.families"
                        | "engine.tokens.observe"
                )
            {
                continue;
            }
            let fixture: Value = serde_json::from_str(
                &std::fs::read_to_string(fixtures.join(format!("{method}.json"))).unwrap(),
            )
            .unwrap();
            if let Err(error) = dispatch(&engine, method, &fixture["params"], &Cancel::never()) {
                assert_ne!(
                    error.reason, "method-not-found",
                    "{method} has no dispatch route"
                );
            }
        }
    }

    #[test]
    fn memory_and_recall_forward_to_the_current_unavailable_ports() {
        let (_root, engine) = engine();
        let cancel = Cancel::never();
        let mut params = context();
        params["id"] = json!("memory-id");
        let error = dispatch(&engine, "engine.memory.show", &params, &cancel).unwrap_err();
        assert_eq!(
            (error.error, error.reason),
            ("E_NOT_AVAILABLE", "composition-pending")
        );
        let ctx = context();
        let error = dispatch(
            &engine,
            "engine.recall",
            &json!({
                "query":{"query":"test","principal":ctx["p"],"agent":ctx["a"]}
            }),
            &cancel,
        )
        .unwrap_err();
        assert_eq!(
            (error.error, error.reason),
            ("E_NOT_AVAILABLE", "composition-pending")
        );
    }

    #[test]
    fn unrepresentable_runtime_arguments_and_future_ports_fail_honestly() {
        let (_root, engine) = engine();
        for (method, params) in [
            (
                "engine.admin.reembedding.plan",
                json!({"request":{"id":"test"}}),
            ),
            ("engine.admin.reembedding.status", json!({"id":"test"})),
            ("engine.admin.workspacePolicy.get", json!({})),
            ("engine.admin.workspacePolicy.list", json!({})),
            (
                "engine.admin.workspacePolicy.set",
                json!({"patch":{"enabled":false,"actorId":"synthetic-operator"}}),
            ),
            ("engine.embedding.serve", json!({"address":null})),
        ] {
            let error = dispatch(&engine, method, &params, &Cancel::never()).unwrap_err();
            assert_eq!(
                (error.error, error.reason),
                ("E_NOT_AVAILABLE", "operation-unavailable")
            );
        }
    }

    #[test]
    fn snapshot_methods_are_served_only_through_the_core_snapshot_grant() {
        // RE-D170: the ordinary dispatch never reaches a snapshot port; without the server's
        // per-call Core peer binding the three methods answer core-link-required.
        let (root, engine) = engine();
        for (method, params) in [
            ("engine.snapshot.create", json!({"out":root.path()})),
            ("engine.snapshot.verify", json!({"dir":root.path()})),
            ("engine.tombstones.reapply", json!({})),
        ] {
            let error = dispatch(&engine, method, &params, &Cancel::never()).unwrap_err();
            assert_eq!(
                (error.code, error.error, error.reason),
                (-32000, "E_UNAUTHORIZED", "core-link-required"),
                "{method}"
            );
            assert!(SnapshotMethod::from_wire(method).is_some());
            assert!(MaintenanceMethod::from_wire(method).is_none());
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn snapshot_failures_keep_only_their_category() {
        for (error, code, reason) in [
            (SnapshotError::NotFound, "E_NOT_FOUND", "not-found"),
            (SnapshotError::UnsafePath, "E_DENIED", "unsafe-path"),
            (
                SnapshotError::DigestMismatch,
                "E_STORAGE",
                "digest-mismatch",
            ),
            (SnapshotError::SourceBusy, "E_STORAGE", "source-busy"),
            (
                SnapshotError::InsufficientDisk,
                "E_STORAGE",
                "insufficient-disk",
            ),
            (SnapshotError::Storage, "E_STORAGE", "storage"),
            (SnapshotError::Cancelled, "E_NOT_AVAILABLE", "aborted"),
        ] {
            let wire = snapshot_error(error.into());
            assert_eq!((wire.code, wire.error, wire.reason), (-32000, code, reason));
            assert!(wire.ids.is_none());
        }
        let busy = snapshot_error(SnapshotFailure::Engine(EngineError::NotAvailable {
            reason: "engine-busy".into(),
        }));
        assert_eq!(
            (busy.error, busy.reason),
            ("E_NOT_AVAILABLE", "engine-busy")
        );
    }

    #[test]
    fn cancellation_and_invalid_typed_arguments_fail_before_services() {
        let (_root, engine) = engine();
        let cancel = Cancel::never();
        cancel.cancel();
        let error =
            dispatch(&engine, "engine.embedding.identities", &json!({}), &cancel).unwrap_err();
        assert_eq!((error.error, error.reason), ("E_NOT_AVAILABLE", "aborted"));
        let error = dispatch(
            &engine,
            "engine.embedding.rerank",
            &json!({
                "query":"test","docs":[],"topN":1.5
            }),
            &Cancel::never(),
        )
        .unwrap_err();
        assert_eq!((error.code, error.error), (-32602, "E_INVALID_PARAMS"));
    }
}

#[cfg(test)]
mod reembedding_wire_tests {
    #![allow(clippy::unwrap_used, reason = "fixture errors are fatal")]
    use super::*;

    #[test]
    fn only_the_fixed_pin_texts_of_the_fixture_reach_the_wire() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/ops/reembedding-wire-errors.json"
        ))
        .unwrap();
        let entries = fixture["errors"].as_array().unwrap();
        assert_eq!(entries.len(), REEMBEDDING_ERRORS.len());
        for (entry, (text, code, reason)) in entries.iter().zip(REEMBEDDING_ERRORS) {
            assert_eq!(entry["text"], text);
            assert_eq!(entry["error"], code);
            assert_eq!(entry["reason"], reason);
            assert_eq!(reembedding_text(text), Some(text));
            let wire = maintenance_error(EngineError::Invalid {
                field: REEMBEDDING_FIELD.into(),
                message: text.into(),
            });
            assert_eq!(
                (wire.error, wire.reason, wire.message),
                (code, reason, text)
            );
            let expected = if code == "E_INVALID_PARAMS" {
                -32602
            } else {
                -32000
            };
            assert_eq!(wire.code, expected);
        }
        // Nothing outside the list passes, not even a pin text with its table suffix.
        for (field, message) in [
            (
                REEMBEDDING_FIELD,
                "reembedding source version drift: agent/memories",
            ),
            (REEMBEDDING_FIELD, "free caller text"),
            ("engine.other", "reembedding source generation drift"),
        ] {
            assert_eq!(
                maintenance_error(EngineError::Invalid {
                    field: field.into(),
                    message: message.into(),
                }),
                WireError::invalid_params()
            );
        }
        assert_eq!(reembedding_text("free caller text"), None);
    }
}
