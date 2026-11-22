//! The receipt store: `decision-receipts.sqlite`, created and owned by Rust (TypeScript never reads it), one
//! writer, every write one `BEGIN IMMEDIATE` transaction. A file from a newer schema is refused and left as it was.
use super::format::{Outcome, Receipt, ReceiptDraft, ReceiptError, ReceiptUseCase};
use super::rights;
use crate::budget::{Clock, IdSource, UuidIds};
use crate::delivery::SecurePath;
use crate::private_store;
use crate::rbac::types::Principal;
use plur1bus_store::rusqlite::{params, OptionalExtension};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use std::path::PathBuf;
use std::sync::Arc;

/// The file name proposed for the store (K11-Q6).
pub const FILE_NAME: &str = "decision-receipts.sqlite";

const DAY_MS: i64 = 86_400_000;
/// D133 ruling 6: thirty days.
pub const DEFAULT_MAX_AGE_MS: i64 = 30 * DAY_MS;
/// D133 section 6, the owner's proposal (K11-Q1): 20,000 receipts per installation.
pub const DEFAULT_MAX_COUNT: i64 = 20_000;

const V1: &str = r#"
CREATE TABLE receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  use_case TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  outcome TEXT,
  UNIQUE (turn_id, use_case)
) STRICT;
CREATE INDEX receipts_by_time ON receipts(created_at);
CREATE INDEX receipts_by_session ON receipts(session_id, seq);
CREATE TABLE adoptions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  report_hash TEXT NOT NULL,
  adopted_by TEXT NOT NULL,
  adopted_at INTEGER NOT NULL
) STRICT;
"#;
const V2: &str = r#"
ALTER TABLE adoptions ADD COLUMN prompt_version TEXT;
ALTER TABLE adoptions ADD COLUMN backend TEXT;
ALTER TABLE adoptions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0,1));
CREATE UNIQUE INDEX adoption_pending ON adoptions(pending) WHERE pending=1;
"#;
static STEPS: [&str; 2] = [V1, V2];

/// How long receipts are kept and how many.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Retention {
    /// A receipt older than this goes (age equal to it stays).
    pub max_age_ms: i64,
    /// More receipts than this: the oldest go first.
    pub max_count: i64,
}

impl Retention {
    /// Both limits must be at least 1.
    pub fn new(max_age_ms: i64, max_count: i64) -> Result<Self, ReceiptError> {
        if max_age_ms < 1 {
            return Err(ReceiptError::Invalid("maxAgeMs"));
        }
        if max_count < 1 {
            return Err(ReceiptError::Invalid("maxCount"));
        }
        Ok(Self {
            max_age_ms,
            max_count,
        })
    }
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            max_age_ms: DEFAULT_MAX_AGE_MS,
            max_count: DEFAULT_MAX_COUNT,
        }
    }
}

/// What opens a store.
pub struct ReceiptStoreOptions {
    /// The database file.
    pub path: PathBuf,
    /// The clock (a port; nothing here runs a timer).
    pub clock: Arc<dyn Clock>,
    /// Receipt ids; `None` is a random UUID.
    pub ids: Option<Arc<dyn IdSource>>,
    /// Retention.
    pub retention: Retention,
    /// The platform's owner-only hook; `None` applies mode 0600 on Unix and refuses elsewhere.
    pub secure_path: Option<SecurePath>,
}

/// What [`ReceiptStore::write`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteResult {
    /// The receipt was stored under this id.
    Written(String),
    /// The session is incognito: nothing was written.
    Skipped,
}

/// A page of receipts.
#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptPage {
    /// The receipts, oldest first.
    pub receipts: Vec<Receipt>,
    /// The cursor of the next page.
    pub next: Option<i64>,
}

/// A query of [`ReceiptStore::list`].
#[derive(Clone, Debug, Default)]
pub struct ListQuery {
    /// Only this session.
    pub session_id: Option<String>,
    /// Only this use case.
    pub use_case: Option<ReceiptUseCase>,
    /// Only receipts after this cursor.
    pub after: Option<i64>,
    /// Page size, 1 to 200 (0 means 50).
    pub limit: usize,
}

