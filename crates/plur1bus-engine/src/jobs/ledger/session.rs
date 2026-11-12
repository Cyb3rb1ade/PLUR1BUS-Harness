//! Lifecycle-fenced recovery. Marker retirement requires exact durable row evidence.
#[path = "migration.rs"]
mod migration;
use super::{io, JobLedger, MAX_BYTES, MAX_RECORD, MAX_ROWS};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    jobs::metadata::recovery_plan,
    store::{
        directory::TrustedDirectory,
        kernel_lease::{self, KernelLease},
    },
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
pub use migration::MigrationReport;
use std::collections::HashMap;
#[cfg(any(test, feature = "testkit"))]
use std::sync::Arc;
#[cfg(any(test, feature = "testkit"))]
type Observer = Arc<dyn Fn(&str) + Send + Sync>;

/// Counts acknowledged by this recovery pass; a second pass in the same session is a no-op.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Newly persisted failed/crash rows.
    pub appended: usize,
    /// Orphan markers retired after their exact run row was synced and verified.
    pub retired: usize,
}
/// Exclusive agent-registry lifetime, distinct from short ledger-write transactions.
/// It grants metadata coordination only, never permission to read or mutate memory cards.
pub struct JobSession {
    ledger: JobLedger,
    dir: TrustedDirectory,
    lease: KernelLease,
    recovered: bool,
    generation: uuid::Uuid,
    #[cfg(any(test, feature = "testkit"))]
    observer: Option<Observer>,
}
impl JobLedger {
    /// Wait cancellably for the previous native agent registry to end, then own its lifecycle.
    /// The lease is released by drop or process death, with no stale-timeout takeover.
    pub fn session(self, cancel: &Cancel) -> Result<JobSession, EngineError> {
        cancel.check()?;
        self.root.assert_unchanged()?;
        let dir = self.root.create_child(&self.agent)?;
        dir.restrict_private()?;
        let lease = kernel_lease::acquire(&dir, "job-registry-session", cancel, &mut || {})?;
        let session = JobSession {
            ledger: self,
            dir,
            lease,
            recovered: false,
            generation: uuid::Uuid::new_v4(),
            #[cfg(any(test, feature = "testkit"))]
            observer: None,
        };
        session.check(cancel)?;
        Ok(session)
    }
}
impl JobSession {
    /// Install a deterministic publication-boundary observer in test builds only.
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    fn observe(&self, point: &str) {
        #[cfg(any(test, feature = "testkit"))]
        if let Some(observer) = &self.observer {
            observer(point);
        }
        #[cfg(not(any(test, feature = "testkit")))]
        let _ = point;
    }
    fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        self.ledger.root.assert_unchanged()?;
        self.dir.assert_unchanged()?;
        self.lease.check(&self.dir)?;
        Ok(())
    }
    /// Retire only prior-process markers. Failure leaves recovery retryable; already appended
    /// rows are recognized on retry, including an append completed immediately before SIGKILL.
    /// A raw diagnostic unknown-job row is retained as evidence, never emitted as a valid JobRun.
    pub fn recover(&mut self, now: f64, cancel: &Cancel) -> Result<RecoveryReport, EngineError> {
        self.check(cancel)?;
        if self.recovered {
            return Ok(RecoveryReport::default());
        }
        let report = self
            .ledger
            .write(cancel, |dir| self.recover_locked(dir, now, cancel))?;
        self.check(cancel)?;
        self.recovered = true;
        Ok(report)
    }
    fn recover_locked(
        &self,
        dir: &TrustedDirectory,
        now: f64,
        cancel: &Cancel,
    ) -> Result<RecoveryReport, EngineError> {
        self.check(cancel)?;
        let raw = io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
        let snapshot = self.ledger.snapshot(cancel)?;
        let markers = self.ledger.orphan_markers(cancel)?;
        let plan = recovery_plan(&snapshot.rows, &markers, &self.ledger.agent, now, cancel)?;
        let mut prepared = Vec::new();
        let mut total = raw.len();
        let mut lines = raw.iter().filter(|b| **b == b'\n').count();
        let running = io::child(dir, "running")?;
        for (action, original_marker) in plan.into_iter().zip(markers) {
            let name = format!("{}.started", action.run_id);
            let running = running.as_ref().ok_or(StoreError::Corrupt)?;
            let marker =
                io::read(running, &name, MAX_RECORD, cancel)?.ok_or(StoreError::Unavailable)?;
            if super::marker_value(&marker, &action.run_id) != original_marker {
                return Err(StoreError::Unavailable.into());
            }
            let row = action.row.map(|row| write_json(&row).into_bytes());
            if let Some(row) = &row {
                total = total
                    .checked_add(row.len() + 2)
                    .ok_or(StoreError::Corrupt)?;
                lines += 1;
                if total > MAX_BYTES || row.len() > MAX_RECORD || lines > MAX_ROWS {
                    return Err(StoreError::Corrupt.into());
                }
            }
            prepared.push((action.run_id, name, marker, row));
        }
        if io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default() != raw {
            return Err(StoreError::Unavailable.into());
        }
        let ranges = row_ranges(&raw);
        let mut ledger_identity = io::identity(dir, "ledger.jsonl")?;
        let mut length = raw.len();
        let mut needs_separator = raw.last().is_some_and(|b| *b != b'\n');
        let mut report = RecoveryReport::default();
        for (id, name, marker, row) in prepared {
            self.check(cancel)?;
            let running = running.as_ref().ok_or(StoreError::Corrupt)?;
            self.observe("recovery-before-row");
            self.check(cancel)?;
            check_identity(dir, ledger_identity)?;
            if io::read(running, &name, MAX_RECORD, cancel)?.as_ref() != Some(&marker) {
                return Err(StoreError::Unavailable.into());
            }
            let (offset, proof) = if let Some(row) = row {
                let value = parse_json(std::str::from_utf8(&row).map_err(|_| StoreError::Corrupt)?)
                    .map_err(|_| StoreError::Corrupt)?;
                let offset = length + usize::from(needs_separator);
                dir.append_jsonl_durable("ledger.jsonl", &value, MAX_RECORD + 2)?;
                length = offset + row.len() + 1;
                needs_separator = false;
                report.appended += 1;
                (offset as u64, row)
            } else {
                let (offset, length) = ranges.get(&id).ok_or(StoreError::Corrupt)?;
                dir.sync_file_durable("ledger.jsonl")?;
                (*offset as u64, raw[*offset..*offset + *length].to_vec())
            };
            if ledger_identity.is_none() {
                ledger_identity = io::identity(dir, "ledger.jsonl")?;
            }
            check_identity(dir, ledger_identity)?;
            self.observe("recovery-row-committed");
            self.check(cancel)?;
            check_identity(dir, ledger_identity)?;
            io::verify_range(dir, "ledger.jsonl", offset, &proof, cancel)?;
            if io::read(running, &name, MAX_RECORD, cancel)?.as_ref() != Some(&marker) {
                return Err(StoreError::Unavailable.into());
            }
            self.observe("recovery-before-remove");
            self.check(cancel)?;
            check_identity(dir, ledger_identity)?;
            io::verify_range(dir, "ledger.jsonl", offset, &proof, cancel)?;
            if io::read(running, &name, MAX_RECORD, cancel)?.as_ref() != Some(&marker) {
                return Err(StoreError::Unavailable.into());
            }
            io::remove(running, &name)?;
            report.retired += 1;
            self.observe("recovery-marker-removed");
            self.check(cancel)?;
            check_identity(dir, ledger_identity)?;
            io::verify_range(dir, "ledger.jsonl", offset, &proof, cancel)?;
        }
        Ok(report)
    }
}
fn row_ranges(raw: &[u8]) -> HashMap<String, (usize, usize)> {
    let mut result = HashMap::new();
    let mut offset = 0;
    for line in raw.split_inclusive(|b| *b == b'\n') {
        if let Ok(Json::Object(fields)) = parse_json(&String::from_utf8_lossy(line)) {
            if let Some((_, Json::String(id))) = fields
                .iter()
                .rev()
                .find(|(key, _)| key.to_utf8_lossy() == "runId")
            {
                if let Ok(id) = String::from_utf16(id.as_utf16_units()) {
                    result.insert(id, (offset, line.len()));
                }
            }
        }
        offset += line.len();
    }
    result
}

