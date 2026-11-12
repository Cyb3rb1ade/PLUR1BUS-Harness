//! Actual A1 per-agent SQLite counters. Query text is only passed to HMAC, never SQLite.
use super::{
    directory::{regular_file_identity, TrustedDirectory},
    paths,
};
use crate::contract::{Cancel, EngineError, StoreError};
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::Sha256;
use std::{
    collections::HashSet,
    fs::File,
    path::{Path, PathBuf},
    time::Duration,
};
const MAX_SAFE: i64 = 9_007_199_254_740_991;
const MAX_IDS: usize = 500;
const MAX_ROWS: usize = 50_000;
const MAX_DB: u64 = 64 * 1024 * 1024;
const DDL:&str="CREATE TABLE IF NOT EXISTS stats (id TEXT PRIMARY KEY, recalls INTEGER NOT NULL DEFAULT 0, lastRecalledAt INTEGER);
CREATE TABLE IF NOT EXISTS queries (id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(id, digest));
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
/// Counters only. This low-level value carries no authorization to disclose a memory's existence.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallCounter {
    /// Case-preserved original UUID.
    pub id: String,
    /// Successful returned-card occurrences, not merely candidate matches.
    pub recalls: i64,
    /// Exact distinct queries represented by keyed digests.
    pub distinct_queries: i64,
    /// Highest observed time, or the legacy null value.
    pub last_recalled_at: Option<i64>,
}
/// Held physical base. Each operation uses a separate SQLite transaction/connection like A1.
/// The caller must supply only rendered, authorized living cards and exclude warm/degraded recalls.
pub struct RecallStats {
    base: TrustedDirectory,
}
fn safe_agent(agent: &str) -> Result<(), StoreError> {
    if agent.is_empty()
        || agent.len() > 64
        || !agent
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
fn safe_id(id: &str) -> Result<(), StoreError> {
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
fn unique(ids: &[String]) -> Result<Vec<&str>, StoreError> {
    if ids.len() > MAX_IDS {
        return Err(StoreError::InvalidInput);
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for id in ids {
        safe_id(id)?;
        if seen.insert(id.as_str()) {
            result.push(id.as_str());
        }
    }
    Ok(result)
}
struct DatabaseFile {
    directory: TrustedDirectory,
    name: String,
    file: File,
    identity: (u64, u64),
}
impl DatabaseFile {
    fn open(base: &TrustedDirectory, agent: &str) -> Result<Self, StoreError> {
        base.assert_unchanged()?;
        let directory = base.create_child("_recall-stats")?;
        paths::secure_dir(directory.path())?;
        let name = format!("{agent}.sqlite");
        let file = match directory.open_file(&name) {
            Ok(file) => file,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => match directory.create_file(&name) {
                Ok(file) => file,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::AlreadyExists,
                }) => directory.open_file(&name)?,
                Err(error) => return Err(error),
            },
            Err(error) => return Err(error),
        };
        let identity = regular_file_identity(&file)?;
        let this = Self {
            directory,
            name,
            file,
            identity,
        };
        this.check()?;
        paths::secure_file(&this.path())?;
        this.check()?;
        Ok(this)
    }
    fn path(&self) -> PathBuf {
        self.directory.path().join(&self.name)
    }
    fn check(&self) -> Result<(), StoreError> {
        self.directory.assert_unchanged()?;
        if regular_file_identity(&self.file)? != self.identity
            || regular_file_identity(&self.directory.open_file(&self.name)?)? != self.identity
        {
            return Err(StoreError::UntrustedPath);
        }
        if self.file.metadata()?.len() > MAX_DB {
            return Err(StoreError::Unavailable);
        }
        // SQLite may create/remove its own journal; any existing sidecar must be an ordinary owned leaf.
        for suffix in ["-journal", "-wal", "-shm"] {
            match self.directory.open_file(&format!("{}{suffix}", self.name)) {
                Ok(file) => {
                    // SQLite can unlink its journal between openat and fstat. A detached leaf
                    // has zero links and no external target; multiple links remain forbidden.
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        if file.metadata()?.nlink() > 1 {
                            return Err(StoreError::UntrustedPath);
                        }
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::io::AsRawHandle;
                        use windows_sys::Win32::Storage::FileSystem::{
                            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
                        };
                        // SAFETY: the POD is output-only; File retains the valid handle.
                        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
                        // SAFETY: both the live handle and writable output pointer are valid.
                        if unsafe {
                            GetFileInformationByHandle(file.as_raw_handle() as _, &mut info)
                        } == 0
                        {
                            return Err(std::io::Error::last_os_error().into());
                        }
                        if info.nNumberOfLinks > 1 {
                            return Err(StoreError::UntrustedPath);
                        }
                    }
                    if file.metadata()?.len() > MAX_DB {
                        return Err(StoreError::Unavailable);
                    }
                }
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => (),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}
impl RecallStats {
    /// Hold an existing trusted base without creating a database, loading models or writing queries.
    pub fn new(base: &Path) -> Result<Self, StoreError> {
        Ok(Self {
            base: TrustedDirectory::open(base)?,
        })
    }
    /// Resolve this agent's private sidecar path, with no creation.
    pub fn path(&self, agent: &str) -> Result<PathBuf, StoreError> {
        safe_agent(agent)?;
        self.base.assert_unchanged()?;
        Ok(self
            .base
            .path()
            .join("_recall-stats")
            .join(format!("{agent}.sqlite")))
    }
    fn with_db<T>(
        &self,
        agent: &str,
        cancel: &Cancel,
        run: impl FnOnce(&Transaction<'_>) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        safe_agent(agent)?;
        cancel.check()?;
        self.base.assert_unchanged()?;
        let file = DatabaseFile::open(&self.base, agent)?;
        let mut db = Connection::open_with_flags(
            file.path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(StoreError::from)?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(StoreError::from)?;
        file.check()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::from)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(StoreError::from)?;
        if !(0..=1).contains(&version) {
            return Err(StoreError::Corrupt.into());
        }
        tx.execute_batch(DDL).map_err(StoreError::from)?;
        let triggers: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('trigger','view')",
                [],
                |r| r.get(0),
            )
            .map_err(StoreError::from)?;
        if triggers != 0 {
            return Err(StoreError::Corrupt.into());
        }
        let stored: Option<String> = tx
            .query_row(
                "SELECT value FROM metadata WHERE key='query-hmac-key'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(StoreError::from)?;
        if let Some(key) = stored {
            if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(StoreError::Corrupt.into());
            }
        } else {
            let has_queries: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM queries)", [], |row| row.get(0))
                .map_err(StoreError::from)?;
            if has_queries {
                // A replacement key would count old exact queries as new; never hide lost history.
                return Err(StoreError::Corrupt.into());
            }
            let mut entropy = [0u8; 32];
            getrandom::fill(&mut entropy).map_err(|_| StoreError::Unavailable)?;
            use std::fmt::Write;
            let mut key = String::with_capacity(64);
            for byte in entropy {
                write!(&mut key, "{byte:02x}").map_err(|_| StoreError::Corrupt)?;
            }
            tx.execute("INSERT INTO metadata VALUES ('query-hmac-key',?)", [key])
                .map_err(StoreError::from)?;
        }
        tx.pragma_update(None, "user_version", 1)
            .map_err(StoreError::from)?;
        cancel.check()?;
        self.base.assert_unchanged()?;
        file.check()?;
        let result = run(&tx)?;
        cancel.check()?;
        self.base.assert_unchanged()?;
        file.check()?;
        tx.commit().map_err(StoreError::from)?;
        file.check()?;
        self.base.assert_unchanged()?;
        Ok(result)
    }
    /// Count each unique admitted ID once; exact query equality is represented only by HMAC-SHA256.
    /// Empty IDs are a no-op and do not create a database. Mutation is transactional and cancellable.
    pub fn record(
        &self,
        agent: &str,
        ids: &[String],
        query: &str,
        now: f64,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        safe_agent(agent)?;
        let ids = unique(ids)?;
        if ids.is_empty() {
            return Ok(());
        }
        if query.encode_utf16().count() > 1_000_000
            || query.is_empty()
            || !now.is_finite()
            || now.fract() != 0.0
            || now < 0.0
            || now > MAX_SAFE as f64
        {
            return Err(StoreError::InvalidInput.into());
        }
        self.with_db(agent,cancel,|tx|{
            let key:String=tx.query_row("SELECT value FROM metadata WHERE key='query-hmac-key'",[],|r|r.get(0)).map_err(StoreError::from)?;
            // Node passes the persisted hex string directly to createHmac: these are ASCII bytes.
            let mut mac=Hmac::<Sha256>::new_from_slice(key.as_bytes()).map_err(|_|StoreError::Corrupt)?;
            mac.update(query.as_bytes());
            let digest=format!("{:x}",mac.finalize().into_bytes());
            for id in ids{
                cancel.check()?;
                let old:Option<i64>=tx.query_row("SELECT recalls FROM stats WHERE id=?",[id],|r|r.get(0)).optional().map_err(StoreError::from)?;
                if old.is_some_and(|v|!(0..MAX_SAFE).contains(&v)){return Err(StoreError::Corrupt.into());}
                tx.execute("INSERT INTO stats VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET recalls=recalls+1,lastRecalledAt=MAX(lastRecalledAt,excluded.lastRecalledAt)",params![id,now as i64]).map_err(StoreError::from)?;
                tx.execute("INSERT OR IGNORE INTO queries VALUES (?,?)",params![id,digest]).map_err(StoreError::from)?;
            }
            Ok(())
        })
    }
    /// Read counters for requested IDs (maximum 500), or all persisted IDs within the native bound.
    /// Missing IDs return zeros. This method never substitutes for the caller's current card ACL.
    pub fn read(
        &self,
        agent: &str,
        ids: Option<&[String]>,
        cancel: &Cancel,
    ) -> Result<Vec<RecallCounter>, EngineError> {
        cancel.check()?;
        let requested = ids.map(unique).transpose()?;
        self.with_db(agent, cancel, |tx| {
            let ids = if let Some(ids) = requested {
                ids.into_iter().map(str::to_owned).collect()
            } else {
                let mut statement = tx
                    .prepare("SELECT id FROM stats ORDER BY id LIMIT 50001")
                    .map_err(StoreError::from)?;
                let rows = statement
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(StoreError::from)?;
                let mut ids = Vec::new();
                for row in rows {
                    cancel.check()?;
                    if ids.len() == MAX_ROWS {
                        return Err(StoreError::Unavailable.into());
                    }
                    ids.push(row.map_err(StoreError::from)?);
                }
                ids
            };
            let mut result = Vec::with_capacity(ids.len());
            for id in ids {
                cancel.check()?;
                safe_id(&id)?;
                let row: Option<(i64, Option<i64>)> = tx
                    .query_row(
                        "SELECT recalls,lastRecalledAt FROM stats WHERE id=?",
                        [&id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(StoreError::from)?;
                let (recalls, last_recalled_at) = row.unwrap_or((0, None));
                let distinct_queries: i64 = tx
                    .query_row("SELECT COUNT(*) FROM queries WHERE id=?", [&id], |r| {
                        r.get(0)
                    })
                    .map_err(StoreError::from)?;
                if !(0..=MAX_SAFE).contains(&recalls)
                    || !(0..=MAX_SAFE).contains(&distinct_queries)
                    || last_recalled_at.is_some_and(|v| !(0..=MAX_SAFE).contains(&v))
                {
                    return Err(StoreError::Corrupt.into());
                }
                result.push(RecallCounter {
                    id,
                    recalls,
                    distinct_queries,
                    last_recalled_at,
                });
            }
            Ok(result)
        })
    }
}
