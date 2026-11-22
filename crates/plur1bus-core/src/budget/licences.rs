//! `licences/ledger.ts` and `licences/memory.ts`: the shared model-licence acceptance ledger (`state/model-licences.sqlite`)
//! and the checks that keep a non-commercial model out of a configuration until a person has accepted its licence at the
//! pinned revision. The caller supplies a model selection, never the recorded actor or the time.
//!
//! The four non-commercial model ids and their immutable revisions are **not** in this file: they come in as a
//! [`NcCatalogue`] (R-K-2), so product code carries no reference to those models and the flip supplies the pinned list from
//! the engine catalogue. The rules over the catalogue are the TypeScript rules.
//!
//! Differences from the TypeScript constructor, none of them visible in the file: there is no `:memory:` ledger (tests use a
//! temp file), and the busy timeout is the store crate's five seconds where `node:sqlite` waits not at all.
use super::{BudgetError, Clock};
use crate::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_store::rusqlite::{params, Connection};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::Arc;

/// `LicenceAcceptance`: one confirmed licence at one revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LicenceAcceptance {
    /// Who confirmed.
    pub who: String,
    /// When, as an ISO 8601 UTC string (the ledger's clock, never the caller's).
    pub at: String,
    /// The licence.
    pub licence: String,
    /// The model.
    pub model: String,
    /// The artifact revision.
    pub revision: String,
    /// `memory` or `voice`.
    pub source: String,
}

/// Where the confirmation was asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LicenceSource {
    /// The memory engine's models.
    Memory,
    /// The voice models.
    Voice,
}

impl LicenceSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Voice => "voice",
        }
    }
}

/// Why a licence operation failed.
#[derive(Debug)]
pub enum LicenceError {
    /// `RpcError`: the code (`E_INVALID_PARAMS`, `E_DENIED`), its text and its `reason`, if it has one.
    Rpc {
        /// The RPC error code.
        code: &'static str,
        /// The text.
        message: String,
        /// `data.reason`.
        reason: Option<&'static str>,
    },
    /// The audit sink could not record the event; the confirmation is not persisted.
    Audit(String),
    /// The store failed.
    Store(BudgetError),
}

impl std::fmt::Display for LicenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rpc { message, .. } => f.write_str(message),
            Self::Audit(m) => f.write_str(m),
            Self::Store(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for LicenceError {}

impl From<BudgetError> for LicenceError {
    fn from(e: BudgetError) -> Self {
        Self::Store(e)
    }
}

impl From<plur1bus_store::rusqlite::Error> for LicenceError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::Store(e.into())
    }
}

fn rpc(code: &'static str, message: &str, reason: Option<&'static str>) -> LicenceError {
    LicenceError::Rpc {
        code,
        message: message.to_owned(),
        reason,
    }
}

const TABLE: &str = "CREATE TABLE IF NOT EXISTS model_licences (who TEXT NOT NULL, at TEXT NOT NULL, licence TEXT NOT NULL, model TEXT NOT NULL, revision TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(who,licence,model,revision,source))";

/// `LicenceLedger`.
pub struct LicenceLedger {
    store: Store,
    audit: Box<dyn AuditSink>,
    clock: Arc<dyn Clock>,
}

fn row(
    r: &plur1bus_store::rusqlite::Row<'_>,
) -> plur1bus_store::rusqlite::Result<LicenceAcceptance> {
    Ok(LicenceAcceptance {
        who: r.get(0)?,
        at: r.get(1)?,
        licence: r.get(2)?,
        model: r.get(3)?,
        revision: r.get(4)?,
        source: r.get(5)?,
    })
}