fn check_identity(dir: &TrustedDirectory, expected: Option<(u64, u64)>) -> Result<(), EngineError> {
    if io::identity(dir, "ledger.jsonl")? != expected {
        return Err(StoreError::UntrustedPath.into());
    }
    Ok(())
}

/// Opaque proof that this session durably admitted exactly one start marker.
pub struct RunAdmission {
    generation: uuid::Uuid,
    name: String,
    marker: Vec<u8>,
}
impl JobSession {
    /// Admit a new metadata run only after orphan recovery succeeded for this session.
    pub fn start(&self, marker: &Json, cancel: &Cancel) -> Result<RunAdmission, EngineError> {
        self.check(cancel)?;
        if !self.recovered {
            return Err(StoreError::Unavailable.into());
        }
        let expected = super::json::node_value(projection(marker)?);
        let (id, bytes) = super::prepare_marker(marker)?;
        let name = format!("{id}.started");
        let marker = self.ledger.write(cancel, |dir| {
            self.check(cancel)?;
            let raw = io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
            if row_ranges(&raw).contains_key(&id) {
                return Err(StoreError::InvalidInput.into());
            }
            super::write_marker_at(dir, &id, &bytes, cancel)?;
            let running = dir.open_child("running")?;
            let actual =
                io::read(&running, &name, MAX_RECORD, cancel)?.ok_or(StoreError::Unavailable)?;
            if actual != bytes.as_bytes() || super::marker_value(&actual, &id) != expected {
                return Err(StoreError::Unavailable.into());
            }
            Ok(actual)
        })?;
        self.check(cancel)?;
        Ok(RunAdmission {
            generation: self.generation,
            name,
            marker,
        })
    }
    /// Finish this session's admitted run. A failed append/verification keeps its marker for recovery.
    /// The caller supplies the Node row projection, including sweep/llmSession but excluding version.
    pub fn finish(
        &self,
        admission: RunAdmission,
        row: &Json,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let RunAdmission {
            generation,
            name,
            marker,
        } = admission;
        self.check(cancel)?;
        if generation != self.generation {
            return Err(StoreError::InvalidInput.into());
        }
        let Json::Object(fields) = row else {
            return Err(StoreError::InvalidInput.into());
        };
        if fields
            .iter()
            .rev()
            .find(|(key, _)| key.to_utf8_lossy() == "agentId")
            .map(|(_, value)| value)
            != Some(&Json::String(self.ledger.agent.as_str().into()))
        {
            return Err(StoreError::InvalidInput.into());
        }
        let mut versioned = vec![(
            crate::text::js::JsString::from_utf8_str("v"),
            Json::Number("1".into()),
        )];
        for (key, value) in fields {
            super::set(&mut versioned, key.clone(), value.clone());
        }
        let versioned = super::json::node_value(Json::Object(versioned));
        let row_bytes = write_json(&versioned);
        if row_bytes.len() > MAX_RECORD {
            return Err(StoreError::InvalidInput.into());
        }
        let id = name
            .strip_suffix(".started")
            .ok_or(StoreError::InvalidInput)?;
        let expected = super::marker_value(&marker, id);
        let projected = projection(&versioned)?;
        if projected != expected {
            return Err(StoreError::InvalidInput.into());
        }
        self.ledger.write(cancel, |dir| {
            self.check(cancel)?;
            let running = dir.open_child("running")?;
            if io::read(&running, &name, MAX_RECORD, cancel)?.as_ref() != Some(&marker) {
                return Err(StoreError::Unavailable.into());
            }
            let raw = io::read(dir, "ledger.jsonl", MAX_BYTES, cancel)?.unwrap_or_default();
            if raw.len() + row_bytes.len() + 2 > MAX_BYTES
                || raw.iter().filter(|b| **b == b'\n').count() >= MAX_ROWS
            {
                return Err(StoreError::Corrupt.into());
            }
            if row_ranges(&raw).contains_key(id) {
                return Err(StoreError::Corrupt.into());
            }
            let before = io::identity(dir, "ledger.jsonl")?;
            let offset = raw.len() + usize::from(raw.last().is_some_and(|b| *b != b'\n'));
            dir.append_jsonl_durable("ledger.jsonl", &versioned, MAX_RECORD + 2)?;
            let identity = io::identity(dir, "ledger.jsonl")?;
            if before.is_some() && before != identity {
                return Err(StoreError::UntrustedPath.into());
            }
            self.observe("run-row-committed");
            self.check(cancel)?;
            check_identity(dir, identity)?;
            io::verify_range(
                dir,
                "ledger.jsonl",
                offset as u64,
                row_bytes.as_bytes(),
                cancel,
            )?;
            if io::read(&running, &name, MAX_RECORD, cancel)?.as_ref() != Some(&marker) {
                return Err(StoreError::Unavailable.into());
            }
            io::remove(&running, &name)?;
            self.observe("run-marker-retired");
            self.check(cancel)?;
            check_identity(dir, identity)?;
            io::verify_range(
                dir,
                "ledger.jsonl",
                offset as u64,
                row_bytes.as_bytes(),
                cancel,
            )
        })
    }
    /// Take back the start marker of a run whose admission did not complete (RE-D164): the
    /// marker carries this run's unique ID, so no other run can race for it. Without a
    /// written marker nothing is done and no writer lease is waited for.
    pub fn retract(&self, marker: &Json, cancel: &Cancel) -> Result<(), EngineError> {
        let (id, _) = super::prepare_marker(marker)?;
        let Some(dir) = self.ledger.existing()? else {
            return Ok(());
        };
        let Some(running) = io::child(&dir, "running")? else {
            return Ok(());
        };
        if io::read(&running, &format!("{id}.started"), MAX_RECORD, cancel)?.is_none() {
            return Ok(());
        }
        self.ledger.remove_marker(&id, cancel)
    }
    /// Read this selected agent's bounded raw metadata while retaining the lifecycle lease.
    pub fn snapshot(&self, cancel: &Cancel) -> Result<super::Snapshot, EngineError> {
        self.check(cancel)?;
        let snapshot = self.ledger.snapshot(cancel)?;
        self.check(cancel)?;
        Ok(snapshot)
    }
}
fn projection(row: &Json) -> Result<Json, EngineError> {
    let Json::Object(fields) = row else {
        return Err(StoreError::InvalidInput.into());
    };
    let mut projected = Vec::new();
    for name in ["runId", "job", "phase", "trigger", "startedAt"] {
        projected.push(
            fields
                .iter()
                .rev()
                .find(|(key, _)| key.to_utf8_lossy() == name)
                .cloned()
                .ok_or(StoreError::InvalidInput)?,
        );
    }
    Ok(Json::Object(projected))
}
