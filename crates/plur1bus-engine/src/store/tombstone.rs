//! Node-compatible tombstone registry persistence and the shared pre-write guard (RE-02).

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use sha2::{Digest, Sha256};

use crate::{
    contract::{MemoryRow, StoreError},
    text::{
        js,
        json::{parse_json, write_json, TolerantJsonValue},
    },
};

use super::{
    lock::{Lock, LockGuard},
    paths::{assert_trusted_path, secure_dir},
    row::RowPatch,
};

/// Persisted registry schema version; unknown versions remain corrupt, never silently migrated.
pub const TOMBSTONE_SCHEMA_VERSION: u32 = 1;
const LOCK_STALE: Duration = Duration::from_secs(10);
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_RETRY: Duration = Duration::from_millis(25);
const REGISTRY_CACHE_CAPACITY: usize = 50;

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::from(error)
}

fn property<'a>(value: &'a TolerantJsonValue, key: &str) -> Option<&'a TolerantJsonValue> {
    let TolerantJsonValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(name, _)| name.to_utf8_lossy() == key)
        .map(|(_, value)| value)
}

fn string(value: &TolerantJsonValue, key: &str) -> Option<String> {
    let TolerantJsonValue::String(value) = property(value, key)? else {
        return None;
    };
    Some(value.to_utf8_lossy())
}

