//! Per-operation audit occurrence. Identical lines belonging to different operations stay distinct.
use super::{conflict_file as file, interference_state::hash};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
const NAME: &str = "curation-log.jsonl";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    directory: (PathBuf, (u64, u64)),
    prefix_len: usize,
    prefix_hash: String,
    event_json: String,
}
pub(crate) struct Files {
    directory: TrustedDirectory,
    pub snapshot: Snapshot,
    complete: bool,
}
impl Files {
    pub fn prepare(
        workspace: &TrustedDirectory,
        event_json: String,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        let directory = workspace.create_child(".adaptive-learning")?;
        directory.restrict_private()?;
        let before = file::read(&directory, NAME, file::MAX_BYTES, cancel)?;
        let bytes = before.as_deref().unwrap_or_default();
        if file::records(bytes)?.len() >= file::MAX_ROWS
            || bytes.len() + event_json.len() + 1 > file::MAX_BYTES
        {
            return Err(StoreError::Unavailable.into());
        }
        let snapshot = Snapshot {
            directory: (directory.path().to_owned(), directory.identity_parts()),
            prefix_len: bytes.len(),
            prefix_hash: hash(bytes),
            event_json,
        };
        let files = Self {
            directory,
            snapshot,
            complete: false,
        };
        files.validate(false, cancel)?;
        Ok(files)
    }
    pub fn restore(
        workspace: &TrustedDirectory,
        snapshot: &Snapshot,
        event_json: &str,
        complete: bool,
        cancel: &Cancel,
    ) -> Result<Self, EngineError> {
        let directory = workspace.open_child(".adaptive-learning")?;
        if snapshot.directory != (directory.path().to_owned(), directory.identity_parts())
            || snapshot.event_json != event_json
            || snapshot.prefix_len > file::MAX_BYTES
            || snapshot.prefix_hash.len() != 64
        {
            return Err(StoreError::Corrupt.into());
        }
        let files = Self {
            directory,
            snapshot: snapshot.clone(),
            complete,
        };
        files.validate(complete, cancel)?;
        Ok(files)
    }
    fn inventory(&self, cancel: &Cancel) -> Result<(Option<Vec<u8>>, bool), EngineError> {
        self.directory.assert_unchanged()?;
        let before = file::read(&self.directory, NAME, file::MAX_BYTES, cancel)?;
        let bytes = before.as_deref().unwrap_or_default();
        let count = file::records(bytes)?.len();
        let mut line = self.snapshot.event_json.as_bytes().to_vec();
        line.push(b'\n');
        if self.snapshot.event_json.contains('\n') || file::records(&line)?.len() != 1 {
            return Err(StoreError::Corrupt.into());
        }
        let prefix = bytes
            .get(..self.snapshot.prefix_len)
            .ok_or(StoreError::Corrupt)?;
        if hash(prefix) != self.snapshot.prefix_hash
            || (!prefix.is_empty() && !prefix.ends_with(b"\n"))
        {
            return Err(StoreError::Corrupt.into());
        }
        let suffix = &bytes[self.snapshot.prefix_len..];
        let present = suffix.starts_with(&line);
        if !suffix.is_empty() && !present {
            return Err(StoreError::Corrupt.into());
        }
        if !present && (count >= file::MAX_ROWS || bytes.len() + line.len() > file::MAX_BYTES) {
            return Err(StoreError::Unavailable.into());
        }
        Ok((before, present))
    }
    pub fn validate(&self, complete: bool, cancel: &Cancel) -> Result<(), EngineError> {
        if !self.inventory(cancel)?.1 && (complete || self.complete) {
            return Err(StoreError::Corrupt.into());
        }
        Ok(())
    }
    pub fn publish(
        &self,
        cancel: &Cancel,
        check: &dyn Fn() -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        check()?;
        let (before, present) = self.inventory(cancel)?;
        if present {
            return Ok(());
        }
        if self.complete {
            return Err(StoreError::Corrupt.into());
        }
        let mut bytes = before.clone().unwrap_or_default();
        bytes.extend_from_slice(self.snapshot.event_json.as_bytes());
        bytes.push(b'\n');
        file::replace(
            &self.directory,
            NAME,
            before.as_deref(),
            &bytes,
            cancel,
            check,
        )?;
        self.validate(true, cancel)
    }
}
