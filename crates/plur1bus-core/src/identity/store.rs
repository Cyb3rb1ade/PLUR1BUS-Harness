//! `identity/store.ts`: `state/identity.sqlite`, opened as the TypeScript store opens it (P4-12 task 4, ruling R4).
//!
//! The file is created with a private directory (0700) and a private file (0600, then the host's `secure_path`), set to WAL
//! with `foreign_keys`, the five second busy timeout, `temp_store = MEMORY` and `secure_delete`, and migrated to
//! [`SCHEMA_VERSION`] by the same two steps, each in one `BEGIN IMMEDIATE` transaction with its version bump. A file from a
//! newer harness is refused and never altered. The migration texts are the TypeScript texts byte for byte: SQLite keeps a
//! `CREATE` statement as written, so `sqlite_master` of a store created here equals one created there (`schema.json` of
//! `fixtures/parity/identity-store/`).
//!
//! Pending proofs live in a `TEMP` table of the connection: they cannot enter a backup of the durable store and are gone
//! with the process. `attempts` (the limiter's counters) is durable, so a restart does not reset a brute force.
use super::error::{IdentityError, IdentityErrorCode};
use super::ratelimit::{AttemptRow, AttemptStore};
use plur1bus_store::rusqlite::{self, Connection, OptionalExtension};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec};
use std::path::Path;

/// `SCHEMA_VERSION`.
pub const SCHEMA_VERSION: u32 = 2;

/// `MIGRATIONS`: entry `v` migrates from `v` to `v + 1`; append only.
pub const MIGRATIONS: &[&str] = &[
    r#"
  CREATE TABLE humans (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL
  ) STRICT;
  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    human_id TEXT NOT NULL REFERENCES humans(id),
    channel TEXT NOT NULL, account_id TEXT NOT NULL, channel_user_id TEXT NOT NULL,
    display_name TEXT,
    v1_principal TEXT NOT NULL,
    -- RULING: signed_challenge is part of the model, but no flow offers it yet (fail closed).
    proof_method TEXT NOT NULL CHECK (proof_method IN ('pairing_code', 'owner_manual', 'signed_challenge')),
    linked_at INTEGER NOT NULL, linked_by TEXT NOT NULL,
    revoked_at INTEGER, revoked_by TEXT
  ) STRICT;
  -- N:1: many identities per human, but an identity belongs to at most one human at a time (ADR-007 Q4).
  CREATE UNIQUE INDEX identities_active ON identities(channel, account_id, channel_user_id) WHERE revoked_at IS NULL;
  CREATE INDEX identities_human ON identities(human_id);
  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    human_id TEXT NOT NULL REFERENCES humans(id),
    channel TEXT NOT NULL,
    salt TEXT NOT NULL, code_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'confirmed', 'declined', 'expired')),
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
    claim_account_id TEXT, claim_user_id TEXT, claim_display_name TEXT, claimed_at INTEGER, confirm_by INTEGER,
    resolved_at INTEGER, link_id TEXT
  ) STRICT;
  CREATE INDEX pairings_state ON pairings(state, channel);
  CREATE TABLE attempts (
    key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL
  ) STRICT;
  "#,
    r#"DROP TABLE pairings;
   CREATE TABLE backfills (
     link_id TEXT PRIMARY KEY REFERENCES identities(id), operation_id TEXT NOT NULL UNIQUE,
     state TEXT NOT NULL CHECK (state IN ('running','applied','reversing','reversed')),
     actor_hash TEXT NOT NULL, at INTEGER NOT NULL, count INTEGER, receipt TEXT
   ) STRICT;"#,
];

/// The connection's own table of pending proofs, created on every open.
const TEMP_PAIRINGS: &str = r#"CREATE TEMP TABLE pairings (
      id TEXT PRIMARY KEY, human_id TEXT NOT NULL, channel TEXT NOT NULL,
      salt TEXT NOT NULL, code_hash TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
      claim_account_id TEXT, claim_user_id TEXT, claim_display_name TEXT, claimed_at INTEGER,
      confirm_by INTEGER, resolved_at INTEGER, link_id TEXT
    ) STRICT; CREATE INDEX temp.pairings_state ON pairings(state, channel);"#;

