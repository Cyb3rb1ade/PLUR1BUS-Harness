//! `memory-sensitivity/store.ts`: `state/memory-sensitivity.sqlite`, opened as the TypeScript store opens it (P4-12 task 7,
//! ruling R4). A library: nothing calls it yet.
//!
//! What the TypeScript constructor does, and so what [`MemorySensitivityStore::open`] does and nothing more: SQLite creates a
//! missing file (`new DatabaseSync(path)`), no directory is created, no mode is set and the host's `securePath` is not
//! applied (inventory 15, noted for `docs/phase4/defects.md`: the other three stores apply 0700/0600, this one does not);
//! `journal_mode = WAL`; `busy_timeout = 5000`; `foreign_keys` is not set by the TypeScript code, so it is what
//! `node:sqlite` leaves: **on** (`schema.json` records 1, not the 0 the P4-01 spike expected); `user_version` is neither
//! read nor written and there is no migration or `ALTER` guard: a file an older layout left behind is used as it is
//! (`CREATE TABLE IF NOT EXISTS`, then `CREATE INDEX IF NOT EXISTS`, which does add a missing index). The `CREATE` texts are
//! the TypeScript texts byte for byte: SQLite keeps the statement as written, so `sqlite_master` of a store created here
//! equals one created there (`fixtures/parity/sensitivity/schema.json`). The table is not `STRICT`.
//!
//! Where TypeScript defaults a timestamp to `Date.now()` (inventory 13) the Rust method takes the time as a parameter and
//! the caller passes the clock (ruling R6). `set` and `clear` read and then write without a transaction, as TypeScript does.
use super::scanner::MemorySensitivityRecord;
use crate::js::{json_stringify, sort_default};
use plur1bus_store::rusqlite::{self, OptionalExtension};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec};
use std::fmt;
use std::path::Path;

/// The statements of `#init`, after the two pragmas, byte for byte (the indentation is part of `sqlite_master`).
pub const SCHEMA: &str = r#"
      CREATE TABLE IF NOT EXISTS card_sensitivity (
        card_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        categories TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('rule', 'manual', 'model')),
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_sensitivity_hash ON card_sensitivity(content_hash);
    "#;

/// How `memory-sensitivity.sqlite` is opened: what the constructor does (WAL, five second busy timeout, SQLite creates the
/// file, `foreign_keys` as `node:sqlite` leaves it, `user_version` untouched).
pub fn owner_spec() -> OwnerSpec {
    OwnerSpec {
        store: StoreSpec {
            foreign_keys: true,
            ..StoreSpec::new("memory-sensitivity", 0)
        },
        journal: Journal::Wal,
        schema: Schema::Unversioned,
        create: true,
    }
}

/// What a store call can raise: an error SQLite raised, or a `categories` column that is not a JSON array of strings (the
/// TypeScript `JSON.parse` throws there, `as SensitivityCategory[]` checks nothing).
#[derive(Debug)]
pub enum SensitivityError {
    /// SQLite failed (a missing column of an older layout, a `CHECK`, a busy file).
    Sqlite(rusqlite::Error),
    /// The stored `categories` text of a row is not a JSON array of strings.
    Categories(String),
}

impl SensitivityError {
    /// The extended result code SQLite raised (a statement that does not prepare carries it in `SqlInputError`).
    pub fn sqlite_code(&self) -> Option<i32> {
        match self {
            Self::Sqlite(rusqlite::Error::SqliteFailure(code, _)) => Some(code.extended_code),
            Self::Sqlite(rusqlite::Error::SqlInputError { error, .. }) => Some(error.extended_code),
            _ => None,
        }
    }
}

impl fmt::Display for SensitivityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite: {e}"),
            Self::Categories(text) => {
                write!(f, "categories is not a JSON array of strings: {text}")
            }
        }
    }
}

impl std::error::Error for SensitivityError {}

impl From<rusqlite::Error> for SensitivityError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// The result of [`MemorySensitivityStore::clear`]: `{ cleared, remaining }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClearOutcome {
    /// `cleared`: whether a record existed.
    pub cleared: bool,
    /// `remaining`: the categories left on the record.
    pub remaining: Vec<String>,
}

/// `JSON.stringify(array of strings)`.
fn json_array(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|s| json_stringify(s)).collect();
    format!("[{}]", parts.join(","))
}

fn record_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<(MemorySensitivityRecord, String)> {
    let categories: String = row.get(2)?;
    Ok((
        MemorySensitivityRecord {
            card_id: row.get(0)?,
            content_hash: row.get(1)?,
            categories: Vec::new(),
            source: row.get(3)?,
            updated_at: row.get(4)?,
        },
        categories,
    ))
}

fn finish(
    parsed: (MemorySensitivityRecord, String),
) -> Result<MemorySensitivityRecord, SensitivityError> {
    let (mut record, text) = parsed;
    record.categories =
        serde_json::from_str(&text).map_err(|_| SensitivityError::Categories(text))?;
    Ok(record)
}

/// `MemorySensitivityStore`.
pub struct MemorySensitivityStore {
    store: Store,
}

