//! `approvals/db.ts` (D109 §6): `state/approvals.sqlite`, one file for the grants, the approval projection, the chain, its
//! keyed head and the decision signatures, so a grant and the chain entry that proves it commit in one transaction.
//!
//! The file is made private before SQLite touches it (directory 0700, file 0600, so `-wal` and `-shm` inherit the mode), set
//! to WAL with `synchronous = FULL` (a decision that was reported must survive a crash), and migrated to [`SCHEMA_VERSION`]
//! in **one** `BEGIN IMMEDIATE` transaction that re-reads the version under the write lock. A file from a newer core is
//! refused before anything about it changes beyond the pragmas TypeScript also sets first. The migration texts are the
//! TypeScript texts byte for byte: SQLite keeps a `CREATE` statement as written, and `sqlite_master` of a file made here must
//! equal one made there.
use plur1bus_store::rusqlite::Connection;
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec, Synchronous};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `APPROVALS_SCHEMA_VERSION`.
pub const SCHEMA_VERSION: u32 = 4;
/// `APPROVALS_DB_FILE`.
pub const DB_FILE: &str = "approvals.sqlite";

/// `MIGRATIONS` (`APPROVALS_MIGRATIONS`): entry `v - 1` takes the schema to version `v`; append only.
pub const MIGRATIONS: &[&str] = &[
    r#"
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      agent TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect TEXT,
      match_kind TEXT NOT NULL CHECK (match_kind IN ('action', 'capability', 'path')),
      match_path TEXT,
      match_access TEXT CHECK (match_access IS NULL OR match_access IN ('read', 'write')),
      match_recursive INTEGER CHECK (match_recursive IS NULL OR match_recursive IN (0, 1)),
      duration TEXT NOT NULL CHECK (duration IN ('once', 'task', 'session', 'always')),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      end_reason TEXT,
      last_used_at INTEGER,
      consumed_at INTEGER,
      action_hash TEXT,
      task_id TEXT,
      session_id TEXT,
      project_id TEXT,
      job_id TEXT,
      delegable INTEGER NOT NULL DEFAULT 0 CHECK (delegable IN (0, 1)),
      surface INTEGER NOT NULL CHECK (surface BETWEEN 0 AND 3),
      acknowledged_unsandboxed INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_unsandboxed IN (0, 1)),
      def_hash TEXT NOT NULL,
      chain_seq INTEGER NOT NULL,
      CHECK (match_kind <> 'path' OR (match_path IS NOT NULL AND match_access IS NOT NULL AND match_recursive IS NOT NULL))
    );
    CREATE INDEX grants_lookup ON grants (person, agent, capability);
    CREATE INDEX grants_task ON grants (task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX grants_session ON grants (session_id) WHERE session_id IS NOT NULL;

    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used', 'cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      decision_surface INTEGER CHECK (decision_surface IS NULL OR decision_surface BETWEEN 0 AND 3),
      used_at INTEGER,
      delegable INTEGER NOT NULL DEFAULT 0 CHECK (delegable IN (0, 1))
    );
    CREATE INDEX approvals_status ON approvals (status, expires_at);

    CREATE TABLE approval_chain (
      seq INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      nonce TEXT,
      payload TEXT NOT NULL,
      prev_mac TEXT NOT NULL,
      mac TEXT NOT NULL
    );
    CREATE UNIQUE INDEX approval_chain_once ON approval_chain (kind, ref_id) WHERE kind LIKE 'approval.%';
    CREATE INDEX approval_chain_ref ON approval_chain (ref_id);

    CREATE TABLE chain_head (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seq INTEGER NOT NULL,
      mac TEXT NOT NULL,
      tag TEXT NOT NULL
    );
  "#,
    // #192 option C: where a grant came from when an OS confirmation lifted its approval to T2. NULL for every earlier row.
    "ALTER TABLE grants ADD COLUMN attested_via TEXT;",
    // D109 §9.7: the signatures live outside the HMAC'd fields, so the chain is unchanged and unsigned rows stay valid.
    r#"
    CREATE TABLE approval_signatures (
      seq INTEGER PRIMARY KEY,
      alg TEXT NOT NULL,
      public_key TEXT NOT NULL,
      signature TEXT NOT NULL
    );
  "#,
    "ALTER TABLE grants ADD COLUMN origin TEXT;",
];