fn value_or(value: &TolerantJsonValue, key: &str, fallback: &str) -> String {
    string(value, key)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn safe_agent(agent: &str) -> bool {
    (1..=64).contains(&agent.len())
        && agent
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// Node's conservative NFKC/lowercase/ECMAScript-whitespace normalization.
pub fn normalize_content_for_fingerprint(text: &str) -> String {
    js::js_to_lower_case(&js::nfkc(text))
        .split(js::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// SHA-256 of the exact normalized text, retaining no plaintext in the registry.
pub fn content_fingerprint(text: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(normalize_content_for_fingerprint(text).as_bytes())
    )
}

/// Validate Node's schema, principal and registry-agent binding while retaining unknown fields.
pub fn is_valid_tombstone(value: &TolerantJsonValue, expected_agent: Option<&str>) -> bool {
    let version = match property(value, "schemaVersion") {
        Some(TolerantJsonValue::Number(value)) => value.parse::<f64>().ok(),
        _ => None,
    };
    if version != Some(f64::from(TOMBSTONE_SCHEMA_VERSION)) {
        return false;
    }
    if !string(value, "memoryId").is_some_and(|id| uuid(&id)) {
        return false;
    }
    let Some(agent) = string(value, "agentId").filter(|agent| safe_agent(agent)) else {
        return false;
    };
    if expected_agent.is_some_and(|expected| expected != agent) {
        return false;
    }
    let Some(scope) = string(value, "scope") else {
        return false;
    };
    match scope.as_str() {
        "agent-private" => {}
        "workspace"
            if ["workspaceId", "workspaceKey"].iter().any(|key| {
                string(value, key).is_some_and(|value| !js::js_trim(&value).is_empty())
            }) => {}
        "user"
            if string(value, "ownerUserId")
                .is_some_and(|value| !js::js_trim(&value).is_empty()) => {}
        _ => return false,
    }
    if !string(value, "status")
        .is_some_and(|status| matches!(status.as_str(), "attempted" | "committed" | "failed"))
    {
        return false;
    }
    string(value, "contentFingerprint")
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// Scope principals used to determine whether a committed fingerprint blocks a write.
#[derive(Clone, Copy)]
pub struct TombstoneContext<'a> {
    /// Owning agent; tombstones are always agent-bound.
    pub agent_id: &'a str,
    /// Scope type, defaulting to agent-private when empty.
    pub scope: &'a str,
    /// Resolved workspace id/key.
    pub workspace_identity: &'a str,
    /// Resolved user principal.
    pub owner_user_id: &'a str,
}

/// Apply Node's scope/owner/workspace matching; committed filtering belongs to the lookup.
pub fn tombstone_blocks_capture(value: &TolerantJsonValue, context: TombstoneContext<'_>) -> bool {
    if string(value, "status").as_deref() == Some("failed")
        || value_or(value, "agentId", "") != context.agent_id
    {
        return false;
    }
    let scope = value_or(value, "scope", "agent-private");
    let context_scope = if context.scope.is_empty() {
        "agent-private"
    } else {
        context.scope
    };
    match scope.as_str() {
        "agent-private" => context_scope == "agent-private",
        "workspace" => {
            let workspace = value_or(value, "workspaceId", &value_or(value, "workspaceKey", ""));
            context_scope == "workspace"
                && !workspace.is_empty()
                && workspace == context.workspace_identity
        }
        "user" => {
            let owner = value_or(value, "ownerUserId", "");
            context_scope == "user" && !owner.is_empty() && owner == context.owner_user_id
        }
        _ => true,
    }
}

/// A classified snapshot, distinguishing semantic corruption from a final torn append.
#[derive(Clone)]
pub struct RegistryRead {
    /// Valid rows in append order, including attempted and failed rows.
    pub tombstones: Vec<TolerantJsonValue>,
    /// Total corrupt rows, including a torn tail when repair was explicitly disabled.
    pub corrupt_lines: usize,
    /// JSON syntax failures outside a repairable final tail.
    pub unparseable: usize,
    /// Complete JSON rows that fail schema, principal or agent validation.
    pub invalid: usize,
    /// A final incomplete/nonparseable row was retained because repair was disabled.
    pub torn_tail: bool,
}

#[derive(Clone)]
struct Classified {
    rows: RegistryRead,
    tail: Option<(String, usize)>,
}

struct CacheEntry {
    file: PathBuf,
    agent: String,
    modified: SystemTime,
    size: u64,
    classified: Classified,
}

fn registry_cache() -> &'static Mutex<Vec<CacheEntry>> {
    static CACHE: OnceLock<Mutex<Vec<CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn classify(text: &str, agent: &str) -> Classified {
    let ends_with_newline = text.ends_with('\n');
    let mut lines = text.split('\n').collect::<Vec<_>>();
    if ends_with_newline {
        lines.pop();
    }
    let mut result = Classified {
        rows: RegistryRead {
            tombstones: Vec::new(),
            corrupt_lines: 0,
            unparseable: 0,
            invalid: 0,
            torn_tail: false,
        },
        tail: None,
    };
    for (index, line) in lines.iter().enumerate() {
        if js::js_trim(line).is_empty() {
            continue;
        }
        match parse_json(line) {
            Ok(row) if is_valid_tombstone(&row, Some(agent)) => result.rows.tombstones.push(row),
            Ok(_) => {
                result.rows.corrupt_lines += 1;
                result.rows.invalid += 1;
            }
            Err(_)
                if index + 1 == lines.len()
                    && !ends_with_newline
                    && result.rows.corrupt_lines == 0 =>
            {
                result.tail = Some(((*line).to_owned(), text.len() - line.len()));
            }
            Err(_) => {
                result.rows.corrupt_lines += 1;
                result.rows.unparseable += 1;
            }
        }
    }
    result
}

/// One agent's append-only registry, beside the LanceDB base directory.
pub struct TombstoneRegistry {
    file: PathBuf,
    agent: String,
}

impl TombstoneRegistry {
    /// Resolve `<parent(base)>/_tombstones/<agent>.jsonl` without creating anything.
    pub fn new(base: &Path, agent: &str) -> Result<Self, StoreError> {
        if !safe_agent(agent) {
            return Err(StoreError::InvalidInput);
        }
        let file = base
            .parent()
            .unwrap_or(Path::new("."))
            .join("_tombstones")
            .join(format!("{agent}.jsonl"));
        assert_trusted_path(&file)?;
        Ok(Self {
            file,
            agent: agent.to_owned(),
        })
    }

    /// The exact Node registry path.
    pub fn path(&self) -> &Path {
        &self.file
    }

    fn classify_file_uncached(&self) -> Result<Classified, StoreError> {
        assert_trusted_path(&self.file)?;
        match fs::read(&self.file) {
            Ok(bytes) => Ok(classify(&String::from_utf8_lossy(&bytes), &self.agent)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(classify("", &self.agent))
            }
            Err(error) => Err(io_error(error)),
        }
    }

    fn classify_file(&self) -> Result<Classified, StoreError> {
        assert_trusted_path(&self.file)?;
        let metadata = match fs::metadata(&self.file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(classify("", &self.agent))
            }
            Err(error) => return Err(io_error(error)),
        };
        let modified = metadata.modified().map_err(io_error)?;
        let size = metadata.len();
        {
            let mut cache = registry_cache().lock().map_err(|_| StoreError::Corrupt)?;
            if let Some(index) = cache
                .iter()
                .position(|entry| entry.file == self.file && entry.agent == self.agent)
            {
                let entry = cache.remove(index);
                if entry.modified == modified && entry.size == size {
                    let classified = entry.classified.clone();
                    cache.push(entry);
                    return Ok(classified);
                }
            }
        }
        let classified = self.classify_file_uncached()?;
        let mut cache = registry_cache().lock().map_err(|_| StoreError::Corrupt)?;
        cache.retain(|entry| entry.file != self.file);
        if cache.len() >= REGISTRY_CACHE_CAPACITY {
            cache.remove(0);
        }
        cache.push(CacheEntry {
            file: self.file.clone(),
            agent: self.agent.clone(),
            modified,
            size,
            classified: classified.clone(),
        });
        Ok(classified)
    }

    fn acquire(&self) -> Result<LockGuard, StoreError> {
        let path = self.file.with_extension("jsonl.lock");
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            if let Some(guard) = Lock::try_acquire(&path, LOCK_STALE, None)? {
                return Ok(guard);
            }
            if Instant::now() >= deadline {
                return Err(StoreError::Busy);
            }
            std::thread::sleep(LOCK_RETRY);
        }
    }

    fn repair_locked(&self) -> Result<(), StoreError> {
        let Some((fragment, valid_length)) = self.classify_file_uncached()?.tail else {
            return Ok(());
        };
        let quarantine = self.file.with_extension("corrupt.log");
        assert_trusted_path(&quarantine)?;
        let mut output = OpenOptions::new()
            .append(true)
            .create(true)
            .open(quarantine)
            .map_err(io_error)?;
        output
            .write_all(format!("{fragment}\n").as_bytes())
            .map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        drop(output);
        OpenOptions::new()
            .write(true)
            .open(&self.file)
            .map_err(io_error)?
            .set_len(valid_length as u64)
            .map_err(io_error)
    }

    /// Read valid rows; repair only a final nonparseable non-newline tail, under the shared lock.
    /// Other corrupt lines are retained and counted, never skipped as an empty registry.
    pub fn read(&self, repair_torn_tail: bool) -> Result<RegistryRead, StoreError> {
        let mut classified = self.classify_file()?;
        if classified.tail.is_none() {
            return Ok(classified.rows);
        }
        if !repair_torn_tail {
            classified.rows.corrupt_lines += 1;
            classified.rows.torn_tail = true;
            return Ok(classified.rows);
        }
        let _guard = self.acquire()?;
        self.repair_locked()?;
        let repaired = self.classify_file()?;
        if repaired.tail.is_some() {
            return Err(StoreError::Corrupt);
        }
        Ok(repaired.rows)
    }

    /// Append Node's compact JSON plus newline, repairing a preceding torn tail first.
    /// The registry inode stays in place, preserving any cooperating O_APPEND descriptor.
    pub fn append(&self, tombstone: &TolerantJsonValue) -> Result<PathBuf, StoreError> {
        if let Some(parent) = self.file.parent() {
            secure_dir(parent)?;
        }
        assert_trusted_path(&self.file)?;
        let _guard = self.acquire()?;
        self.repair_locked()?;
        let mut output = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.file)
            .map_err(io_error)?;
        output
            .write_all(format!("{}\n", write_json(tombstone)).as_bytes())
            .map_err(io_error)?;
        Ok(self.file.clone())
    }

    fn valid_rows(&self, repair: bool) -> Result<Vec<TolerantJsonValue>, StoreError> {
        let result = self.read(repair)?;
        if result.corrupt_lines > 0 {
            return Err(StoreError::Corrupt);
        }
        Ok(result.tombstones)
    }

    /// The latest committed canonical-origin or memory-id match, as in Node.
    pub fn find_by_origin(
        &self,
        origin: &str,
        repair: bool,
    ) -> Result<Option<TolerantJsonValue>, StoreError> {
        Ok(self.valid_rows(repair)?.into_iter().rev().find(|row| {
            string(row, "status").as_deref() == Some("committed")
                && (string(row, "canonicalOriginId").as_deref() == Some(origin)
                    || string(row, "memoryId").as_deref() == Some(origin))
        }))
    }

    /// The latest committed exact fingerprint match.
    pub fn find_by_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<Option<TolerantJsonValue>, StoreError> {
        Ok(self.valid_rows(true)?.into_iter().rev().find(|row| {
            string(row, "status").as_deref() == Some("committed")
                && string(row, "contentFingerprint").as_deref() == Some(fingerprint)
        }))
    }

    /// Find every committed fingerprint in its principal context; an unrelated newer scope cannot hide one.
    pub fn find_blocking(
        &self,
        text: &str,
        context: TombstoneContext<'_>,
    ) -> Result<Option<TolerantJsonValue>, StoreError> {
        if text.is_empty() {
            return Ok(None);
        }
        let fingerprint = content_fingerprint(text);
        Ok(self.valid_rows(true)?.into_iter().find(|row| {
            string(row, "status").as_deref() == Some("committed")
                && string(row, "contentFingerprint").as_deref() == Some(fingerprint.as_str())
                && tombstone_blocks_capture(row, context)
        }))
    }
}