/// How `identity.sqlite` is opened: what `openStore` does.
pub fn owner_spec() -> OwnerSpec {
    OwnerSpec {
        store: StoreSpec {
            foreign_keys: true,
            pragmas: &["PRAGMA temp_store = MEMORY", "PRAGMA secure_delete = ON"],
            ..StoreSpec::new("identity", SCHEMA_VERSION)
        },
        journal: Journal::Wal,
        schema: Schema::Steps(MIGRATIONS),
        create: false,
    }
}

fn storage(message: String) -> IdentityError {
    IdentityError::new(IdentityErrorCode::Storage, message)
}

/// What `openStore` reports for a store that cannot be opened: a newer schema by its numbers, anything else as unavailable.
fn open_error(error: StoreError) -> IdentityError {
    match error {
        StoreError::NewerSchema {
            found, supported, ..
        } => storage(format!(
            "identity store is schema {found}, newer than this harness ({supported})"
        )),
        other => storage(format!("identity store unavailable: {other}")),
    }
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `closeSync(openSync(file, "a", 0o600))`: the modes apply to what
/// is created (under the umask), an existing directory or file keeps its own.
pub(crate) fn create_private(file: &Path) -> std::io::Result<()> {
    let mut dir = std::fs::DirBuilder::new();
    dir.recursive(true);
    let mut open = std::fs::OpenOptions::new();
    open.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        dir.mode(0o700);
        open.mode(0o600);
    }
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            dir.create(parent)?;
        }
    }
    open.open(file).map(drop)
}

/// `openStore(file)`: creates (private directory and file), opens and migrates the identity database and creates the
/// connection's `TEMP` table. `secure_path` is the host's `securePath` (mode 0600 on POSIX, the owner-only DACL on Windows);
/// its failure is not looked at, as in TypeScript.
pub fn open_store(file: &Path, secure_path: &dyn Fn(&Path)) -> Result<Store, IdentityError> {
    create_private(file).map_err(|e| storage(format!("identity store unavailable: {e}")))?;
    secure_path(file);
    let store = Store::open_owner(file, &owner_spec()).map_err(open_error)?;
    store
        .conn()
        .execute_batch(TEMP_PAIRINGS)
        .map_err(|e| storage(format!("identity store unavailable: {e}")))?;
    Ok(store)
}

/// The `attempts` table behind the limiter (`createLimiter(db, clock)`): the three statements of `ratelimit.ts`.
pub struct SqlAttempts<'c>(pub &'c Connection);

impl AttemptStore for SqlAttempts<'_> {
    type Error = rusqlite::Error;

    fn get(&self, key: &str) -> Result<Option<AttemptRow>, Self::Error> {
        self.0
            .prepare_cached(
                "SELECT failures, window_start, locked_until FROM attempts WHERE key = ?",
            )?
            .query_row([key], |row| {
                Ok(AttemptRow {
                    failures: row.get(0)?,
                    window_start: row.get(1)?,
                    locked_until: row.get(2)?,
                })
            })
            .optional()
    }

    fn put(&mut self, key: &str, row: AttemptRow) -> Result<(), Self::Error> {
        self.0
            .prepare_cached(
                "INSERT INTO attempts(key, failures, window_start, locked_until) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until",
            )?
            .execute(rusqlite::params![key, row.failures, row.window_start, row.locked_until])
            .map(drop)
    }

    fn delete(&mut self, key: &str) -> Result<(), Self::Error> {
        self.0
            .prepare_cached("DELETE FROM attempts WHERE key = ?")?
            .execute([key])
            .map(drop)
    }

    fn prune_rows(&mut self, locked_before: i64, window_before: i64) -> Result<(), Self::Error> {
        self.0
            .prepare_cached("DELETE FROM attempts WHERE locked_until < ? AND window_start < ?")?
            .execute([locked_before, window_before])
            .map(drop)
    }
}
