//! SQLite persistence shared with the pinned Node engine (RE-02/T4).
//!
//! The three DDL strings are copied verbatim from engine commit `9f34008c`. Cache policy
//! and request coalescing belong to their consumers; this module owns the persisted rows.

use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    contract::StoreError,
    text::js::{js_to_lower_case, js_trim},
};

use super::paths::{assert_trusted_path, secure_dir};

/// Node's persistent embedding-cache schema, including its original whitespace.
pub const EMBEDDINGS_DDL: &str = r#"
        CREATE TABLE IF NOT EXISTS embeddings (
          key_hash TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          scope_id TEXT NOT NULL,
          cache_version TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          vector BLOB NOT NULL,
          debug_text TEXT,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_expires ON embeddings(expires_at);
        CREATE INDEX IF NOT EXISTS idx_embeddings_accessed ON embeddings(accessed_at);
      "#;

/// Node's persistent LLM-result-cache schema, including its original whitespace.
pub const LLM_RESULTS_DDL: &str = r#"
        CREATE TABLE IF NOT EXISTS llm_results (
          key_hash TEXT PRIMARY KEY,
          purpose TEXT NOT NULL,
          model TEXT NOT NULL,
          response_text TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          provider_cached_input_tokens INTEGER,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          byte_size INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_results_expires ON llm_results(expires_at);
        CREATE INDEX IF NOT EXISTS idx_llm_results_accessed ON llm_results(accessed_at);
      "#;

/// Node's speaker mapping schema; its camelCase column names are part of the format.
pub const SPEAKER_MAPPINGS_DDL: &str = r#"
    CREATE TABLE IF NOT EXISTS speaker_mappings (
      agentId TEXT NOT NULL,
      speakerLabel TEXT NOT NULL,
      speakerDisplayName TEXT NOT NULL,
      attributionSource TEXT NOT NULL,
      confidence REAL,
      confirmed INTEGER NOT NULL,
      proposedAt INTEGER NOT NULL,
      confirmedAt INTEGER,
      contextHint TEXT,
      PRIMARY KEY (agentId, speakerLabel)
    );
    CREATE INDEX IF NOT EXISTS idx_speaker_mappings_agent
      ON speaker_mappings(agentId);
  "#;

const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const CACHE_VERSION: &str = "v2";
const LLM_METADATA_BYTES: usize = 256;

enum VacuumPolicy {
    Incremental,
    EmptySchema,
    Unchanged,
}

fn sqlite_error(error: rusqlite::Error) -> StoreError {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => StoreError::Busy,
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => StoreError::Corrupt,
        Some(ErrorCode::CannotOpen) => StoreError::Unavailable,
        _ => StoreError::Io {
            kind: std::io::ErrorKind::Other,
        },
    }
}

fn now_ms() -> Result<i64, StoreError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::Corrupt)?;
    i64::try_from(duration.as_millis()).map_err(|_| StoreError::Corrupt)
}

fn open_connection(
    path: &Path,
    ddl: &str,
    vacuum: VacuumPolicy,
    secure_file: bool,
) -> Result<Mutex<Connection>, StoreError> {
    assert_trusted_path(path)?;
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        secure_dir(parent)?;
    }
    let connection = Connection::open(path).map_err(sqlite_error)?;
    // On Windows new files inherit the private ACL installed by secure_dir.
    #[cfg(unix)]
    if secure_file {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| StoreError::Io { kind: error.kind() })?;
    }
    #[cfg(not(unix))]
    let _ = secure_file;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(sqlite_error)?;
    let auto_vacuum = match vacuum {
        VacuumPolicy::Incremental => true,
        VacuumPolicy::EmptySchema => {
            connection
                .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(sqlite_error)?
                == 0
        }
        VacuumPolicy::Unchanged => false,
    };
    if auto_vacuum {
        let mode: i64 = connection
            .pragma_query_value(None, "auto_vacuum", |row| row.get(0))
            .map_err(sqlite_error)?;
        if mode != 2 {
            connection
                .execute_batch("PRAGMA auto_vacuum=INCREMENTAL; VACUUM;")
                .map_err(sqlite_error)?;
        }
    }
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(sqlite_error)?;
    connection.execute_batch(ddl).map_err(sqlite_error)?;
    Ok(Mutex::new(connection))
}

fn connection(handle: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>, StoreError> {
    handle.lock().map_err(|_| StoreError::Corrupt)
}

fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// All public, non-secret components of Node's v2 embedding-cache key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheKey {
    /// Embedding provider identifier.
    pub provider: String,
    /// Embedding model identifier.
    pub model: String,
    /// Width of the cached vector.
    pub dimensions: usize,
    /// Agent or explicitly shared cache scope.
    pub scope_id: String,
    /// Canonical vector identity hash, or `legacy` when Node has no identity.
    pub identity_hash: String,
    /// SHA-256 of the JS-trimmed, JS-lowercased input text.
    pub text_hash: String,
}

