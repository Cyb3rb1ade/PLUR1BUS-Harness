//! Typed, lossless Node JSONL ledgers.

use std::fs;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use crate::contract::StoreError;
use crate::text::json::{parse_json, write_json};

use super::atomic_write::atomic_write;
use super::paths::{assert_trusted_path, secure_dir};
use super::state_file::{io_error, JsonRecord};

/// One engine-owned JSONL file. Writers hold the corresponding shared process lock while
/// appending, so a complete atomic replacement cannot lose another writer's update.
pub struct JsonlLedger<T> {
    path: PathBuf,
    record: PhantomData<T>,
}

impl<T: JsonRecord> JsonlLedger<T> {
    /// Open a ledger without creating or mutating it. A missing ledger iterates as empty.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        assert_trusted_path(path)?;
        Ok(Self {
            path: path.to_owned(),
            record: PhantomData,
        })
    }

    /// Append exactly one compact JSON line through the shared atomic writer.
    /// The caller holds the ledger's writer lock for this read/replace transaction.
    pub fn append(&self, value: &T) -> Result<(), StoreError> {
        assert_trusted_path(&self.path)?;
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            secure_dir(parent)?;
        }
        let mut bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(io_error(error)),
        };
        if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(write_json(&value.to_json()?).as_bytes());
        bytes.push(b'\n');
        atomic_write(&self.path, &bytes).map_err(io_error)
    }

    /// Read a consistent snapshot. Empty lines are ignored, CRLF is accepted and malformed
    /// lines remain distinguishable errors, so callers can explicitly apply Node's skip policy.
    pub fn iter(&self) -> impl Iterator<Item = Result<T, StoreError>> {
        std::iter::once(self.snapshot()).flat_map(|result| match result {
            Ok(text) => text
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| {
                    parse_json(line)
                        .map_err(|_| StoreError::Corrupt)
                        .and_then(T::from_json)
                })
                .collect::<Vec<_>>(),
            Err(error) => vec![Err(error)],
        })
    }

    fn snapshot(&self) -> Result<String, StoreError> {
        assert_trusted_path(&self.path)?;
        match fs::read_to_string(&self.path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                Err(StoreError::Corrupt)
            }
            Err(error) => Err(io_error(error)),
        }
    }
}
