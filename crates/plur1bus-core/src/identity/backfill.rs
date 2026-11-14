//! `identity/backfill.ts`: the back-fill of a linked channel identity (ADR-007 Q4). The engine moves the owner metadata
//! of the cards written under the handle's v1 principal to the harness user's v2 principal; this module decides whether it
//! may, keeps the record that makes the step restartable and reversible, and audits it. The engine is a port
//! ([`MetadataRebindPort`]): it must touch owner metadata only, preserve vectors, remember `operationId -> result`
//! atomically, and reverse exactly the row set of the receipt (never "all v2 rows").
//!
//! A record goes `running -> applied -> reversing -> reversed`. A real run reserves an operation id before it asks the
//! engine, so a run that failed is repeated under the same id; an applied record answers without asking the engine again.
//! One back-fill runs at a time per value of this type (`&mut self`), which is what the TypeScript `busy` set gives one
//! process. The operation id source and the clock are parameters (ruling R6).
use super::authorization::IdentityAction;
use super::error::{IdentityError, IdentityErrorCode};
use super::principals::{derive_user_principal, is_user_principal};
use super::service::Actor;
use super::service_impl::{BackfillState, IdentityFailure, IdentityService};
use serde_json::{json, Map, Value};

/// The largest count the engine may report (`Number.isSafeInteger`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// What the engine answers to a rebind. `count` is the number as the engine reported it.
#[derive(Clone, Debug, PartialEq)]
pub struct Rebound {
    /// Rows moved, or for a dry run the rows that would move.
    pub count: f64,
    /// What makes the step reversible; required of a real run.
    pub receipt: Option<String>,
}

/// `MetadataRebindPort`: the dedicated engine operation.
pub trait MetadataRebindPort {
    /// Moves the owner metadata of the cards under `from` to `to`. `links` is the identity service, for a port that has
    /// to name the channel identity behind `from`.
    fn rebind(
        &mut self,
        links: &IdentityService,
        from: &str,
        to: &str,
        dry_run: bool,
        operation_id: &str,
    ) -> Result<Rebound, IdentityError>;
    /// Moves exactly the rows of `receipt` back; answers how many.
    fn reverse(
        &mut self,
        receipt: &str,
        dry_run: bool,
        operation_id: &str,
    ) -> Result<f64, IdentityError>;
}

/// `BackfillReport`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackfillReport {
    /// The link.
    pub link_id: String,
    /// The handle's v1 principal.
    pub from: String,
    /// The harness user's v2 principal.
    pub to: String,
    /// Whether nothing was changed.
    pub dry_run: bool,
    /// Rows moved (or that would move).
    pub count: i64,
    /// When.
    pub at: i64,
    /// The receipt of a real run.
    pub receipt: Option<String>,
}

impl BackfillReport {
    /// `{ linkId, from, to, dryRun, count, at, receipt? }`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("linkId".into(), json!(self.link_id));
        out.insert("from".into(), json!(self.from));
        out.insert("to".into(), json!(self.to));
        out.insert("dryRun".into(), json!(self.dry_run));
        out.insert("count".into(), json!(self.count));
        out.insert("at".into(), json!(self.at));
        if let Some(receipt) = self.receipt.as_ref().filter(|r| !r.is_empty()) {
            out.insert("receipt".into(), json!(receipt));
        }
        Value::Object(out)
    }
}

fn refuse(code: IdentityErrorCode, message: &str) -> IdentityFailure {
    IdentityFailure::Refused(IdentityError::new(code, message))
}

/// `countOf`: a count the engine reports is a non-negative safe integer, or the store cannot be trusted with it.
fn count_of(count: Option<f64>) -> Result<i64, IdentityFailure> {
    match count {
        Some(n) if n.is_finite() && n.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&n) => {
            Ok(n as i64)
        }
        _ => Err(refuse(
            IdentityErrorCode::Storage,
            "invalid engine rebind count",
        )),
    }
}

/// `createBackfill({ service, engine, clock })`; the service is handed to each call.
pub struct Backfill {
    /// The engine port.
    pub engine: Box<dyn MetadataRebindPort>,
    /// Epoch milliseconds.
    pub clock: Box<dyn Fn() -> i64>,
    /// A fresh operation id (`randomUUID()`).
    pub operation_id: Box<dyn FnMut() -> String>,
}