impl CacheKey {
    /// Build the exact v2 key; the input text itself is never retained.
    pub fn new(
        provider: &str,
        model: &str,
        dimensions: usize,
        scope_id: &str,
        identity_hash: &str,
        text: &str,
    ) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            dimensions,
            scope_id: scope_id.into(),
            identity_hash: identity_hash.into(),
            text_hash: sha256(&js_to_lower_case(js_trim(text))),
        }
    }

    /// SHA-256 of Node's NUL-separated key material, including the identity hash.
    pub fn key_hash(&self) -> String {
        sha256(&format!(
            "{}\0{}\0{}\0{}\0{CACHE_VERSION}\0{}\0{}",
            self.provider,
            self.model,
            self.dimensions,
            self.scope_id,
            self.identity_hash,
            self.text_hash
        ))
    }
}

/// A persisted vector and its absolute expiry in Unix milliseconds.
#[derive(Clone, Debug, PartialEq)]
pub struct CachedVector {
    /// The cached embedding.
    pub vector: Vec<f32>,
    /// Absolute expiry, with `expires_at <= now` considered expired.
    pub expires_at: i64,
}

/// The persistent tier of the Node engine's v2 embedding cache.
pub struct EmbeddingCache {
    db: Mutex<Connection>,
}

impl EmbeddingCache {
    /// Open or create a cache with the Node DDL, WAL and incremental vacuum settings.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Ok(Self {
            db: open_connection(path, EMBEDDINGS_DDL, VacuumPolicy::Incremental, false)?,
        })
    }

    /// Read a live entry, deleting expired entries and updating the access timestamp.
    pub fn get(&self, key: &CacheKey) -> Result<Option<CachedVector>, StoreError> {
        self.get_at(key, now_ms()?)
    }

    /// Read at an explicit Unix-millisecond timestamp supplied by the engine clock.
    pub fn get_at(&self, key: &CacheKey, now: i64) -> Result<Option<CachedVector>, StoreError> {
        let db = connection(&self.db)?;
        let hash = key.key_hash();
        let row = db
            .prepare_cached("SELECT vector, expires_at FROM embeddings WHERE key_hash = ?")
            .map_err(sqlite_error)?
            .query_row([&hash], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()
            .map_err(sqlite_error)?;
        let Some((bytes, expires_at)) = row else {
            return Ok(None);
        };
        if expires_at <= now {
            db.prepare_cached("DELETE FROM embeddings WHERE key_hash = ?")
                .map_err(sqlite_error)?
                .execute([&hash])
                .map_err(sqlite_error)?;
            return Ok(None);
        }
        let vector = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
        db.prepare_cached("UPDATE embeddings SET accessed_at = ? WHERE key_hash = ?")
            .map_err(sqlite_error)?
            .execute(params![now, hash])
            .map_err(sqlite_error)?;
        Ok(Some(CachedVector { vector, expires_at }))
    }

    /// Persist an embedding as Node's JSON-text BLOB with an absolute expiry.
    pub fn put(&self, key: &CacheKey, vector: &[f32], expires_at: i64) -> Result<(), StoreError> {
        self.put_at(key, vector, expires_at, now_ms()?)
    }

    /// Persist at an explicit creation/access timestamp supplied by the engine clock.
    pub fn put_at(
        &self,
        key: &CacheKey,
        vector: &[f32],
        expires_at: i64,
        now: i64,
    ) -> Result<(), StoreError> {
        if vector.len() != key.dimensions || vector.iter().any(|value| !value.is_finite()) {
            return Err(StoreError::Corrupt);
        }
        let bytes = serde_json::to_vec(vector).map_err(|_| StoreError::Corrupt)?;
        connection(&self.db)?.prepare_cached(
            "INSERT INTO embeddings (key_hash, provider, model, dimensions, scope_id, cache_version, text_hash,
             vector, debug_text, created_at, accessed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
             ON CONFLICT(key_hash) DO UPDATE SET provider=excluded.provider, model=excluded.model,
             dimensions=excluded.dimensions, scope_id=excluded.scope_id, cache_version=excluded.cache_version,
             vector=excluded.vector, text_hash=excluded.text_hash, debug_text=excluded.debug_text,
             created_at=excluded.created_at, accessed_at=excluded.accessed_at, expires_at=excluded.expires_at"
        ).map_err(sqlite_error)?.execute(params![key.key_hash(), key.provider, key.model,
            i64::try_from(key.dimensions).map_err(|_| StoreError::Corrupt)?, key.scope_id, CACHE_VERSION,
            key.text_hash, bytes, now, now, expires_at]).map_err(sqlite_error)?;
        Ok(())
    }

    /// Delete only entries whose absolute expiry is at or before `now`.
    pub fn sweep_expired(&self, now: i64) -> Result<usize, StoreError> {
        connection(&self.db)?
            .prepare_cached("DELETE FROM embeddings WHERE expires_at <= ?")
            .map_err(sqlite_error)?
            .execute([now])
            .map_err(sqlite_error)
    }
}