impl LicenceLedger {
    /// `new LicenceLedger(path, audit, clock)`: the directory 0700, the file 0600, `synchronous = FULL`, the one table.
    pub fn open(
        path: &Path,
        audit: Box<dyn AuditSink>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, BudgetError> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            let mut b = std::fs::DirBuilder::new();
            b.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                b.mode(0o700);
            }
            b.create(dir)
                .map_err(|e| BudgetError::Sqlite(e.to_string()))?;
        }
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: Synchronous::Full,
                ..StoreSpec::new("model-licences", 0)
            },
            // The TypeScript ledger never sets the journal mode and never reads `user_version`.
            journal: Journal::Unchanged,
            schema: Schema::Unversioned,
            create: true,
        };
        let store = Store::open_owner(path, &owner)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        store
            .conn()
            .execute_batch(TABLE)
            .map_err(BudgetError::from)?;
        Ok(Self {
            store,
            audit,
            clock,
        })
    }

    fn append(&mut self, e: &AuditEvent) -> Result<(), LicenceError> {
        self.audit.append(e).map_err(LicenceError::Audit)
    }

    /// `recordAccess`: audits that `who` looked at the licences.
    pub fn record_access(&mut self, who: &str) -> Result<(), LicenceError> {
        let e = AuditEvent {
            at: self.clock.now(),
            user: who.to_owned(),
            host: "rpc".into(),
            action: "model.licence.access".into(),
            target: "model-licences".into(),
            detail: Vec::new(),
        };
        self.append(&e)
    }

    /// `confirm`: audits first, then persists; a failing audit sink means nothing is persisted. A repeated confirmation of
    /// the same actor, licence, model, revision and source keeps the first row (and so its time).
    pub fn confirm(
        &mut self,
        who: &str,
        model: &str,
        licence: &str,
        revision: &str,
        source: LicenceSource,
    ) -> Result<LicenceAcceptance, LicenceError> {
        // Two reads of the clock, in this order, as the TypeScript code does.
        let at = super::period::iso_utc(self.clock.now());
        let e = AuditEvent {
            at: self.clock.now(),
            user: who.to_owned(),
            host: "rpc".into(),
            action: "model.licence.confirmed".into(),
            target: model.to_owned(),
            detail: vec![
                ("licence".into(), Value::String(licence.to_owned())),
                ("revision".into(), Value::String(revision.to_owned())),
                ("source".into(), Value::String(source.as_str().to_owned())),
            ],
        };
        self.append(&e)?;
        let s = source.as_str();
        let accepted = self.store.write_with(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO model_licences VALUES (?,?,?,?,?,?)",
                params![who, at, licence, model, revision, s],
            )?;
            Ok::<_, BudgetError>(tx.query_row(
                "SELECT * FROM model_licences WHERE who=? AND licence=? AND model=? AND revision=? AND source=?",
                params![who, licence, model, revision, s],
                row,
            )?)
        })?;
        Ok(accepted)
    }

    /// `list`: every acceptance, by time then model.
    pub fn list(&self) -> Result<Vec<LicenceAcceptance>, BudgetError> {
        list_in(self.store.conn())
    }

    /// `has`: whether `who` accepted `licence` for `model` at `revision` (any source).
    pub fn has(
        &self,
        who: &str,
        model: &str,
        licence: &str,
        revision: &str,
    ) -> Result<bool, BudgetError> {
        Ok(self
            .store
            .conn()
            .prepare(
                "SELECT 1 FROM model_licences WHERE who=? AND model=? AND licence=? AND revision=?",
            )?
            .exists(params![who, model, licence, revision])?)
    }
}

