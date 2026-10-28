//! Tolerant JSON records and atomic engine state files.

use std::fs;
use std::marker::PhantomData;
use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};

use crate::contract::StoreError;
use crate::text::json::{parse_json, write_json, TolerantJsonValue};

use super::atomic_write::atomic_write;
use super::paths::{assert_trusted_path, secure_dir};

/// A persisted JSON record whose encoding preserves the Node string representation.
///
/// Ordinary serde records are supported directly. Records containing lone UTF-16 surrogate
/// escapes use [`TolerantJsonValue`] or a ledger-specific implementation of this codec, rather
/// than converting those strings through `serde_json::Value`.
pub trait JsonRecord: Sized {
    /// Decode one already parsed tolerant JSON value.
    fn from_json(value: TolerantJsonValue) -> Result<Self, StoreError>;
    /// Encode the record without replacing lone UTF-16 surrogates.
    fn to_json(&self) -> Result<TolerantJsonValue, StoreError>;
}

impl JsonRecord for TolerantJsonValue {
    fn from_json(value: TolerantJsonValue) -> Result<Self, StoreError> {
        Ok(value)
    }
    fn to_json(&self) -> Result<TolerantJsonValue, StoreError> {
        Ok(self.clone())
    }
}

impl<T: Serialize + DeserializeOwned> JsonRecord for T {
    fn from_json(value: TolerantJsonValue) -> Result<Self, StoreError> {
        serde_json::from_str(&write_json(&value)).map_err(|_| StoreError::Corrupt)
    }
    fn to_json(&self) -> Result<TolerantJsonValue, StoreError> {
        let json = serde_json::to_string(self).map_err(|_| StoreError::Corrupt)?;
        parse_json(&json).map_err(|_| StoreError::Corrupt)
    }
}

/// Atomic JSON-file operations, parameterized by the persisted record type.
pub struct StateFile<T>(PhantomData<T>);

impl<T: JsonRecord> StateFile<T> {
    /// Load a state file; only absence returns `None`. Invalid or inaccessible state is an error.
    pub fn load(path: &Path) -> Result<Option<T>, StoreError> {
        assert_trusted_path(path)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?;
        let value = parse_json(text).map_err(|_| StoreError::Corrupt)?;
        T::from_json(value).map(Some)
    }

    /// Atomically replace the file with compact JSON and the Node fsync writer's final newline.
    pub fn store(path: &Path, value: &T) -> Result<(), StoreError> {
        assert_trusted_path(path)?;
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            secure_dir(parent)?;
        }
        let mut text = write_json(&value.to_json()?);
        text.push('\n');
        atomic_write(path, text.as_bytes()).map_err(io_error)
    }
}

pub(super) fn io_error(error: std::io::Error) -> StoreError {
    StoreError::from(error)
}
