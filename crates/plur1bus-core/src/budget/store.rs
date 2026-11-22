//! `budget/store.ts`: `state/budget.sqlite`, one `node:sqlite` file under `state/`, migrated by `PRAGMA user_version`. The
//! ledger holds counts and ids only: there is deliberately no column that could hold prompt or response content.
//!
//! The file is made private before SQLite touches it (directory 0700, file 0600, so the `-wal` and `-shm` files inherit the
//! mode), set to WAL with `synchronous = NORMAL`, and migrated to [`SCHEMA_VERSION`] in **one** `BEGIN IMMEDIATE`
//! transaction that re-reads the version under the write lock (another process may have migrated meanwhile). A file from a
//! newer core is refused and not altered. The migration texts are the TypeScript texts byte for byte, since SQLite keeps a
//! `CREATE` statement as written and `sqlite_master` of a file made here must equal one made there.
use super::{BudgetError, StoreErrorCode};
use plur1bus_store::rusqlite::Connection;
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use std::path::Path;
use std::time::Duration;

/// `BUDGET_SCHEMA_VERSION`.
pub const SCHEMA_VERSION: u32 = 2;

/// `MIGRATIONS`: entry `v - 1` takes the schema to version `v`; append only.
pub const MIGRATIONS: &[&str] = &[
    r#"
    CREATE TABLE usage_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
      cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
      price_version TEXT NOT NULL,
      request_id TEXT UNIQUE
    );
    CREATE INDEX usage_event_agent_ts ON usage_event (agent, ts);
    CREATE INDEX usage_event_ts ON usage_event (ts);
    CREATE TABLE budget_limit (
      scope TEXT NOT NULL CHECK (scope IN ('global', 'agent')),
      agent TEXT NOT NULL,
      period TEXT NOT NULL CHECK (period IN ('day', 'month')),
      metric TEXT NOT NULL CHECK (metric IN ('cost', 'tokens')),
      soft INTEGER CHECK (soft IS NULL OR soft >= 0),
      hard INTEGER CHECK (hard IS NULL OR hard >= 0),
      CHECK (soft IS NOT NULL OR hard IS NOT NULL),
      CHECK (soft IS NULL OR hard IS NULL OR soft <= hard),
      CHECK ((scope = 'global' AND agent = '') OR (scope = 'agent' AND agent <> '')),
      PRIMARY KEY (scope, agent, period, metric)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notice (
      kind TEXT NOT NULL CHECK (kind IN ('soft', 'hard')),
      scope TEXT NOT NULL,
      agent TEXT NOT NULL,
      period TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_key TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (kind, scope, agent, period, metric, period_key)
    );
  "#,
    r#"
    CREATE TABLE budget_limit_v2 (
      scope TEXT NOT NULL CHECK (scope IN ('global', 'agent')),
      agent TEXT NOT NULL,
      period TEXT NOT NULL CHECK (period IN ('day', 'month')),
      metric TEXT NOT NULL CHECK (metric IN ('cost', 'tokens', 'images', 'videoSeconds')),
      soft INTEGER CHECK (soft IS NULL OR soft >= 0),
      hard INTEGER CHECK (hard IS NULL OR hard >= 0),
      CHECK (soft IS NOT NULL OR hard IS NOT NULL),
      CHECK (soft IS NULL OR hard IS NULL OR soft <= hard),
      CHECK ((scope = 'global' AND agent = '') OR (scope = 'agent' AND agent <> '')),
      PRIMARY KEY (scope, agent, period, metric)
    );
    INSERT INTO budget_limit_v2 (scope, agent, period, metric, soft, hard) SELECT scope, agent, period, metric, soft, hard FROM budget_limit;
    DROP TABLE budget_limit;
    ALTER TABLE budget_limit_v2 RENAME TO budget_limit;
    ALTER TABLE usage_event ADD COLUMN images INTEGER NOT NULL DEFAULT 0 CHECK (images >= 0);
    ALTER TABLE usage_event ADD COLUMN video_seconds INTEGER NOT NULL DEFAULT 0 CHECK (video_seconds >= 0);
  "#,
];

/// What `openBudgetDb` takes besides the path.
#[derive(Default)]
pub struct OpenOptions<'a> {
    /// `busyTimeoutMs`; 5000 when `None`.
    pub busy_timeout_ms: Option<u64>,
    /// `securePath`: the platform's owner-only permissions on top of POSIX mode 0600 (a port; the host supplies it).
    pub secure_path: Option<&'a dyn Fn(&Path)>,
}

fn store_error(code: StoreErrorCode, message: String) -> BudgetError {
    BudgetError::Store { code, message }
}

/// Creates the directory (0700) and the file (0600) the way `openBudgetDb` does, before SQLite sees it.
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
        // Not POSIX or not ours to change: the open above already created the file private.
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    if let Some(secure) = o.secure_path {
        secure(path);
    }
    Ok(())
}

/// `openBudgetDb`: the opened, migrated store.
pub fn open(path: &Path, o: &OpenOptions<'_>) -> Result<Store, BudgetError> {
    prepare(path, o).map_err(|e| {
        store_error(
            StoreErrorCode::OpenFailed,
            format!("cannot prepare {}: {e}", path.display()),
        )
    })?;
    let owner = OwnerSpec {
        store: StoreSpec {
            synchronous: Synchronous::Normal,
            ..StoreSpec::new("budget", SCHEMA_VERSION)
        },
        journal: Journal::Wal,
        // The version is checked inside the one migration transaction below, as `migrate` does.
        schema: Schema::Unversioned,
        create: false,
    };
    let mut store = Store::open_owner(path, &owner).map_err(|e| {
        store_error(
            StoreErrorCode::OpenFailed,
            format!("cannot initialise {}: {e}", path.display()),
        )
    })?;
    if let Some(ms) = o.busy_timeout_ms {
        store
            .conn()
            .busy_timeout(Duration::from_millis(ms))
            .map_err(|e| {
                store_error(
                    StoreErrorCode::OpenFailed,
                    format!("cannot initialise {}: {e}", path.display()),
                )
            })?;
    }
    migrate(&mut store).map_err(|e| match e {
        BudgetError::Store { .. } => e,
        other => store_error(
            StoreErrorCode::OpenFailed,
            format!("cannot initialise {}: {other}", path.display()),
        ),
    })?;
    Ok(store)
}

fn user_version(conn: &Connection) -> Result<u32, BudgetError> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

fn migrate(store: &mut Store) -> Result<(), BudgetError> {
    if user_version(store.conn())? == SCHEMA_VERSION {
        return Ok(());
    }
    store.write_with(|tx| {
        // Re-read under the write lock: another process may have migrated meanwhile.
        let mut v = user_version(tx)?;
        if v > SCHEMA_VERSION {
            return Err(store_error(
                StoreErrorCode::NewerSchema,
                format!("budget store schema {v} is newer than this core's {SCHEMA_VERSION}"),
            ));
        }
        while v < SCHEMA_VERSION {
            v += 1;
            tx.execute_batch(MIGRATIONS[(v - 1) as usize])?;
            tx.execute_batch(&format!("PRAGMA user_version = {v}"))?;
        }
        Ok(())
    })
}