fn list_in(conn: &Connection) -> Result<Vec<LicenceAcceptance>, BudgetError> {
    let mut st = conn.prepare("SELECT * FROM model_licences ORDER BY at,model")?;
    let rows = st.query_map([], row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// One non-commercial model of the pinned catalogue.
#[derive(Clone, Debug)]
pub struct NcModel {
    /// The model id.
    pub model: String,
    /// The immutable artifact revision of the pinned catalogue.
    pub revision: String,
}

/// The non-commercial models, their licence and the models whose selection is refused with a text of its own (a name that
/// was replaced by a pinned variant). R-K-2: product code does not carry these values; the flip supplies them.
#[derive(Clone, Debug)]
pub struct NcCatalogue {
    /// `NC_LICENCE`.
    pub licence: String,
    /// `NC_MODELS` with the revision of each.
    pub models: Vec<NcModel>,
    /// A model of `models` that must not be selected, with the text of the refusal (`E_INVALID_PARAMS`).
    pub superseded: Vec<(String, String)>,
}

/// `memoryModel`'s result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryModel {
    /// The model.
    pub model: String,
    /// Its licence.
    pub licence: String,
    /// Its pinned revision.
    pub revision: String,
}

impl NcCatalogue {
    fn contains(&self, model: &str) -> bool {
        self.models.iter().any(|m| m.model == model)
    }

    /// `memoryModel`.
    pub fn memory_model(&self, model: &str) -> Result<MemoryModel, LicenceError> {
        if let Some((_, text)) = self.superseded.iter().find(|(m, _)| m == model) {
            return Err(rpc("E_INVALID_PARAMS", text, None));
        }
        let Some(m) = self.models.iter().find(|m| m.model == model) else {
            return Err(rpc(
                "E_INVALID_PARAMS",
                "unknown non-commercial model",
                None,
            ));
        };
        Ok(MemoryModel {
            model: model.to_owned(),
            licence: self.licence.clone(),
            revision: m.revision.clone(),
        })
    }
}

const DENIED_UNCONFIRMED: &str = "model licence confirmation required";
const DENIED_REVISION: &str = "selected model revision lacks persisted licence confirmation";

fn denied(message: &str) -> LicenceError {
    rpc("E_DENIED", message, Some("model-licence-required"))
}

/// `assertMemoryConfiguration`: every object in `value` that names a non-commercial model has a revision that is the pinned
/// one and an acceptance of it (by anyone) in `acceptances`.
pub fn assert_memory_configuration(
    cat: &NcCatalogue,
    value: &Value,
    acceptances: &[LicenceAcceptance],
) -> Result<(), LicenceError> {
    match value {
        Value::Object(o) => {
            if let Some(Value::String(model)) = o
                .get("model")
                .filter(|m| m.as_str().is_some_and(|s| cat.contains(s)))
            {
                let m = cat.memory_model(model)?;
                let revision = match o.get("revision") {
                    Some(Value::String(r)) => r.as_str(),
                    _ => m.revision.as_str(),
                };
                if revision != m.revision
                    || !acceptances.iter().any(|a| {
                        a.model == m.model && a.licence == m.licence && a.revision == revision
                    })
                {
                    return Err(denied(DENIED_REVISION));
                }
            }
            o.values()
                .try_for_each(|v| assert_memory_configuration(cat, v, acceptances))
        }
        Value::Array(items) => items
            .iter()
            .try_for_each(|v| assert_memory_configuration(cat, v, acceptances)),
        _ => Ok(()),
    }
}

/// `inspect` of `checkMemorySelection`: a selected non-commercial model needs `who`'s confirmation at its pinned revision.
fn inspect(
    cat: &NcCatalogue,
    ledger: &LicenceLedger,
    who: &str,
    v: &Value,
) -> Result<(), LicenceError> {
    match v {
        Value::String(s) if cat.contains(s) => {
            let m = cat.memory_model(s)?;
            if ledger.has(who, &m.model, &m.licence, &m.revision)? {
                Ok(())
            } else {
                Err(denied(DENIED_UNCONFIRMED))
            }
        }
        Value::Array(items) => items.iter().try_for_each(|x| inspect(cat, ledger, who, x)),
        Value::Object(o) => o.values().try_for_each(|x| inspect(cat, ledger, who, x)),
        _ => Ok(()),
    }
}

/// `/^(engine|embedding|memory|modelRoles|agents)(\.|$)/`.
fn is_memory_key(key: &str) -> bool {
    ["engine", "embedding", "memory", "modelRoles", "agents"]
        .iter()
        .any(|p| {
            key.strip_prefix(p)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
        })
}

/// `checkMemorySelection`: refuses a configuration change that selects a non-commercial model nobody confirmed, or pins
/// a revision (`...revision`) that has no acceptance.
pub fn check_memory_selection(
    cat: &NcCatalogue,
    ledger: &LicenceLedger,
    who: &str,
    changes: &[(String, Value)],
    current: Option<&Value>,
) -> Result<(), LicenceError> {
    for (key, value) in changes {
        if !is_memory_key(key) {
            continue;
        }
        inspect(cat, ledger, who, value)?;
        assert_memory_configuration(cat, value, &ledger.list()?)?;
        if !key.ends_with(".revision") {
            continue;
        }
        let Some(Value::Object(_)) = current else {
            continue;
        };
        let mut parent: Option<&Value> = current;
        let parts: Vec<&str> = key.split('.').collect();
        for part in &parts[..parts.len() - 1] {
            parent = match parent {
                Some(Value::Object(o)) => o.get(*part),
                _ => None,
            };
        }
        if let Some(Value::Object(p)) = parent {
            if let Some(Value::String(model)) = p
                .get("model")
                .filter(|m| m.as_str().is_some_and(|s| cat.contains(s)))
            {
                inspect(cat, ledger, who, &Value::String(model.clone()))?;
                let mut pinned: Map<String, Value> = p.clone();
                pinned.insert("revision".into(), value.clone());
                assert_memory_configuration(cat, &Value::Object(pinned), &ledger.list()?)?;
            }
        }
    }
    Ok(())
}
