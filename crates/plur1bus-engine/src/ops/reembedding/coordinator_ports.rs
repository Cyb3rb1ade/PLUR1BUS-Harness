//! Explicit host and copy boundaries for the maintenance coordinator.
use super::{
    backend::{BackendError, GenerationBackend},
    coordinator::CoordinatorError,
};
use crate::{
    contract::{Cancel, EmbedKind, VectorSpaceIdentity},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::Value;

/// Copy/readback/validation operations. No active-generation switch is part of this port.
pub trait CopyBackend: Send + Sync {
    /// Exactly the host-selected active generation inventory.
    fn inventory(&self, cancel: &Cancel) -> Result<Vec<Json>, BackendError>;
    /// Create an isolated target using this migration's source declarations and target identity.
    fn create_target(&self, record: &Json, cancel: &Cancel) -> Result<(), BackendError>;
    /// Read a completed target manifest for interrupted-create recovery.
    fn describe(&self, generation: &str, cancel: &Cancel) -> Result<Json, BackendError>;
    /// Read one bounded source batch.
    fn read_source(
        &self,
        table: &str,
        offset: usize,
        limit: usize,
        cancel: &Cancel,
    ) -> Result<Vec<Json>, BackendError>;
    /// Idempotently copy one batch; errors may occur after a durable write and must be replayable.
    fn write_target(
        &self,
        generation: &str,
        table: &str,
        rows: &[Json],
        cancel: &Cancel,
    ) -> Result<(), BackendError>;
    /// Read back requested UUIDs from the isolated target.
    fn read_target(
        &self,
        generation: &str,
        table: &str,
        ids: &[String],
        cancel: &Cancel,
    ) -> Result<Vec<Json>, BackendError>;
    /// Verify target schema/counts/metadata and fixed source versions.
    fn validate(&self, generation: &str, cancel: &Cancel) -> Result<Json, BackendError>;
    /// Release handles after the active operation ends.
    fn close(&self) -> Result<(), BackendError>;
}
/// An owned target provider lease. Identity is verified before it can copy any rows.
pub trait MigrationProvider: Send + Sync {
    /// Actual vector-space identity of the constructed provider.
    fn identity(&self) -> &VectorSpaceIdentity;
    /// Embed the selected query/passage batch; no caller text may enter errors or audit.
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f64>>, CoordinatorError>;
    /// Release this lease's provider resources. Failure prevents rotation to another target.
    fn close(&self) -> Result<(), CoordinatorError>;
}
/// Required host capabilities. The implementation, not a fake default, owns provider resolution,
/// filesystem capacity, workspace policy and real semantic validation of the target generation.
pub trait MigrationRuntime: Send + Sync {
    /// Host wall clock in milliseconds.
    fn now_ms(&self) -> i64;
    /// Available bytes on the target generation filesystem.
    fn free_bytes(&self, cancel: &Cancel) -> Result<u64, CoordinatorError>;
    /// Read-only verification; false defers a local probe, never downloads a model.
    fn artifacts_verified(
        &self,
        fingerprint: &Json,
        cancel: &Cancel,
    ) -> Result<bool, CoordinatorError>;
    /// One plan-time target probe; this does not create a generation.
    fn plan_probe(&self, target: &Json, cancel: &Cancel) -> Result<Vec<f64>, CoordinatorError>;
    /// Construct the exact configured target from fingerprint and SecretRef only.
    fn create_provider(
        &self,
        target: &Json,
        cancel: &Cancel,
    ) -> Result<Box<dyn MigrationProvider>, CoordinatorError>;
    /// Current policy snapshot, or None only if policy support is explicitly absent.
    fn policy_snapshot(&self, cancel: &Cancel) -> Result<Option<Json>, CoordinatorError>;
    /// Actual semantic recall validation. An empty source may be proven empty without inference.
    fn validate_probes(
        &self,
        record: &Json,
        provider: &dyn MigrationProvider,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError>;
}
fn value(v: &Json) -> Result<Value, BackendError> {
    serde_json::from_str(&write_json(v)).map_err(|_| BackendError::Invalid)
}
fn raw(v: &Value) -> Result<Json, BackendError> {
    parse_json(&v.to_string()).map_err(|_| BackendError::Invalid)
}
impl CopyBackend for GenerationBackend {
    fn inventory(&self, c: &Cancel) -> Result<Vec<Json>, BackendError> {
        let v = GenerationBackend::inventory(self, c)?;
        v.as_array()
            .ok_or(BackendError::Invalid)?
            .iter()
            .map(raw)
            .collect()
    }
    fn create_target(&self, r: &Json, c: &Cancel) -> Result<(), BackendError> {
        let r = value(r)?;
        let t = &r["target"];
        GenerationBackend::create_generation(
            self,
            t["generation"].as_str().ok_or(BackendError::Invalid)?,
            t["fingerprintId"].as_str(),
            t["fingerprint"]["dimensions"]
                .as_u64()
                .ok_or(BackendError::Invalid)? as usize,
            r["source"]["tables"]
                .as_array()
                .ok_or(BackendError::Invalid)?,
            t.get("identity"),
            c,
        )?;
        Ok(())
    }
    fn describe(&self, g: &str, c: &Cancel) -> Result<Json, BackendError> {
        raw(&GenerationBackend::describe(self, g, c)?)
    }
    fn read_source(
        &self,
        t: &str,
        o: usize,
        l: usize,
        c: &Cancel,
    ) -> Result<Vec<Json>, BackendError> {
        GenerationBackend::read_source(self, t, o, l, c)?
            .iter()
            .map(raw)
            .collect()
    }
    fn write_target(
        &self,
        g: &str,
        t: &str,
        rows: &[Json],
        c: &Cancel,
    ) -> Result<(), BackendError> {
        GenerationBackend::write_target(
            self,
            g,
            t,
            &rows.iter().map(value).collect::<Result<Vec<_>, _>>()?,
            c,
        )?;
        Ok(())
    }
    fn read_target(
        &self,
        g: &str,
        t: &str,
        ids: &[String],
        c: &Cancel,
    ) -> Result<Vec<Json>, BackendError> {
        GenerationBackend::read_target(self, g, t, ids, c)?
            .iter()
            .map(raw)
            .collect()
    }
    fn validate(&self, g: &str, c: &Cancel) -> Result<Json, BackendError> {
        raw(&GenerationBackend::validate(self, g, c)?)
    }
    fn close(&self) -> Result<(), BackendError> {
        GenerationBackend::close(self)
    }
}
