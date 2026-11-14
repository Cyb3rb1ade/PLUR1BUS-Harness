//! Internal host-owned switch/recovery mechanics, never an engine wire authority.
//! The Core owns admission, the actual write-draining gate, atomic config.set and activation.
use super::{
    confirmation,
    coordinator::CoordinatorError as Error,
    state::MigrationStateStore,
    state_json::{get_text, number, put, revision, string},
};
use crate::{
    contract::Cancel,
    ops::import_primitives::field,
    text::json::{write_json, TolerantJsonValue as Json},
};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, TryLockError};
fn invalid(s: &'static str) -> Error {
    Error::Invalid(s)
}
fn obj(items: Vec<(&str, Json)>) -> Json {
    Json::Object(items.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn required<'a>(v: &'a Json, k: &str) -> Result<&'a Json, Error> {
    field(v, k).ok_or(invalid("invalid switch record"))
}
fn text(v: &Json, k: &str) -> Result<String, Error> {
    get_text(v, k).ok_or(invalid("invalid switch record"))
}
fn check(c: &Cancel) -> Result<(), Error> {
    c.check().map_err(|_| Error::Cancelled)
}
/// Required private ports. Implementations may only be constructed by the authorized Core host;
/// neither a MaintenanceGrant nor a manufactured Principal can supply switch authority.
pub(crate) trait SwitchHost: Send + Sync {
    fn now_ms(&self) -> i64;
    fn enter(&self, id: &str, c: &Cancel) -> Result<(), Error>;
    fn exit(&self, id: &str, c: &Cancel) -> Result<(), Error>;
    fn assert_source(&self, record: &Json, c: &Cancel) -> Result<(), Error>;
    fn mutate_selection(&self, selection: &Json, c: &Cancel) -> Result<(), Error>;
    fn active_generation(&self, c: &Cancel) -> Result<Option<String>, Error>;
    fn probe(&self, request: &Json, c: &Cancel) -> Result<Json, Error>;
}
pub(crate) struct SwitchRuntime {
    state: Arc<MigrationStateStore>,
    host: Arc<dyn SwitchHost>,
    operation: Mutex<()>,
}
impl SwitchRuntime {
    pub(crate) fn new(state: Arc<MigrationStateStore>, host: Arc<dyn SwitchHost>) -> Self {
        Self {
            state,
            host,
            operation: Mutex::new(()),
        }
    }
    fn exclusive(&self) -> Result<std::sync::MutexGuard<'_, ()>, Error> {
        self.operation.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => Error::Busy,
            TryLockError::Poisoned(_) => Error::Host,
        })
    }
    fn record(&self, id: &str) -> Result<Json, Error> {
        self.state
            .get(id)?
            .ok_or(invalid("reembedding migration not found"))
    }
    fn transition(&self, record: &Json, to: &str, patch: Json, c: &Cancel) -> Result<Json, Error> {
        check(c)?;
        Ok(self.state.transition(
            &text(record, "id")?,
            &text(record, "state")?,
            to,
            &obj(vec![
                ("expectedRevision", number(revision(record)?)),
                ("patch", patch),
            ]),
            self.host.now_ms() as f64,
            c,
        )?)
    }
    fn error(&self, record: &Json, code: &str, c: &Cancel) -> Result<Json, Error> {
        Ok(self.state.update(
            &text(record, "id")?,
            &obj(vec![
                ("expectedRevision", number(revision(record)?)),
                ("expectedState", string("switching")),
                (
                    "patch",
                    obj(vec![(
                        "error",
                        obj(vec![
                            ("code", string(code)),
                            ("rollbackRestored", Json::Bool(false)),
                        ]),
                    )]),
                ),
            ]),
            self.host.now_ms() as f64,
            c,
        )?)
    }
    pub(crate) fn switch(&self, id: &str, proof: &str, c: &Cancel) -> Result<Json, Error> {
        let _active = self.exclusive()?;
        check(c)?;
        let record = self.record(id)?;
        if get_text(&record, "state").as_deref() != Some("ready_to_switch") {
            return Err(invalid("reembedding switch requires ready_to_switch state"));
        }
        if field(&record, "receipts")
            .and_then(|v| field(v, "validation"))
            .and_then(|v| field(v, "semanticRecall"))
            != Some(&Json::Bool(true))
        {
            return Err(invalid(
                "reembedding switch requires a semantic recall validation receipt",
            ));
        }
        let source = required(&record, "source")?;
        if field(source, "fingerprint")
            .and_then(|v| get_text(v, "provider"))
            .as_deref()
            != Some("local-transformers")
            && field(source, "secretRef").is_none_or(|v| matches!(v, Json::Null))
        {
            return Err(invalid("a persistable rollback credential reference is required for the remote source provider"));
        }
        let metadata = serde_json::from_str(&write_json(required(&record, "confirmation")?))
            .map_err(|_| invalid("invalid or expired reembedding confirmation"))?;
        if !confirmation::verify_binding(proof, &metadata) {
            return Err(invalid("invalid or expired reembedding confirmation"));
        }
        self.host.enter(id, c)?;
        let result = (|| {
            check(c)?;
            self.host.assert_source(&record, c)?;
            let record = self.transition(&record, "switching", obj(vec![]), c)?;
            self.host
                .mutate_selection(&selection(&record, "target")?, c)?;
            self.record(id)
        })();
        let result = (|| match result {
            Ok(record) => Ok(record),
            Err(original) => {
                // Persist the handoff failure even if the initiating request was cancelled.
                let current = self.state.get(id)?;
                if let Some(current) =
                    current.filter(|r| get_text(r, "state").as_deref() == Some("switching"))
                {
                    if self
                        .error(&current, "switch_config_mutation_failed", &Cancel::never())
                        .is_err()
                    {
                        Err(invalid(
                            "reembedding switch handoff and state update failed",
                        ))
                    } else {
                        Err(original)
                    }
                } else {
                    Err(original)
                }
            }
        })();
        // Gate release is mandatory cleanup, independent of caller cancellation or handoff result.
        self.host.exit(id, &Cancel::never())?;
        result
    }
    pub(crate) fn manual_rollback(
        &self,
        id: &str,
        new_id: &str,
        c: &Cancel,
    ) -> Result<Json, Error> {
        check(c)?;
        let record = self.record(id)?;
        if get_text(&record, "state").as_deref() != Some("completed") {
            return Err(invalid("manual rollback requires a completed migration"));
        }
        reverse_plan(&record, id, new_id, self.host.now_ms())
    }
    fn probe(&self, record: &Json, side: &str, rollback: bool, c: &Cancel) -> Result<Json, Error> {
        let selected = selection(record, side)?;
        let value = required(record, side)?;
        let mut request = obj(vec![
            (
                "expectedGeneration",
                required(&selected, "generation")?.clone(),
            ),
            ("fingerprint", required(value, "fingerprint")?.clone()),
        ]);
        if let Some(reference) = field(value, "secretRef") {
            put(&mut request, "secretRef", reference.clone())?;
        }
        put(&mut request, "migrationId", required(record, "id")?.clone())?;
        put(&mut request, "rollback", Json::Bool(rollback))?;
        let result = self.host.probe(&request, c)?;
        if ["readiness", "store", "recall"]
            .iter()
            .any(|k| field(&result, k) != Some(&Json::Bool(true)))
        {
            return Err(invalid("target readiness, store, and recall probe failed"));
        }
        Ok(obj(vec![
            ("readiness", Json::Bool(true)),
            ("store", Json::Bool(true)),
            ("recall", Json::Bool(true)),
        ]))
    }
    /// One activation's reconciliation. A RecoverySession caches this result like Node's start().
    fn reconcile(&self, c: &Cancel) -> Result<Option<Json>, Error> {
        let _active = self.exclusive()?;
        check(c)?;
        let Some(record) = self
            .state
            .list()?
            .into_iter()
            .find(|r| get_text(r, "state").as_deref() == Some("switching"))
        else {
            return Ok(None);
        };
        let active = self.host.active_generation(c)?;
        let target = selection(&record, "target")?;
        let source = selection(&record, "source")?;
        let pending = field(&record, "error")
            .and_then(|e| get_text(e, "code"))
            .is_some_and(|s| {
                matches!(
                    s.as_str(),
                    "switch_probe_failed_pending_rollback"
                        | "switch_rollback_config_mutation_failed"
                )
            });
        if active == get_text(&target, "generation") && pending {
            return match self.host.mutate_selection(&source, c) {
                Ok(()) => self.record(&text(&record, "id")?).map(Some),
                Err(e) => {
                    self.error(
                        &record,
                        "switch_rollback_config_mutation_failed",
                        &Cancel::never(),
                    )?;
                    Err(e)
                }
            };
        }
        if active == get_text(&target, "generation") {
            let target_result = (|| {
                let mut receipt = self.probe(&record, "target", false, c)?;
                put(
                    &mut receipt,
                    "generation",
                    required(required(&record, "target")?, "generation")?.clone(),
                )?;
                let mut receipts = field(&record, "receipts")
                    .cloned()
                    .unwrap_or_else(|| obj(vec![]));
                put(&mut receipts, "switch", receipt)?;
                self.transition(
                    &record,
                    "completed",
                    obj(vec![("error", Json::Null), ("receipts", receipts)]),
                    c,
                )
            })();
            return match target_result {
                Ok(record) => Ok(Some(record)),
                Err(_probe_error) => {
                    let current = self.error(
                        &record,
                        "switch_probe_failed_pending_rollback",
                        &Cancel::never(),
                    )?;
                    match self.host.mutate_selection(&source, c) {
                        Ok(()) => self.record(&text(&record, "id")?).map(Some),
                        Err(_) => {
                            self.error(
                                &current,
                                "switch_rollback_config_mutation_failed",
                                &Cancel::never(),
                            )?;
                            Err(invalid(
                                "reembedding target probe and rollback config mutation failed",
                            ))
                        }
                    }
                }
            };
        }
        if active == get_text(&source, "generation") {
            if let Err(e) = self.probe(&record, "source", true, c) {
                self.error(&record, "switch_rollback_probe_failed", &Cancel::never())?;
                return Err(e);
            }
            return self
                .transition(
                    &record,
                    "failed",
                    obj(vec![(
                        "error",
                        obj(vec![
                            (
                                "code",
                                string(if pending {
                                    "switch_probe_failed"
                                } else {
                                    "switch_target_not_activated"
                                }),
                            ),
                            ("rollbackRestored", Json::Bool(true)),
                        ]),
                    )]),
                    c,
                )
                .map(Some);
        }
        Err(invalid(
            "active generation selection drift during durable reembedding switch recovery",
        ))
    }
}
/// A reverse plan copies the active generation, retaining captures since the original switch.
pub(crate) fn reverse_plan(
    record: &Json,
    id: &str,
    new_id: &str,
    now_ms: i64,
) -> Result<Json, Error> {
    if new_id.is_empty()
        || new_id.len() > 64
        || !new_id.as_bytes()[0].is_ascii_alphanumeric()
        || !new_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid("invalid reverse migration id"));
    }
    let source = required(record, "source")?;
    let target = required(record, "target")?;
    let target_generation = text(target, "generation")?;
    let material = format!(
        "{}\0{}\0{}\0{}",
        target_generation,
        text(source, "fingerprintId")?,
        new_id,
        now_ms
    );
    let digest = format!("{:x}", Sha256::digest(material.as_bytes()));
    let mut reverse = obj(vec![(
        "fingerprint",
        required(source, "fingerprint")?.clone(),
    )]);
    if let Some(reference) = field(source, "secretRef") {
        put(&mut reverse, "secretRef", reference.clone())?;
    }
    Ok(obj(vec![
        ("id", string(new_id)),
        ("sourceGeneration", string(&target_generation)),
        (
            "targetGeneration",
            string(&format!("rollback-{}", &digest[..48])),
        ),
        ("target", reverse),
        ("reverseOf", string(id)),
    ]))
}
pub(crate) fn selection(record: &Json, side: &str) -> Result<Json, Error> {
    let value = required(record, side)?;
    let generation = if field(value, "selection")
        .and_then(|v| get_text(v, "mode"))
        .as_deref()
        == Some("legacy")
    {
        Json::Null
    } else {
        required(value, "generation")?.clone()
    };
    let mut result = obj(vec![
        ("generation", generation),
        ("fingerprint", required(value, "fingerprint")?.clone()),
        ("fingerprintId", required(value, "fingerprintId")?.clone()),
    ]);
    if let Some(reference) = field(value, "secretRef") {
        put(&mut result, "secretRef", reference.clone())?;
    }
    Ok(result)
}
struct RecoveryState {
    stopped: bool,
    result: Option<Result<Option<Json>, Error>>,
}
pub(crate) struct RecoverySession {
    runtime: Arc<SwitchRuntime>,
    state: Mutex<RecoveryState>,
}
impl RecoverySession {
    pub(crate) fn new(runtime: Arc<SwitchRuntime>) -> Self {
        Self {
            runtime,
            state: Mutex::new(RecoveryState {
                stopped: false,
                result: None,
            }),
        }
    }
    pub(crate) fn start(&self, c: &Cancel) -> Result<Option<Json>, Error> {
        let mut state = self.state.lock().map_err(|_| Error::Host)?;
        if state.stopped {
            return Err(Error::Closed);
        }
        if state.result.is_none() {
            state.result = Some(self.runtime.reconcile(c));
        }
        state.result.clone().ok_or(Error::Host)?
    }
    pub(crate) fn shutdown(&self) -> Result<(), Error> {
        let mut state = self.state.lock().map_err(|_| Error::Host)?;
        state.stopped = true;
        state.result.clone().unwrap_or(Ok(None)).map(|_| ())
    }
}
#[cfg(test)]
#[path = "switch_tests.rs"]
mod tests;
