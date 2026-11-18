//! Adopting a replay's candidate as the new baseline (D133 ruling 10, R-K-22, R-K-23). Only a person of the role owner or
//! admin; the audit line is written before the effect; the new version of the calibration record and the adoption row
//! are written in one transaction, so an interruption leaves the old baseline as it was. The old versions stay readable.
//! A configuration change that follows is not made here: it runs under the rule of that configuration.
use super::format::{is_identifier, ReceiptError};
use super::replay::{CaseKind, PortFault, ReplayReport};
use super::rights;
use super::store::ReceiptStore;
use crate::audit::recorded_then;
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::types::Principal;
use plur1bus_store::rusqlite::params;
use serde_json::json;

/// One version of the calibration record (ADR-015): what a baseline is. Identifiers and a hash only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalibrationRecord {
    /// The version, 1 for the first.
    pub version: u32,
    /// The backend of the candidate that became the baseline.
    pub backend: String,
    /// Its prompt version.
    pub prompt_version: String,
    /// The report that justified it.
    pub report_hash: String,
    /// The person who adopted it.
    pub adopted_by: String,
    /// When, epoch milliseconds.
    pub adopted_at: i64,
}

/// The versioned calibration record of the decision service, a port (R-K-23). Nothing in the Rust core holds one yet.
pub trait CalibrationRecords {
    /// The newest version, none when there is no record yet.
    fn current(&self) -> Result<Option<CalibrationRecord>, PortFault>;
    /// Every version, oldest first.
    fn versions(&self) -> Result<Vec<CalibrationRecord>, PortFault>;
    /// Appends the next version. It must be exactly the current version plus one.
    fn append(&mut self, record: CalibrationRecord) -> Result<(), PortFault>;
}

/// The double of tests and of a host that has no record yet: versions in memory.
#[derive(Default)]
pub struct MemoryCalibrationRecords {
    /// The versions, oldest first.
    pub list: Vec<CalibrationRecord>,
    /// Makes the next `append` fail.
    pub fail_append: bool,
}

impl CalibrationRecords for MemoryCalibrationRecords {
    fn current(&self) -> Result<Option<CalibrationRecord>, PortFault> {
        Ok(self.list.last().cloned())
    }
    fn versions(&self) -> Result<Vec<CalibrationRecord>, PortFault> {
        Ok(self.list.clone())
    }
    fn append(&mut self, record: CalibrationRecord) -> Result<(), PortFault> {
        if self.fail_append || record.version != self.list.last().map_or(0, |r| r.version) + 1 {
            return Err(PortFault);
        }
        self.list.push(record);
        Ok(())
    }
}

/// The calls of an adoption that are not the report itself.
pub struct AdoptRequest<'a> {
    /// Who adopts.
    pub who: &'a Principal,
    /// The report of the closing comparison.
    pub report: &'a ReplayReport,
    /// The receipt ids the change was developed on; the report's set may share none of them.
    pub development_ids: &'a [String],
    /// The host name for the audit line.
    pub host: &'a str,
}

impl ReceiptStore {
    /// Takes the candidate of `req.report` as the new baseline. Returns the new version of the record.
    pub fn adopt(
        &mut self,
        req: &AdoptRequest<'_>,
        records: &mut dyn CalibrationRecords,
        audit: &mut dyn AuditSink,
    ) -> Result<CalibrationRecord, ReceiptError> {
        if !rights::can_adopt(req.who) {
            return Err(ReceiptError::Denied);
        }
        let r = req.report;
        if !r.verifies() {
            return Err(ReceiptError::Invalid("report"));
        }
        if r.set != CaseKind::Final {
            return Err(ReceiptError::Refused("not a final set"));
        }
        if r.receipt_ids.is_empty() || req.development_ids.is_empty() {
            return Err(ReceiptError::Refused("no cases"));
        }
        if r.receipt_ids
            .iter()
            .any(|i| req.development_ids.contains(i))
        {
            return Err(ReceiptError::Refused("sets overlap"));
        }
        if !is_identifier(req.host) {
            return Err(ReceiptError::Invalid("host"));
        }
        let current = records
            .current()
            .map_err(|_| ReceiptError::Port("calibration"))?;
        let from = current.as_ref().map(|c| c.version);
        let to = from.unwrap_or(0) + 1;
        let at = self.clock.now();
        let record = CalibrationRecord {
            version: to,
            backend: r.candidate.backend.clone(),
            prompt_version: r.candidate.prompt_version.clone(),
            report_hash: r.report_hash.clone(),
            adopted_by: req.who.user_id.clone(),
            adopted_at: at,
        };
        let adoption_id = self.ids.next_id();
        let event = AuditEvent {
            at,
            user: req.who.user_id.clone(),
            host: req.host.to_owned(),
            action: "decision.baseline.adopt".to_owned(),
            target: format!("calibration:{}", record.backend),
            detail: vec![
                ("reportHash".into(), json!(record.report_hash)),
                ("fromVersion".into(), json!(from)),
                ("toVersion".into(), json!(to)),
            ],
        };
        let db = &mut self.db;
        let done = recorded_then(audit, &event, || {
            db.write_with(|tx| {
                tx.execute(
                    "INSERT INTO adoptions(id,from_version,to_version,report_hash,adopted_by,adopted_at) VALUES (?,?,?,?,?,?)",
                    params![adoption_id, from, to, record.report_hash, record.adopted_by, at],
                )?;
                records
                    .append(record.clone())
                    .map_err(|_| ReceiptError::Port("calibration"))?;
                Ok::<(), ReceiptError>(())
            })
        })
        .map_err(|_| ReceiptError::Port("audit"))?;
        done?;
        Ok(record)
    }
}