/// `ApprovalsDbError`.
#[derive(Debug)]
pub enum DbError {
    /// `newer-schema`: written by a newer core; the file is left as it was.
    NewerSchema(String),
    /// `open-failed`: the directory or file could not be prepared.
    OpenFailed(String),
    /// SQLite failed while setting up or migrating.
    Store(StoreError),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::NewerSchema(m) | DbError::OpenFailed(m) => f.write_str(m),
            DbError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<StoreError> for DbError {
    fn from(e: StoreError) -> Self {
        DbError::Store(e)
    }
}

impl From<plur1bus_store::rusqlite::Error> for DbError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        DbError::Store(StoreError::Sqlite(e))
    }
}

/// `approvalsDbPath(home)`: `<home>/state/approvals.sqlite` (the harness layout; never `config.json`).
pub fn db_path(home: &Path) -> PathBuf {
    home.join("state").join(DB_FILE)
}

/// What `openApprovalsDb` takes besides the path.
#[derive(Default)]
pub struct OpenOptions<'a> {
    /// `busyTimeoutMs`; 5000 when `None`.
    pub busy_timeout_ms: Option<u64>,
    /// `securePath`: the platform's owner-only permissions on top of POSIX mode 0600 (a port; the host supplies it).
    pub secure_path: Option<&'a dyn Fn(&Path)>,
}

fn prepare(path: &Path, o: &OpenOptions<'_>) -> std::io::Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(dir)?;
    }
    let mut f = std::fs::OpenOptions::new();
    f.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        f.mode(0o600);
    }
    drop(f.open(path)?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Not ours to change: the open above already created the file private.
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    if let Some(secure) = o.secure_path {
        secure(path);
    }
    Ok(())
}

/// `openApprovalsDb`: the opened, migrated store (the one writer of this file in this process).
pub fn open(path: &Path, o: &OpenOptions<'_>) -> Result<Store, DbError> {
    prepare(path, o)
        .map_err(|e| DbError::OpenFailed(format!("cannot prepare {}: {e}", path.display())))?;
    let owner = OwnerSpec {
        store: StoreSpec {
            synchronous: Synchronous::Full,
            ..StoreSpec::new("approvals", SCHEMA_VERSION)
        },
        journal: Journal::Wal,
        // The version is checked inside the one migration transaction below, as `migrate` does.
        schema: Schema::Unversioned,
        create: false,
    };
    let mut store = Store::open_owner(path, &owner)?;
    if let Some(ms) = o.busy_timeout_ms {
        store.conn().busy_timeout(Duration::from_millis(ms))?;
    }
    migrate_steps(&mut store, MIGRATIONS)?;
    Ok(store)
}

fn user_version(conn: &Connection) -> Result<u32, DbError> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// `migrateApprovalsSteps(db, steps)`: applies the missing steps of `steps` under one write lock; returns the version reached.
pub fn migrate_steps(store: &mut Store, steps: &[&str]) -> Result<u32, DbError> {
    let target = steps.len() as u32;
    if user_version(store.conn())? == target {
        return Ok(target);
    }
    store.write_with(|tx| {
        // Re-read under the write lock: another process may have migrated meanwhile.
        let mut v = user_version(tx)?;
        if v > target {
            return Err(DbError::NewerSchema(format!(
                "approvals store schema {v} is newer than this core's {target}; refusing to open it (upgrade the core)"
            )));
        }
        while v < target {
            v += 1;
            tx.execute_batch(steps[(v - 1) as usize])?;
            tx.execute_batch(&format!("PRAGMA user_version = {v}"))?;
        }
        Ok(v)
    })
}
