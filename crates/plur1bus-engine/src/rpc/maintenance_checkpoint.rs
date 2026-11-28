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
        if !valid_checkpoint(&checkpoint) {
            return Err(StoreError::Corrupt);
        }
        Ok((Some(revision(&bytes)), checkpoint))
    }

    pub(super) fn get(&self) -> Result<Value, EngineError> {
        let (revision, checkpoint) = self.read().map_err(|error| checkpoint_error(&error))?;
        Ok(json!({"revision": revision, "checkpoint": checkpoint}))
    }

    pub(super) fn put(
        &self,
        grant: &MaintenanceGrant,
        expected: Option<&str>,
        checkpoint: &Value,
        cancel: &Cancel,
    ) -> Result<(String, bool), EngineError> {
        let bytes = serde_json::to_vec(checkpoint)
            .map_err(|_| checkpoint_error(&StoreError::InvalidInput))?;
        if !valid_checkpoint(checkpoint) || bytes.len() as u64 > LIMIT {
            return Err(checkpoint_error(&StoreError::InvalidInput));
        }
        let next = revision(&bytes);
        let _writer = self
            .writer
            .lock()
            .map_err(|_| checkpoint_error(&StoreError::Unavailable))?;
        let (current, _) = self.read().map_err(|error| checkpoint_error(&error))?;
        if crate::rpc::seams::fixture_step("checkpoint-replay")
            && current.as_deref() == Some(next.as_str())
        {
            // The process fixture models revocation after the read, while the
            // peer remains available to observe the worker's refusal.
            cancel.cancel();
        }
        grant.check(cancel)?;
        if current.as_deref() == Some(next.as_str()) {
            return Ok((next, false));
        }
        if current.as_deref() != expected {
            return Err(checkpoint_error(&StoreError::Busy));
        }
        let anchor =
            TrustedDirectory::open(&self.state).map_err(|error| checkpoint_error(&error))?;
        let directory = anchor
            .create_child(DIRECTORY)
            .map_err(|error| checkpoint_error(&error))?;
        let path = self.state.join(DIRECTORY).join(FILE);
        assert_trusted_path(&path).map_err(|error| checkpoint_error(&error))?;
        directory
            .assert_unchanged()
            .map_err(|error| checkpoint_error(&error))?;
        grant.check(cancel)?;
        atomic_write(&path, &bytes).map_err(|_| checkpoint_error(&StoreError::Unavailable))?;
        Ok((next, true))
    }
}

fn valid_checkpoint(value: &Value) -> bool {
    value["v"].as_u64() == Some(1) && value["id"].is_string()
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checkpoint_error(error: &StoreError) -> EngineError {
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
    fn checkpoint_rejects_unknown_versions_on_write_and_on_reopen() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().canonicalize().unwrap();
        let store = CheckpointStore::new(state.clone());
        let grant = MaintenanceGrant::for_test(Cancel::never());
        let future = json!({"v":2,"id":"future"});
        let file = state.join(DIRECTORY).join(FILE);
        assert!(matches!(store.put(&grant, None, &future, &Cancel::never()),
            Err(EngineError::Invalid { message, .. }) if message == "reembedding checkpoint input is invalid"));
        assert!(!file.exists());
        fs::create_dir(state.join(DIRECTORY)).unwrap();
        fs::write(&file, future.to_string()).unwrap();
        assert!(matches!(store.get(),
            Err(EngineError::Invalid { message, .. }) if message == "reembedding checkpoint is invalid"));
    }

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
        assert!(written.1);
        assert_eq!(reopened["revision"], written.0);
    }
}
