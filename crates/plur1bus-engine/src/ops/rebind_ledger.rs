//! Engine-wide identity claims and write-ahead rebind records (C3).
use super::{context::error, import_primitives::field};
use crate::{
    contract::{Cancel, EngineError, MemoryOpErrorCode},
    store::{
        ledger::JsonlLedger,
        lock::{Lock, LockGuard},
        paths::{assert_trusted_path, secure_dir},
        state_file::StateFile,
    },
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn storage<T>(_: T) -> EngineError {
    error(MemoryOpErrorCode::Storage)
}
pub(super) fn string(row: &Json, key: &str) -> Option<String> {
    match field(row, key) {
        Some(Json::String(s)) => String::from_utf16(s.as_utf16_units()).ok(),
        _ => None,
    }
}
fn json(value: &serde_json::Value) -> Result<Json, EngineError> {
    parse_json(&value.to_string()).map_err(storage)
}
/// Strict Node UUID grammar; version and variant bits are not restricted.
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
/// Lossless valid records. Unknown fields remain available to recovery readers.
#[derive(Default, Clone)]
pub struct RebindRecord {
    /// Last valid header in file order.
    pub header: Option<Json>,
    /// First card intent for each exact card ID.
    pub cards: Vec<Json>,
    /// A later header resets this flag, just as Node does.
    pub reversed: bool,
}
/// Non-creating reader for one engine's rebind directory.
#[derive(Clone)]
pub struct RebindLedger {
    base: PathBuf,
}
impl RebindLedger {
    /// No filesystem operations until a method is called.
    pub fn new(base: &Path) -> Self {
        Self {
            base: base.to_owned(),
        }
    }
    fn root(&self) -> PathBuf {
        self.base.join("_rebinds")
    }
    fn path(&self, id: &str) -> Result<PathBuf, EngineError> {
        if !valid_id(id) {
            return Err(error(MemoryOpErrorCode::InvalidInput));
        }
        let p = self.root().join(format!("{id}.jsonl"));
        assert_trusted_path(&p).map_err(storage)?;
        Ok(p)
    }
    fn claim_path(&self, owner: &str) -> Result<PathBuf, EngineError> {
        let p = self
            .root()
            .join("by-identity")
            .join(format!("{:x}.json", Sha256::digest(owner.as_bytes())));
        assert_trusted_path(&p).map_err(storage)?;
        Ok(p)
    }
    /// Invalid IDs and absent files are empty; hard read failures fail closed.
    pub fn load(&self, id: &str) -> Result<RebindRecord, EngineError> {
        if !valid_id(id) {
            return Ok(RebindRecord::default());
        }
        let ledger = JsonlLedger::<Json>::open(&self.path(id)?).map_err(storage)?;
        let mut out = RebindRecord::default();
        let mut seen = HashSet::<JsString>::new();
        for line in ledger.snapshot().map_err(storage)?.lines() {
            let Ok(row) = parse_json(line) else {
                continue;
            };
            if !matches!(field(&row,"v"),Some(Json::Number(n)) if n.parse::<f64>()==Ok(1.)) {
                continue;
            }
            match string(&row, "kind").as_deref() {
                Some("header") => {
                    out.reversed = string(&row, "status").as_deref() == Some("reversed");
                    out.header = Some(row);
                }
                Some("reversed") => out.reversed = true,
                Some("card") => {
                    if let Some(Json::String(id)) = field(&row, "cardId") {
                        if seen.insert(id.clone()) {
                            out.cards.push(row);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(out)
    }
    /// Applied headers across all agents, used to enforce N:1 identity ownership.
    pub fn list_applied(&self) -> Result<Vec<(String, RebindRecord)>, EngineError> {
        let root = self.root();
        assert_trusted_path(&root).map_err(storage)?;
        let entries = match fs::read_dir(root) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(storage(e)),
        };
        let mut names = entries
            .map(|e| e.map(|e| e.file_name()).map_err(storage))
            .collect::<Result<Vec<_>, _>>()?;
        names.sort();
        let mut out = vec![];
        for name in names {
            let Some(name) = name.to_str() else { continue };
            let Some(id) = name.strip_suffix(".jsonl").filter(|id| valid_id(id)) else {
                continue;
            };
            let rec = self.load(id)?;
            if rec.header.is_some() && !rec.reversed {
                out.push((id.to_owned(), rec));
            }
        }
        Ok(out)
    }
    /// Read one claim. Invalid JSON is an error, a foreign shape has no claim.
    pub fn read_claim(&self, owner: &str) -> Result<Option<Json>, EngineError> {
        Ok(StateFile::<Json>::load(&self.claim_path(owner)?)
            .map_err(storage)?
            .filter(|r| matches!(field(r, "toOwner"), Some(Json::String(_)))))
    }
    /// Acquire the same global nonce-owned lock as Node, bounded and cancellable.
    /// Dry-run callers never invoke this method.
    pub fn acquire(&self, cancel: &Cancel, timeout: Duration) -> Result<RebindLease, EngineError> {
        cancel.check()?;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))?;
        secure_dir(&self.root()).map_err(storage)?;
        loop {
            cancel.check()?;
            if let Some(guard) =
                Lock::try_acquire(&self.root().join(".lock"), Duration::from_secs(60), None)
                    .map_err(storage)?
            {
                sync_dir(&self.root());
                return Ok(RebindLease {
                    ledger: self.clone(),
                    guard,
                });
            }
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
            std::thread::sleep(left.min(Duration::from_millis(15)));
        }
    }
}
fn sync_dir(path: &Path) {
    let _ = File::open(path).and_then(|f| f.sync_all());
}
/// Every claim/intent mutation requires a still-owned engine-wide lease.
pub struct RebindLease {
    ledger: RebindLedger,
    guard: LockGuard,
}
impl RebindLease {
    /// Fence before every sidecar or card mutation.
    pub fn assert_held(&self) -> Result<(), EngineError> {
        if self.guard.is_owned() {
            Ok(())
        } else {
            Err(error(MemoryOpErrorCode::LockLost))
        }
    }
    fn append(&self, id: &str, row: &Json, now: i64, new: bool) -> Result<(), EngineError> {
        self.assert_held()?;
        let path = self.ledger.path(id)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        if new {
            options.create_new(true);
        } else {
            options.create(true);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| {
            if new && e.kind() == std::io::ErrorKind::AlreadyExists {
                error(MemoryOpErrorCode::Conflict)
            } else {
                storage(e)
            }
        })?;
        let len = file.metadata().map_err(storage)?.len();
        if len > 0 {
            file.seek(SeekFrom::End(-1)).map_err(storage)?;
            let mut last = [0];
            file.read_exact(&mut last).map_err(storage)?;
            if last[0] != b'\n' {
                let mut end = len;
                let mut found = None;
                let mut chunk = vec![0u8; 65536];
                while end > 0 {
                    let start = end.saturating_sub(chunk.len() as u64);
                    let size = (end - start) as usize;
                    file.seek(SeekFrom::Start(start)).map_err(storage)?;
                    file.read_exact(&mut chunk[..size]).map_err(storage)?;
                    if let Some(i) = chunk[..size].iter().rposition(|b| *b == b'\n') {
                        found = Some(start + i as u64 + 1);
                        break;
                    }
                    end = start;
                }
                self.assert_held()?;
                let Some(size) = found else {
                    drop(file);
                    let target = path.with_file_name(format!("{id}.jsonl.corrupt-{now}"));
                    assert_trusted_path(&target).map_err(storage)?;
                    fs::rename(&path, target).map_err(storage)?;
                    sync_dir(&self.ledger.root());
                    return Err(error(MemoryOpErrorCode::LedgerCorrupt));
                };
                file.set_len(size).map_err(storage)?;
            }
        }
        self.assert_held()?;
        file.seek(SeekFrom::End(0)).map_err(storage)?;
        file.write_all(format!("{}\n", write_json(row)).as_bytes())
            .map_err(storage)?;
        file.sync_all().map_err(storage)?;
        sync_dir(&self.ledger.root());
        Ok(())
    }
    /// Create a durable claim before the first header. Existing different targets conflict.
    pub fn write_claim(&self, from: &str, to: &str, now: i64) -> Result<(), EngineError> {
        self.assert_held()?;
        if let Some(old) = self.ledger.read_claim(from)? {
            return if string(&old, "toOwner").as_deref() == Some(to) {
                Ok(())
            } else {
                Err(error(MemoryOpErrorCode::IdentityAlreadyBound))
            };
        }
        let path = self.ledger.claim_path(from)?;
        let parent = path
            .parent()
            .ok_or_else(|| error(MemoryOpErrorCode::Storage))?;
        secure_dir(parent).map_err(storage)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return match self.ledger.read_claim(from)? {
                    Some(old) if string(&old, "toOwner").as_deref() == Some(to) => Ok(()),
                    _ => Err(error(MemoryOpErrorCode::IdentityAlreadyBound)),
                };
            }
            Err(e) => return Err(storage(e)),
        };
        let row = serde_json::json!({"v":1,"fromOwner":from,"toOwner":to,"createdAt":now});
        self.assert_held()?;
        file.write_all(format!("{row}\n").as_bytes())
            .map_err(storage)?;
        file.sync_all().map_err(storage)?;
        sync_dir(parent);
        sync_dir(&self.ledger.root());
        Ok(())
    }
    /// Refuse to replace an existing journal; headers are written before card intents.
    pub fn write_header(
        &self,
        id: &str,
        agent: &str,
        from: &str,
        to: &str,
        now: i64,
    ) -> Result<(), EngineError> {
        self.append(id,&json(&serde_json::json!({"v":1,"kind":"header","rebindId":id,"agentId":agent,"fromOwner":from,"toOwner":to,"status":"applied","createdAt":now}))?,now,true)
    }
    /// The card intent must be durable before changing its owner.
    pub fn append_card(
        &self,
        id: &str,
        card: &str,
        from: &str,
        to: &str,
        updated: f64,
        now: i64,
    ) -> Result<(), EngineError> {
        self.append(id,&json(&serde_json::json!({"v":1,"kind":"card","rebindId":id,"cardId":card,"fromOwner":from,"toOwner":to,"fromUpdatedAt":updated}))?,now,false)
    }
    /// Mark reverse completion after all selected card updates.
    pub fn append_reversed(&self, id: &str, now: i64) -> Result<(), EngineError> {
        self.append(
            id,
            &json(&serde_json::json!({"v":1,"kind":"reversed","rebindId":id,"reversedAt":now}))?,
            now,
            false,
        )
    }
    /// A remaining applied agent journal retains the engine-wide claim.
    pub fn release_claim_if_free(&self, from: &str) -> Result<(), EngineError> {
        self.assert_held()?;
        if self.ledger.list_applied()?.iter().any(|(_, r)| {
            r.header
                .as_ref()
                .and_then(|h| string(h, "fromOwner"))
                .as_deref()
                == Some(from)
        }) {
            return Ok(());
        }
        let p = self.ledger.claim_path(from)?;
        match fs::remove_file(&p) {
            Ok(()) => {
                if let Some(parent) = p.parent() {
                    sync_dir(parent);
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(storage(e)),
        }
    }
}
