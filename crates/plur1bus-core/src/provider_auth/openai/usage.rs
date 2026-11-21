//! `openai-auth/usage.ts`: the ChatGPT-plan usage book, `state/openai-plan-usage.sqlite`. A separate plan unit: unknown usage
//! stays unknown (`NULL`), and no subscription unit is given a price. One table, created with `CREATE TABLE IF NOT EXISTS`, no
//! `user_version`; one row per call id, a repeated id changes nothing (`INSERT OR IGNORE`).
//!
//! Opened as the TypeScript constructor opens it (`PRAGMA busy_timeout=5000`, then the table text byte for byte, because SQLite
//! keeps it in `sqlite_master`), with one difference that only tightens: the file is created private (directory 0700, file
//! 0600, [`crate::private_store`]) where TypeScript relies on the 0700 `state/` directory its runtime makes. Writes run in
//! `BEGIN IMMEDIATE`.
use crate::private_store;
use plur1bus_store::rusqlite::params;
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec, Synchronous};
use serde_json::{json, Value};
use std::path::Path;

/// The constructor's text after the busy timeout, byte for byte.
pub const TABLE: &str = "CREATE TABLE IF NOT EXISTS plan_usage (id TEXT PRIMARY KEY, person TEXT NOT NULL, credential TEXT NOT NULL, model TEXT NOT NULL, input INTEGER, output INTEGER, at INTEGER NOT NULL)";

/// Why the book refused or failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UsageError {
    /// `RangeError('invalid plan usage')`: a count that is not a safe non-negative integer.
    Invalid,
    /// SQLite failed.
    Store(String),
}

impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UsageError::Invalid => f.write_str("invalid plan usage"),
            UsageError::Store(m) => write!(f, "plan usage store: {m}"),
        }
    }
}

impl std::error::Error for UsageError {}

impl From<StoreError> for UsageError {
    fn from(e: StoreError) -> UsageError {
        UsageError::Store(e.to_string())
    }
}

fn store_err(e: impl std::fmt::Display) -> UsageError {
    UsageError::Store(e.to_string())
}

/// The token counts of one call, as the provider reported them (`Usage`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlanUsage {
    /// `inputTokens`
    pub input_tokens: Option<f64>,
    /// `outputTokens`
    pub output_tokens: Option<f64>,
}

/// `total(person)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanTotal {
    /// `SUM(input)`, `None` when no call reported one.
    pub input_tokens: Option<i64>,
    /// `SUM(output)`.
    pub output_tokens: Option<i64>,
    /// `COUNT(*)`.
    pub calls: i64,
}

impl PlanTotal {
    /// The TypeScript object (`unit: "plan_tokens"`).
    pub fn json(&self) -> Value {
        json!({ "unit": "plan_tokens", "inputTokens": self.input_tokens, "outputTokens": self.output_tokens, "calls": self.calls })
    }
}

/// `PlanUsageStore`.
pub struct PlanUsageStore {
    db: Store,
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A count: `undefined`, or `Number.isSafeInteger(n) && n >= 0`.
fn count(v: Option<f64>) -> Result<Option<i64>, UsageError> {
    match v {
        None => Ok(None),
        Some(n) if n.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&n) => Ok(Some(n as i64)),
        Some(_) => Err(UsageError::Invalid),
    }
}

impl PlanUsageStore {
    /// `new PlanUsageStore(path)`.
    pub fn open(path: &Path) -> Result<PlanUsageStore, UsageError> {
        private_store::prepare(path).map_err(store_err)?;
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: Synchronous::Full,
                ..StoreSpec::new("openai-plan-usage", 0)
            },
            journal: Journal::Unchanged,
            schema: Schema::Unversioned,
            create: true,
        };
        let db = Store::open_owner(path, &owner)?;
        db.conn().execute_batch(TABLE).map_err(store_err)?;
        Ok(PlanUsageStore { db })
    }

    /// `record(id, person, credential, model, usage, at)`: a count must be a safe non-negative integer; a known id is kept.
    pub fn record(
        &mut self,
        id: &str,
        person: &str,
        credential: &str,
        model: &str,
        usage: PlanUsage,
        at: i64,
    ) -> Result<(), UsageError> {
        let input = count(usage.input_tokens)?;
        let output = count(usage.output_tokens)?;
        self.db.write_with(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO plan_usage VALUES (?,?,?,?,?,?,?)",
                params![id, person, credential, model, input, output, at],
            )
            .map(|_| ())
            .map_err(|e| UsageError::from(StoreError::from(e)))
        })
    }

    /// `total(person)`.
    pub fn total(&self, person: &str) -> Result<PlanTotal, UsageError> {
        self.db
            .conn()
            .query_row(
                "SELECT SUM(input) AS inputTokens, SUM(output) AS outputTokens, COUNT(*) AS calls FROM plan_usage WHERE person=?",
                params![person],
                |r| {
                    Ok(PlanTotal {
                        input_tokens: r.get(0)?,
                        output_tokens: r.get(1)?,
                        calls: r.get(2)?,
                    })
                },
            )
            .map_err(store_err)
    }
}
