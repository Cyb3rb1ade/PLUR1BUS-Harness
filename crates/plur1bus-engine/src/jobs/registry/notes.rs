//! Run-local metadata, frozen before completion; snapshot keys never grant access to card data.
use super::*;
use crate::text::{js::JsString, json::TolerantJsonValue as Json};
#[derive(Clone, Debug, Default)]
pub(super) struct Notes {
    pub keys: Vec<String>,
    pub pending: Vec<String>,
    pub abandoned: Vec<String>,
    pub diary: Option<JobRunDiary>,
    pub diary_disabled: bool,
    pub counts: std::collections::HashMap<String, serde_json::Number>,
    encoded_bytes: usize,
}
pub(super) struct State {
    snapshot: Arc<Vec<Json>>,
    cancel: Cancel,
    sealed: AtomicBool,
    notes: Mutex<Notes>,
}
impl std::fmt::Debug for State {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("JobNotes")
            .field("sealed", &self.sealed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}
pub(super) struct Guard(pub Arc<State>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.sealed.store(true, Ordering::Release);
    }
}
impl State {
    pub fn new(snapshot: Arc<Vec<Json>>, cancel: Cancel) -> Self {
        Self {
            snapshot,
            cancel,
            sealed: AtomicBool::new(false),
            notes: Mutex::new(Notes::default()),
        }
    }
    fn check(&self) -> Result<(), EngineError> {
        self.cancel.check()?;
        if self.sealed.load(Ordering::Acquire) {
            return Err(StoreError::Busy.into());
        }
        Ok(())
    }
    fn edit(
        &self,
        update: impl FnOnce(&mut Notes) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        let mut notes = self.notes.lock().map_err(|_| StoreError::Corrupt)?;
        self.check()?;
        update(&mut notes)
    }
    pub fn freeze(&self) -> Result<Notes, EngineError> {
        let notes = self.notes.lock().map_err(|_| StoreError::Corrupt)?;
        self.sealed.store(true, Ordering::Release);
        Ok(notes.clone())
    }
    fn key(&self, key: &str, kind: KeyKind) -> Result<(), EngineError> {
        validate_key(key)?;
        self.edit(|notes| {
            if key.is_empty() {
                return Ok(());
            }
            let count = notes.keys.len() + notes.pending.len() + notes.abandoned.len();
            let target = match kind {
                KeyKind::Completed => &mut notes.keys,
                KeyKind::Pending => &mut notes.pending,
                KeyKind::Abandoned => &mut notes.abandoned,
            };
            if target.iter().any(|old| old == key) {
                return Ok(());
            }
            // Budget JSON bytes, including escapes; leave room for the repeated idempotency
            // key, diary and fixed run fields within the ledger's 1MiB record bound.
            let encoded = serde_json::to_string(key)
                .map_err(|_| StoreError::InvalidInput)?
                .len();
            if count >= 1000 || notes.encoded_bytes.saturating_add(encoded) > 256 * 1024 {
                return Err(StoreError::InvalidInput.into());
            }
            target.push(key.into());
            notes.encoded_bytes += encoded;
            Ok(())
        })
    }
    fn contains(&self, key: &str, kind: KeyKind) -> Result<bool, EngineError> {
        validate_key(key)?;
        self.check()?;
        let key = Json::String(JsString::from(key));
        let mut found = false;
        for row in self.snapshot.iter() {
            self.check()?;
            if matches!(kind, KeyKind::Abandoned)
                && metadata::get(row, "outcome") != Some(&Json::String("abandoned".into()))
            {
                continue;
            }
            let name = if matches!(kind, KeyKind::Completed) {
                "keys"
            } else {
                "pendingKeys"
            };
            if let Some(Json::Array(keys)) = metadata::get(row, name) {
                for candidate in keys {
                    self.check()?;
                    if candidate == &key {
                        found = true;
                        break;
                    }
                }
            }
            if found {
                break;
            }
        }
        self.check()?;
        Ok(found)
    }
}
#[derive(Clone, Copy)]
enum KeyKind {
    Completed,
    Pending,
    Abandoned,
}
fn validate_key(key: &str) -> Result<(), EngineError> {
    if key.len() > 16384 || key.encode_utf16().count() > 4096 {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(())
}
impl JobContext {
    /// Record an opaque completed window key once, in insertion order. Empty keys are ignored.
    pub fn mark_completed_key(&self, key: &str) -> Result<(), EngineError> {
        self.notes.key(key, KeyKind::Completed)
    }
    /// Record an opaque pending key; overlapping pending sets determine the retry streak.
    pub fn note_pending_key(&self, key: &str) -> Result<(), EngineError> {
        self.notes.key(key, KeyKind::Pending)
    }
    /// Record that this body encountered an abandoned key; never creates a data grant.
    pub fn note_abandoned_key(&self, key: &str) -> Result<(), EngineError> {
        self.notes.key(key, KeyKind::Abandoned)
    }
    /// Query only the snapshot taken before this body; its own notes are not yet committed rows.
    pub fn has_completed_key(&self, key: &str) -> Result<bool, EngineError> {
        self.notes.contains(key, KeyKind::Completed)
    }
    /// Query prior abandoned pending keys in the admission snapshot, without fresh disk reads.
    pub fn is_abandoned_key(&self, key: &str) -> Result<bool, EngineError> {
        self.notes.contains(key, KeyKind::Abandoned)
    }
    /// Attach one content-free numeric result under a fixed body-owned metric name.
    pub(crate) fn note_count(&self, key: &'static str, value: usize) -> Result<(), EngineError> {
        self.notes.edit(|notes| {
            notes.counts.insert(key.into(), value.into());
            Ok(())
        })
    }
    /// Report an already completed body-owned diary action. This method writes no diary file.
    pub fn note_diary(&self, written: bool, reason: Option<&str>) -> Result<(), EngineError> {
        if reason.is_some_and(|text| text.len() > 4096) {
            return Err(StoreError::InvalidInput.into());
        }
        self.notes.edit(|notes| {
            notes.diary = Some(JobRunDiary {
                written,
                reason: reason.filter(|text| !text.is_empty()).map(str::to_owned),
            });
            Ok(())
        })
    }
    /// Disable the abandonment diary explicitly. No workspace target is inferred or opened.
    pub fn disable_diary(&self) -> Result<(), EngineError> {
        self.notes.edit(|notes| {
            notes.diary_disabled = true;
            Ok(())
        })
    }
}