impl Backfill {
    /// `run({ linkId, dryRun }, actor)`.
    pub fn run(
        &mut self,
        s: &mut IdentityService,
        link_id: &str,
        dry_run: bool,
        actor: &Actor,
    ) -> Result<BackfillReport, IdentityFailure> {
        let link = s.get_link(link_id)?;
        s.authorize_action(IdentityAction::Backfill, &link.human_id, actor)?;
        if link.revoked_at.is_some() {
            return Err(refuse(
                IdentityErrorCode::Conflict,
                "cannot backfill a removed link",
            ));
        }
        if !is_user_principal(&link.v1_principal) || !link.v1_principal.starts_with("user:v1:") {
            return Err(refuse(
                IdentityErrorCode::Storage,
                "invalid source principal",
            ));
        }
        let to = derive_user_principal(&link.human_id)?;
        let mut record = s.backfill_record(&link.id)?;
        if record
            .as_ref()
            .is_some_and(|r| r.state == "reversing" || r.state == "reversed")
        {
            return Err(refuse(
                IdentityErrorCode::Conflict,
                "backfill was reversed or is reversing",
            ));
        }
        if !dry_run && record.is_none() {
            s.reserve_backfill(&link.id, &(self.operation_id)(), actor)?;
            record = s.backfill_record(&link.id)?;
        }
        let (count, receipt) = match &record {
            Some(r) if !dry_run && r.state == "applied" => {
                (r.count.map(|c| c as f64), r.receipt.clone())
            }
            _ => {
                let operation_id = match &record {
                    Some(r) => r.operation_id.clone(),
                    None => (self.operation_id)(),
                };
                let result =
                    self.engine
                        .rebind(s, &link.v1_principal, &to, dry_run, &operation_id)?;
                let count = count_of(Some(result.count))?;
                if !dry_run {
                    let receipt = result
                        .receipt
                        .as_deref()
                        .filter(|r| !r.is_empty())
                        .ok_or_else(|| {
                            refuse(
                                IdentityErrorCode::Storage,
                                "engine must return a reversible receipt",
                            )
                        })?;
                    s.finish_backfill(&link.id, BackfillState::Applied, count, receipt)?;
                }
                (Some(result.count), result.receipt)
            }
        };
        let report = BackfillReport {
            link_id: link.id.clone(),
            from: link.v1_principal.clone(),
            to: to.clone(),
            dry_run,
            count: count_of(count)?,
            at: (self.clock)(),
            receipt: receipt.clone(),
        };
        s.emit(
            "identity.backfill",
            &link.id,
            vec![
                ("from", json!(report.from)),
                ("to", json!(to)),
                ("count", json!(report.count)),
                ("dryRun", json!(dry_run)),
                ("at", json!(report.at)),
                ("receipt", json!(receipt.unwrap_or_default())),
            ],
            Some(actor),
        );
        Ok(report)
    }

    /// `reverse({ linkId, dryRun }, actor)`: how many rows were (or would be) moved back.
    pub fn reverse(
        &mut self,
        s: &mut IdentityService,
        link_id: &str,
        dry_run: bool,
        actor: &Actor,
    ) -> Result<i64, IdentityFailure> {
        let link = s.get_link(link_id)?;
        s.authorize_action(IdentityAction::Backfill, &link.human_id, actor)?;
        let record = s
            .backfill_record(&link.id)?
            .filter(|r| r.state != "running")
            .ok_or_else(|| {
                refuse(
                    IdentityErrorCode::Conflict,
                    "no applied backfill to reverse",
                )
            })?;
        if record.state == "reversed" {
            return Ok(record.count.unwrap_or(0));
        }
        let receipt = record.receipt.clone().unwrap_or_default();
        if !dry_run {
            s.finish_backfill(
                &link.id,
                BackfillState::Reversing,
                record.count.unwrap_or(0),
                &receipt,
            )?;
        }
        let reported = self.engine.reverse(
            &receipt,
            dry_run,
            &format!("{}:reverse", record.operation_id),
        )?;
        let count = count_of(Some(reported))?;
        if !dry_run {
            s.finish_backfill(&link.id, BackfillState::Reversed, count, &receipt)?;
        }
        s.emit(
            "identity.backfill.reversed",
            &link.id,
            vec![
                ("count", json!(count)),
                ("dryRun", json!(dry_run)),
                ("from", json!(derive_user_principal(&link.human_id)?)),
                ("to", json!(link.v1_principal)),
            ],
            Some(actor),
        );
        Ok(count)
    }
}
