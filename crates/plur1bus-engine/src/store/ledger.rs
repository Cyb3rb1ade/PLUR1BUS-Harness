//! Typed, lossless Node JSONL ledgers.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use crate::contract::StoreError;
use crate::text::json::{parse_json, write_json};

use super::paths::{assert_trusted_path, secure_dir};
use super::state_file::{io_error, JsonRecord};

/// One engine-owned JSONL file. Appends are single `O_APPEND` writes like the pinned Node
/// writers' `appendFileSync`, so Rust and Node appenders keep each other's lines.
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

    /// Append exactly one compact JSON line in a single write to the end of the file.
    /// Node appends to some of these files without any lock, so replacing the file could drop a
    /// line Node wrote in between. A final line without its newline is closed in the same write.
    /// Like Node's append, it is not fsynced; a new file is private (`0600` on Unix).
    pub fn append(&self, value: &T) -> Result<(), StoreError> {
        assert_trusted_path(&self.path)?;
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            secure_dir(parent)?;
        }
        let line = write_json(&value.to_json()?);
        let mut file = open_for_append(&self.path).map_err(io_error)?;
        let mut record = Vec::with_capacity(line.len() + 2);
        if ends_without_newline(&mut file).map_err(io_error)? {
            record.push(b'\n');
        }
        record.extend_from_slice(line.as_bytes());
        record.push(b'\n');
        file.write_all(&record).map_err(io_error)
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
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => Err(StoreError::Corrupt),
            Err(error) => Err(io_error(error)),
        }
    }
}

fn open_for_append(path: &Path) -> io::Result<File> {
    #[allow(unused_mut)] // Unix alone sets the private file mode.
    let mut options = OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn ends_without_newline(file: &mut File) -> io::Result<bool> {
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}
