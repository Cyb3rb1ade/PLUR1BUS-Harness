//! The authenticated Core's orchestration record for a re-embedding migration.
use crate::{
    contract::{Cancel, EngineError, MaintenanceGrant, StoreError},
    store::{atomic_write::atomic_write, directory::TrustedDirectory, paths::assert_trusted_path},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::PathBuf, sync::Mutex};

const DIRECTORY: &str = "reembed";
const FILE: &str = "migration.json";
const LIMIT: u64 = 1024 * 1024;

pub(super) struct CheckpointStore {
    state: PathBuf,
    writer: Mutex<()>,
}

impl CheckpointStore {
    pub(super) fn new(state: PathBuf) -> Self {
        Self {
            state,
            writer: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<(Option<String>, Value), StoreError> {
        let directory = self.state.join(DIRECTORY);
        let path = directory.join(FILE);
        assert_trusted_path(&path)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((None, Value::Null));
            }
            Ok(metadata) if metadata.is_file() && metadata.len() <= LIMIT => {}
            Ok(_) => return Err(StoreError::Corrupt),
            Err(_) => return Err(StoreError::Unavailable),
        }
        let directory = TrustedDirectory::open(&directory)?;
        let mut bytes = Vec::new();
        directory
            .open_file(FILE)?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| StoreError::Unavailable)?;
        directory.assert_unchanged()?;
        if bytes.len() as u64 > LIMIT {
            return Err(StoreError::Corrupt);
        }
        let checkpoint: Value = serde_json::from_slice(&bytes).map_err(|_| StoreError::Corrupt)?;
        if checkpoint["v"].as_u64() != Some(1) {
            return Err(StoreError::Corrupt);
        }
        Ok((Some(revision(&bytes)), checkpoint))
    }

    pub(super) fn get(&self) -> Result<Value, EngineError> {
        let (revision, checkpoint) = self.read().map_err(checkpoint_error)?;
        Ok(json!({"revision": revision, "checkpoint": checkpoint}))
    }

    pub(super) fn put(
        &self,
        grant: &MaintenanceGrant,
        expected: Option<&str>,
        checkpoint: &Value,
        cancel: &Cancel,
    ) -> Result<Value, EngineError> {
        let bytes = serde_json::to_vec(checkpoint)
            .map_err(|_| checkpoint_error(StoreError::InvalidInput))?;
        if checkpoint["v"].as_u64() != Some(1) || bytes.len() as u64 > LIMIT {
            return Err(checkpoint_error(StoreError::InvalidInput));
        }
        let _writer = self
            .writer
            .lock()
            .map_err(|_| checkpoint_error(StoreError::Unavailable))?;
        let (current, _) = self.read().map_err(checkpoint_error)?;
        if current.as_deref() != expected {
            return Err(checkpoint_error(StoreError::Busy));
        }
        grant.check(cancel)?;
        let anchor = TrustedDirectory::open(&self.state).map_err(checkpoint_error)?;
        let directory = anchor.create_child(DIRECTORY).map_err(checkpoint_error)?;
        let path = self.state.join(DIRECTORY).join(FILE);
        assert_trusted_path(&path).map_err(checkpoint_error)?;
        directory.assert_unchanged().map_err(checkpoint_error)?;
        grant.check(cancel)?;
        atomic_write(&path, &bytes).map_err(|_| checkpoint_error(StoreError::Unavailable))?;
        Ok(json!({"revision": revision(&bytes)}))
    }
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checkpoint_error(error: StoreError) -> EngineError {
    let message = match error {
        StoreError::Corrupt => "reembedding checkpoint is invalid",
        StoreError::InvalidInput => "reembedding checkpoint input is invalid",
        StoreError::Busy => "reembedding checkpoint changed",
        _ => "reembedding checkpoint is unavailable",
    };
    EngineError::Invalid {
        field: super::super::methods::REEMBEDDING_CHECKPOINT_FIELD.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn legacy_checkpoint_is_read_and_a_stale_writer_cannot_replace_it() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().canonicalize().unwrap();
        let old = json!({"v": 1, "id": "migration", "phase": "planned"});
        fs::create_dir(state.join(DIRECTORY)).unwrap();
        fs::write(state.join(DIRECTORY).join(FILE), old.to_string()).unwrap();
        let store = CheckpointStore::new(state.clone());
        let initial = store.get().unwrap();
        assert_eq!(initial["checkpoint"], old);
        let cancel = Cancel::never();
        let grant = MaintenanceGrant::for_test(Cancel::never());
        let changed = json!({"v": 1, "id": "migration", "phase": "running"});
        let old_revision = initial["revision"].as_str();
        assert!(store.put(&grant, None, &changed, &cancel).is_err());
        let written = store.put(&grant, old_revision, &changed, &cancel).unwrap();
        assert!(store.put(&grant, old_revision, &old, &cancel).is_err());
        let reopened = CheckpointStore::new(state).get().unwrap();
        assert_eq!(reopened["checkpoint"], changed);
        assert_eq!(reopened["revision"], written["revision"]);
    }
}