fn assert_write(base: &Path, row: &MemoryRow, text: &str) -> Result<(), StoreError> {
    if text.is_empty() {
        return Ok(());
    }
    let agent = if row.agent_id.is_empty() {
        &row.stored_by
    } else {
        &row.agent_id
    };
    let context = TombstoneContext {
        agent_id: agent,
        scope: &row.scope,
        workspace_identity: if row.workspace_id.is_empty() {
            &row.workspace_key
        } else {
            &row.workspace_id
        },
        owner_user_id: &row.owner_user_id,
    };
    let registry = TombstoneRegistry::new(base, agent).map_err(|_| StoreError::TombstoneBlocked)?;
    match registry.find_blocking(text, context) {
        Ok(None) => Ok(()),
        _ => Err(StoreError::TombstoneBlocked),
    }
}

/// Guard a new card by content fingerprint and its exact agent/scope principals.
/// Registry corruption and read failures conservatively block the write.
pub fn assert_card_write_allowed(base: &Path, row: &MemoryRow) -> Result<(), StoreError> {
    assert_write(
        base,
        row,
        if row.text.is_empty() {
            &row.summary
        } else {
            &row.text
        },
    )
}

/// Whether a patch changes either recallable-content field, exactly as Node's helper.
pub fn is_content_changing_update(existing: &MemoryRow, patch: &RowPatch) -> bool {
    patch
        .text
        .as_ref()
        .is_some_and(|text| text != &existing.text)
        || patch
            .summary
            .as_ref()
            .is_some_and(|summary| summary != &existing.summary)
}

/// Guard content changes using the existing row's principals, matching Node's native update path.
pub fn assert_patch_write_allowed(
    base: &Path,
    existing: &MemoryRow,
    patch: &RowPatch,
) -> Result<(), StoreError> {
    if !is_content_changing_update(existing, patch) {
        return Ok(());
    }
    let next = patch.text.as_deref().unwrap_or(&existing.text);
    let text = if !next.is_empty() {
        next
    } else {
        patch
            .summary
            .as_deref()
            .filter(|summary| !summary.is_empty())
            .unwrap_or(&existing.summary)
    };
    assert_write(base, existing, text)
}