/// A precomputed exact-request hash and the LLM columns stored beside it.
/// Request serialization and purpose policy are owned by the LLM cache consumer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LlmResultKey {
    /// SHA-256 of the Node exact-request key material.
    pub key_hash: String,
    /// Cacheable purpose, such as `capture-summary`.
    pub purpose: String,
    /// Model used to compute the result.
    pub model: String,
}

/// The nullable result and usage fields preserved by Node's SQLite tier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedLlmResult {
    /// Provider response text, including SQL NULL when present in a legacy row.
    pub text: Option<String>,
    /// Provider-reported input tokens.
    pub input_tokens: Option<i64>,
    /// Provider-reported output tokens.
    pub output_tokens: Option<i64>,
    /// Provider-reported cached input tokens.
    pub provider_cached_input_tokens: Option<i64>,
    /// Absolute expiry in Unix milliseconds.
    pub expires_at: i64,
}

/// The persistent tier of the exact LLM-result cache.
pub struct LlmResultCache {
    db: Mutex<Connection>,
}

impl LlmResultCache {
    /// Open or create the Node schema with a private file and WAL journaling.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Ok(Self {
            db: open_connection(path, LLM_RESULTS_DDL, VacuumPolicy::EmptySchema, true)?,
        })
    }

    /// Read a live result and refresh its access timestamp.
    pub fn get(&self, key: &LlmResultKey) -> Result<Option<CachedLlmResult>, StoreError> {
        self.get_at(key, now_ms()?)
    }

    /// Read at an explicit timestamp, deleting a matching expired entry as Node does.
    pub fn get_at(
        &self,
        key: &LlmResultKey,
        now: i64,
    ) -> Result<Option<CachedLlmResult>, StoreError> {
        let db = connection(&self.db)?;
        let row = db
            .prepare_cached(
                "SELECT response_text, input_tokens, output_tokens,
            provider_cached_input_tokens, expires_at FROM llm_results WHERE key_hash = ?",
            )
            .map_err(sqlite_error)?
            .query_row([&key.key_hash], |row| {
                Ok(CachedLlmResult {
                    text: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    provider_cached_input_tokens: row.get(3)?,
                    expires_at: row.get(4)?,
                })
            })
            .optional()
            .map_err(sqlite_error)?;
        let Some(result) = row else { return Ok(None) };
        if result.expires_at <= now {
            db.prepare_cached("DELETE FROM llm_results WHERE key_hash = ?")
                .map_err(sqlite_error)?
                .execute([&key.key_hash])
                .map_err(sqlite_error)?;
            return Ok(None);
        }
        db.prepare_cached("UPDATE llm_results SET accessed_at = ? WHERE key_hash = ?")
            .map_err(sqlite_error)?
            .execute(params![now, key.key_hash])
            .map_err(sqlite_error)?;
        Ok(Some(result))
    }

    /// Persist result text, usage and its absolute expiry.
    pub fn put(&self, key: &LlmResultKey, value: &CachedLlmResult) -> Result<(), StoreError> {
        self.put_at(key, value, now_ms()?)
    }

    /// Persist with the creation/access timestamp supplied by the engine clock.
    pub fn put_at(
        &self,
        key: &LlmResultKey,
        value: &CachedLlmResult,
        now: i64,
    ) -> Result<(), StoreError> {
        let byte_size = value
            .text
            .as_deref()
            .map_or(0, str::len)
            .checked_add(LLM_METADATA_BYTES)
            .and_then(|bytes| i64::try_from(bytes).ok())
            .ok_or(StoreError::Corrupt)?;
        connection(&self.db)?.prepare_cached(
            "INSERT INTO llm_results (key_hash, purpose, model, response_text, input_tokens, output_tokens,
             provider_cached_input_tokens, created_at, accessed_at, expires_at, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(key_hash) DO UPDATE SET purpose=excluded.purpose, model=excluded.model,
             response_text=excluded.response_text, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
             provider_cached_input_tokens=excluded.provider_cached_input_tokens, created_at=excluded.created_at,
             accessed_at=excluded.accessed_at, expires_at=excluded.expires_at, byte_size=excluded.byte_size"
        ).map_err(sqlite_error)?.execute(params![key.key_hash, key.purpose, key.model, value.text,
            value.input_tokens, value.output_tokens, value.provider_cached_input_tokens, now, now,
            value.expires_at, byte_size]).map_err(sqlite_error)?;
        Ok(())
    }

    /// Delete only rows whose absolute expiry is at or before `now`.
    pub fn sweep_expired(&self, now: i64) -> Result<usize, StoreError> {
        connection(&self.db)?
            .prepare_cached("DELETE FROM llm_results WHERE expires_at <= ?")
            .map_err(sqlite_error)?
            .execute([now])
            .map_err(sqlite_error)
    }
}