/// The receipts of every session.
pub struct ReceiptStore {
    pub(super) db: Store,
    pub(super) clock: Arc<dyn Clock>,
    pub(super) ids: Arc<dyn IdSource>,
    retention: Retention,
}

fn parse_row(body: &str, outcome: Option<String>) -> Result<Receipt, ReceiptError> {
    let bad = || ReceiptError::Store("a receipt row does not parse".into());
    let mut r: Receipt = serde_json::from_str(body).map_err(|_| bad())?;
    if let Some(o) = outcome {
        r.outcome = Some(serde_json::from_str::<Outcome>(&o).map_err(|_| bad())?);
    }
    r.validate().map_err(|_| bad())?;
    Ok(r)
}

impl ReceiptStore {
    #[cfg(test)]
    pub(crate) fn into_test_store(self) -> Store {
        self.db
    }

    /// Opens (and creates) the file.
    pub fn open(o: ReceiptStoreOptions) -> Result<Self, ReceiptError> {
        let store = Self::open_unreconciled(o)?;
        let pending: bool = store.db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM adoptions WHERE pending=1)",
            [],
            |row| row.get(0),
        )?;
        if pending {
            return Err(ReceiptError::Port("calibration recovery"));
        }
        Ok(store)
    }

    pub(super) fn open_unreconciled(o: ReceiptStoreOptions) -> Result<Self, ReceiptError> {
        Retention::new(o.retention.max_age_ms, o.retention.max_count)?;
        // A file from a newer schema must stay as it is: prepare() only creates what is missing, and the version check
        // of the store runs before any pragma.
        private_store::prepare_owner_only(&o.path, o.secure_path.as_deref()).map_err(|error| {
            match error {
                private_store::PrepareError::Io(_) => {
                    ReceiptError::Store("cannot prepare the receipt store".into())
                }
                private_store::PrepareError::Permissions => {
                    ReceiptError::Store("receipt store permissions unavailable".into())
                }
            }
        })?;
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: Synchronous::Full,
                ..StoreSpec::new("decision-receipts", STEPS.len() as u32)
            },
            journal: Journal::Wal,
            schema: Schema::Steps(&STEPS),
            create: true,
        };
        let db = Store::open_owner(&o.path, &owner)?;
        Ok(Self {
            db,
            clock: o.clock,
            ids: o.ids.unwrap_or_else(|| Arc::new(UuidIds)),
            retention: o.retention,
        })
    }

    /// The retention in force.
    pub fn retention(&self) -> Retention {
        self.retention
    }

    /// Stores one receipt. `incognito` is the property of the session and has to be given: an incognito session writes
    /// nothing at all (R-K-20). A second receipt for the same turn and use case is an error, never an overwrite (R-K-18).
    pub fn write(
        &mut self,
        draft: &ReceiptDraft,
        incognito: bool,
    ) -> Result<WriteResult, ReceiptError> {
        if incognito {
            return Ok(WriteResult::Skipped);
        }
        draft.validate()?;
        let at = self.clock.now();
        let id = self.ids.next_id();
        let receipt = draft.clone().into_receipt(id.clone(), at);
        receipt.validate()?;
        let body = serde_json::to_string(&receipt).map_err(|_| ReceiptError::Invalid("receipt"))?;
        self.db.write_with(|tx| {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT seq FROM receipts WHERE turn_id=? AND use_case=?",
                    params![receipt.turn_id, receipt.use_case.as_str()],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_some() {
                return Err(ReceiptError::Duplicate);
            }
            tx.execute(
                "INSERT INTO receipts(id,turn_id,session_id,agent,use_case,created_at,body) VALUES (?,?,?,?,?,?,?)",
                params![
                    receipt.id,
                    receipt.turn_id,
                    receipt.session_id,
                    receipt.agent,
                    receipt.use_case.as_str(),
                    receipt.at,
                    body
                ],
            )?;
            Ok(())
        })?;
        Ok(WriteResult::Written(id))
    }

    /// Records what happened after the turn (D2). Once per receipt.
    pub fn record_outcome(
        &mut self,
        receipt_id: &str,
        outcome: &Outcome,
    ) -> Result<(), ReceiptError> {
        outcome.validate()?;
        let text = serde_json::to_string(outcome).map_err(|_| ReceiptError::Invalid("outcome"))?;
        self.db.write_with(|tx| {
            let row: Option<Option<String>> = tx
                .query_row(
                    "SELECT outcome FROM receipts WHERE id=?",
                    [receipt_id],
                    |r| r.get(0),
                )
                .optional()?;
            match row {
                None => Err(ReceiptError::UnknownReceipt),
                Some(Some(_)) => Err(ReceiptError::OutcomeAlready),
                Some(None) => {
                    tx.execute(
                        "UPDATE receipts SET outcome=? WHERE id=?",
                        params![text, receipt_id],
                    )?;
                    Ok(())
                }
            }
        })
    }

    /// One receipt by id. No rights check: the host that holds the store is trusted; the listing for a person is
    /// [`ReceiptStore::list`].
    pub fn get(&self, id: &str) -> Result<Option<Receipt>, ReceiptError> {
        let row: Option<(String, Option<String>)> = self
            .db
            .conn()
            .query_row("SELECT body, outcome FROM receipts WHERE id=?", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        row.map(|(b, o)| parse_row(&b, o)).transpose()
    }

    /// `decision.receipts.list`: owner and admin only (ruling 11).
    pub fn list(&self, who: &Principal, q: &ListQuery) -> Result<ReceiptPage, ReceiptError> {
        if !rights::can_list(who) {
            return Err(ReceiptError::Denied);
        }
        let limit = match q.limit {
            0 => 50,
            n => n.min(200),
        };
        let use_case = q.use_case.map(ReceiptUseCase::as_str);
        let mut stmt = self.db.conn().prepare(
            "SELECT seq, body, outcome FROM receipts WHERE seq > ?1 AND (?2 IS NULL OR session_id = ?2) \
             AND (?3 IS NULL OR use_case = ?3) ORDER BY seq LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![
                q.after.unwrap_or(0),
                q.session_id,
                use_case,
                limit as i64 + 1
            ],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )?;
        let mut receipts = Vec::new();
        let mut last = None;
        let mut more = false;
        for row in rows {
            let (seq, body, outcome) = row?;
            if receipts.len() == limit {
                more = true;
                break;
            }
            receipts.push(parse_row(&body, outcome)?);
            last = Some(seq);
        }
        Ok(ReceiptPage {
            receipts,
            next: if more { last } else { None },
        })
    }

    /// How many receipts the store holds.
    pub fn count(&self) -> Result<i64, ReceiptError> {
        Ok(self
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM receipts", [], |r| r.get(0))?)
    }

    /// Applies the retention: first the age, then the number. A host calls this; nothing here runs a timer. Returns how
    /// many receipts went.
    pub fn prune(&mut self) -> Result<usize, ReceiptError> {
        let now = self.clock.now();
        let r = self.retention;
        self.db.write_with(|tx| {
            let by_age = tx.execute(
                "DELETE FROM receipts WHERE created_at < ?",
                [now.saturating_sub(r.max_age_ms)],
            )?;
            let by_count = tx.execute(
                "DELETE FROM receipts WHERE seq NOT IN (SELECT seq FROM receipts ORDER BY seq DESC LIMIT ?)",
                [r.max_count],
            )?;
            Ok::<usize, ReceiptError>(by_age + by_count)
        })
    }

    /// How many baseline adoptions were recorded.
    pub fn adoption_count(&self) -> Result<i64, ReceiptError> {
        Ok(self
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM adoptions WHERE pending=0", [], |r| {
                r.get(0)
            })?)
    }
}