impl MemorySensitivityStore {
    /// `new MemorySensitivityStore({ path })`: opens (SQLite creates a missing file, in a directory that exists) and runs
    /// `#init`.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let store = Store::open_owner(path, &owner_spec())?;
        store.conn().execute_batch(SCHEMA)?;
        Ok(Self { store })
    }

    /// `hasManualCategories(categories)`: whether a manual record carries any of `categories`. An empty list is `false`
    /// without a query.
    pub fn has_manual_categories(&self, categories: &[String]) -> Result<bool, SensitivityError> {
        if categories.is_empty() {
            return Ok(false);
        }
        let present: i64 = self
            .store
            .conn()
            .prepare_cached(
                "\n      SELECT EXISTS (\n        SELECT 1 FROM card_sensitivity AS card, json_each(card.categories) AS category\n        WHERE card.source = 'manual' AND category.value IN (SELECT value FROM json_each(?))\n      ) AS present\n    ",
            )?
            .query_row([json_array(categories)], |row| row.get(0))?;
        Ok(present == 1)
    }

    /// `get(cardId)`.
    pub fn get(&self, card_id: &str) -> Result<Option<MemorySensitivityRecord>, SensitivityError> {
        self.store
            .conn()
            .prepare_cached("SELECT card_id, content_hash, categories, source, updated_at FROM card_sensitivity WHERE card_id = ?")?
            .query_row([card_id], record_of)
            .optional()?
            .map(finish)
            .transpose()
    }

    /// `getByHash(contentHash)`: the newest record of that hash; `""` is never looked up. Records of equal age: the one SQLite
    /// returns first (the earliest written of them, `fixtures/parity/sensitivity`, scenario `get-by-hash-ties`).
    pub fn get_by_hash(
        &self,
        content_hash: &str,
    ) -> Result<Option<MemorySensitivityRecord>, SensitivityError> {
        if content_hash.is_empty() {
            return Ok(None);
        }
        self.store
            .conn()
            .prepare_cached("SELECT card_id, content_hash, categories, source, updated_at FROM card_sensitivity WHERE content_hash = ? ORDER BY updated_at DESC LIMIT 1")?
            .query_row([content_hash], record_of)
            .optional()?
            .map(finish)
            .transpose()
    }

    /// `set(cardId, categories, source, contentHash, nowMs)`: a manual record is not overwritten by another source (the
    /// record comes back as it is, nothing is written); otherwise the categories are de-duplicated and sorted in
    /// `Array.prototype.sort` order and the record is upserted. `source` is bound as given: the table's `CHECK` refuses a
    /// value outside `rule`, `manual`, `model`, a table of an older layout without it does not.
    pub fn set(
        &self,
        card_id: &str,
        categories: &[String],
        source: &str,
        content_hash: &str,
        now_ms: i64,
    ) -> Result<MemorySensitivityRecord, SensitivityError> {
        if let Some(existing) = self.get(card_id)? {
            if existing.source == "manual" && source != "manual" {
                return Ok(existing);
            }
        }
        let mut cats: Vec<String> = Vec::new();
        for c in categories {
            if !cats.contains(c) {
                cats.push(c.clone());
            }
        }
        sort_default(&mut cats);
        self.store
            .conn()
            .prepare_cached(
                "\n      INSERT INTO card_sensitivity (card_id, content_hash, categories, source, updated_at)\n      VALUES (?, ?, ?, ?, ?)\n      ON CONFLICT(card_id) DO UPDATE SET\n        content_hash = excluded.content_hash,\n        categories = excluded.categories,\n        source = excluded.source,\n        updated_at = excluded.updated_at\n    ",
            )?
            .execute(rusqlite::params![card_id, content_hash, json_array(&cats), source, now_ms])?;
        Ok(MemorySensitivityRecord {
            card_id: card_id.to_owned(),
            content_hash: content_hash.to_owned(),
            categories: cats,
            source: source.to_owned(),
            updated_at: now_ms as f64,
        })
    }

    /// `clear(cardId, category, nowMs)`: without a category (`None`, and `""` too: the TypeScript tests `!category`) the
    /// record goes; with one, that category is taken off and the record goes when it was the last. A category the record
    /// does not carry still rewrites the record (new `updated_at`) and answers `cleared: true`.
    pub fn clear(
        &self,
        card_id: &str,
        category: Option<&str>,
        now_ms: i64,
    ) -> Result<ClearOutcome, SensitivityError> {
        let Some(existing) = self.get(card_id)? else {
            return Ok(ClearOutcome {
                cleared: false,
                remaining: Vec::new(),
            });
        };
        let delete = || -> Result<ClearOutcome, SensitivityError> {
            self.store
                .conn()
                .prepare_cached("DELETE FROM card_sensitivity WHERE card_id = ?")?
                .execute([card_id])?;
            Ok(ClearOutcome {
                cleared: true,
                remaining: Vec::new(),
            })
        };
        let category = match category {
            Some(c) if !c.is_empty() => c,
            _ => return delete(),
        };
        let remaining: Vec<String> = existing
            .categories
            .into_iter()
            .filter(|c| c != category)
            .collect();
        if remaining.is_empty() {
            return delete();
        }
        self.store
            .conn()
            .prepare_cached("\n      UPDATE card_sensitivity\n      SET categories = ?, updated_at = ?\n      WHERE card_id = ?\n    ")?
            .execute(rusqlite::params![json_array(&remaining), now_ms, card_id])?;
        Ok(ClearOutcome {
            cleared: true,
            remaining,
        })
    }

    /// The open connection, for a reader that wants the tables (tests, a dump).
    pub fn conn(&self) -> &rusqlite::Connection {
        self.store.conn()
    }

    /// `close()`.
    pub fn close(self) {
        drop(self);
    }
}