/// A speaker mapping in the legacy camelCase SQLite/Node shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMapping {
    /// Agent owning the mapping.
    pub agent_id: String,
    /// Diarization speaker label.
    pub speaker_label: String,
    /// Human-readable speaker name.
    pub speaker_display_name: String,
    /// Attribution source, such as `manual` or `contextual_proposal`.
    pub attribution_source: String,
    /// Optional confidence retained without clamping.
    pub confidence: Option<f64>,
    /// Node's integer confirmation flag.
    pub confirmed: i64,
    /// Proposal timestamp in Unix milliseconds.
    pub proposed_at: i64,
    /// Confirmation timestamp in Unix milliseconds.
    pub confirmed_at: Option<i64>,
    /// Optional attribution context.
    pub context_hint: Option<String>,
}

/// The shared speaker mapping table.
pub struct SpeakerMappings {
    db: Mutex<Connection>,
}

impl SpeakerMappings {
    /// Open or create the Node speaker-mapping schema without adding external tables.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Ok(Self {
            db: open_connection(path, SPEAKER_MAPPINGS_DDL, VacuumPolicy::Unchanged, false)?,
        })
    }

    /// List one agent's mappings, newest proposal first as in Node.
    pub fn list(&self, agent: &str) -> Result<Vec<SpeakerMapping>, StoreError> {
        let db = connection(&self.db)?;
        let mut statement = db
            .prepare_cached(
                "SELECT agentId, speakerLabel, speakerDisplayName,
            attributionSource, confidence, confirmed, proposedAt, confirmedAt, contextHint
            FROM speaker_mappings WHERE agentId = ? ORDER BY proposedAt DESC",
            )
            .map_err(sqlite_error)?;
        let rows = statement
            .query_map([agent], |row| {
                Ok(SpeakerMapping {
                    agent_id: row.get(0)?,
                    speaker_label: row.get(1)?,
                    speaker_display_name: row.get(2)?,
                    attribution_source: row.get(3)?,
                    confidence: row.get(4)?,
                    confirmed: row.get(5)?,
                    proposed_at: row.get(6)?,
                    confirmed_at: row.get(7)?,
                    context_hint: row.get(8)?,
                })
            })
            .map_err(sqlite_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
    }

    /// Insert or replace the mutable mapping fields using Node's composite primary key.
    pub fn upsert(&self, mapping: &SpeakerMapping) -> Result<(), StoreError> {
        connection(&self.db)?.prepare_cached("INSERT INTO speaker_mappings (agentId, speakerLabel,
            speakerDisplayName, attributionSource, confidence, confirmed, proposedAt, confirmedAt, contextHint)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agentId, speakerLabel) DO UPDATE SET
            speakerDisplayName=excluded.speakerDisplayName, attributionSource=excluded.attributionSource,
            confidence=excluded.confidence, confirmed=excluded.confirmed, proposedAt=excluded.proposedAt,
            confirmedAt=excluded.confirmedAt, contextHint=excluded.contextHint").map_err(sqlite_error)?
            .execute(params![mapping.agent_id, mapping.speaker_label, mapping.speaker_display_name,
                mapping.attribution_source, mapping.confidence, mapping.confirmed, mapping.proposed_at,
                mapping.confirmed_at, mapping.context_hint]).map_err(sqlite_error)?;
        Ok(())
    }

    /// Confirm an unconfirmed proposal; absent or already confirmed mappings return false.
    pub fn confirm(&self, agent: &str, label: &str, now: i64) -> Result<bool, StoreError> {
        Ok(connection(&self.db)?
            .prepare_cached(
                "UPDATE speaker_mappings SET confirmed = 1,
            confirmedAt = ? WHERE agentId = ? AND speakerLabel = ? AND confirmed = 0",
            )
            .map_err(sqlite_error)?
            .execute(params![now, agent, label])
            .map_err(sqlite_error)?
            > 0)
    }
}
