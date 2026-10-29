//! Neo vector sidecars and turn journals in the pinned Node layout.
//!
//! `vector-index.json` is the generation manifest and commit point. There is no separate
//! `generation.json`: the generation number is encoded in `vectors.<generation>.f32`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::contract::StoreError;
use crate::text::js::JsString;
use crate::text::json::TolerantJsonValue as Json;

use super::atomic_write::atomic_write;
use super::ledger::JsonlLedger;
use super::ledger_types::TurnJournalLine;
use super::paths::{assert_trusted_path, secure_dir};
use super::state_file::{io_error, JsonRecord, StateFile};

/// A byte range in a little-endian float32 vector sidecar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VectorEntry {
    /// Byte offset from the beginning of the sidecar.
    pub offset: u64,
    /// Vector size in bytes (`dims * 4`).
    pub length: usize,
    /// Number of float32 elements.
    pub dims: usize,
}

/// The existing Node `vector-index.json` generation manifest, in insertion order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generation {
    /// Manifest version, currently one.
    pub version: u32,
    /// Persisted byte order, always `LE`.
    pub endian: String,
    /// Sidecar base name `vectors.<generation>.f32`.
    pub file: String,
    /// Record identifiers and byte ranges, retaining Node's object insertion order.
    pub entries: Vec<(String, VectorEntry)>,
}

impl Generation {
    /// An empty generation with the Node manifest defaults.
    #[must_use]
    pub fn new(number: u64) -> Self {
        Self {
            version: 1,
            endian: "LE".to_owned(),
            file: format!("vectors.{number}.f32"),
            entries: Vec::new(),
        }
    }

    /// Read the generation number from the existing sidecar name.
    pub fn number(&self) -> Result<u64, StoreError> {
        let digits = self
            .file
            .strip_prefix("vectors.")
            .and_then(|name| name.strip_suffix(".f32"))
            .ok_or(StoreError::Corrupt)?;
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(StoreError::Corrupt);
        }
        digits.parse().map_err(|_| StoreError::Corrupt)
    }

    fn validate(&self) -> Result<(), StoreError> {
        self.number()?;
        if self.version != 1 || self.endian != "LE" {
            return Err(StoreError::Corrupt);
        }
        for (_, entry) in &self.entries {
            if entry.dims == 0 || entry.dims.checked_mul(4) != Some(entry.length) {
                return Err(StoreError::Corrupt);
            }
        }
        Ok(())
    }
}

fn property<'a>(value: &'a Json, name: &str) -> Result<&'a Json, StoreError> {
    let Json::Object(fields) = value else {
        return Err(StoreError::Corrupt);
    };
    let key = JsString::from(name);
    fields
        .iter()
        .rev()
        .find(|(field, _)| field == &key)
        .map(|(_, value)| value)
        .ok_or(StoreError::Corrupt)
}
fn string(value: &Json) -> Result<String, StoreError> {
    let Json::String(value) = value else {
        return Err(StoreError::Corrupt);
    };
    let text = value.to_utf8_lossy();
    if text.encode_utf16().collect::<Vec<_>>() != value.as_utf16_units() {
        return Err(StoreError::Corrupt);
    }
    Ok(text)
}
fn unsigned(value: &Json) -> Result<u64, StoreError> {
    let Json::Number(value) = value else {
        return Err(StoreError::Corrupt);
    };
    value.parse().map_err(|_| StoreError::Corrupt)
}
fn field(name: &str, value: Json) -> (JsString, Json) {
    (JsString::from(name), value)
}
fn number(value: impl ToString + Copy) -> Json {
    Json::Number(value.to_string())
}

impl JsonRecord for Generation {
    fn from_json(value: Json) -> Result<Self, StoreError> {
        let Json::Object(entries) = property(&value, "entries")? else {
            return Err(StoreError::Corrupt);
        };
        let entries = entries
            .iter()
            .map(|(id, value)| {
                Ok((
                    string(&Json::String(id.clone()))?,
                    VectorEntry {
                        offset: unsigned(property(value, "offset")?)?,
                        length: usize::try_from(unsigned(property(value, "length")?)?)
                            .map_err(|_| StoreError::Corrupt)?,
                        dims: usize::try_from(unsigned(property(value, "dims")?)?)
                            .map_err(|_| StoreError::Corrupt)?,
                    },
                ))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        let generation = Self {
            version: u32::try_from(unsigned(property(&value, "version")?)?)
                .map_err(|_| StoreError::Corrupt)?,
            endian: string(property(&value, "endian")?)?,
            file: string(property(&value, "file")?)?,
            entries,
        };
        generation.validate()?;
        Ok(generation)
    }
    fn to_json(&self) -> Result<Json, StoreError> {
        self.validate()?;
        Ok(Json::Object(vec![
            field("version", number(self.version)),
            field("endian", Json::String(JsString::from(self.endian.as_str()))),
            field("file", Json::String(JsString::from(self.file.as_str()))),
            field(
                "entries",
                Json::Object(
                    self.entries
                        .iter()
                        .map(|(id, entry)| {
                            field(
                                id,
                                Json::Object(vec![
                                    field("offset", number(entry.offset)),
                                    field("length", number(entry.length)),
                                    field("dims", number(entry.dims)),
                                ]),
                            )
                        })
                        .collect(),
                ),
            ),
        ]))
    }
}

/// A Neo workspace directory. Mutating callers hold its workspace writer lock.
pub struct NeoFiles {
    directory: PathBuf,
}

impl NeoFiles {
    /// Open a trusted physical workspace path without creating files.
    pub fn open(directory: &Path) -> Result<Self, StoreError> {
        assert_trusted_path(directory)?;
        Ok(Self {
            directory: directory.to_owned(),
        })
    }

    /// Read `vector-index.json`, or Node's empty generation zero when it is absent.
    pub fn generation(&self) -> Result<Generation, StoreError> {
        Ok(
            StateFile::<Generation>::load(&self.directory.join("vector-index.json"))?
                .unwrap_or_else(|| Generation::new(0)),
        )
    }

    /// Read little-endian float32 vectors using the provided manifest snapshot.
    pub fn read_vectors(
        &self,
        generation: &Generation,
    ) -> Result<Vec<(String, Vec<f32>)>, StoreError> {
        generation.validate()?;
        if generation.entries.is_empty() {
            return Ok(Vec::new());
        }
        let path = self.directory.join(&generation.file);
        assert_trusted_path(&path)?;
        let bytes = fs::read(path).map_err(io_error)?;
        generation
            .entries
            .iter()
            .map(|(id, entry)| {
                let start = usize::try_from(entry.offset).map_err(|_| StoreError::Corrupt)?;
                let end = start.checked_add(entry.length).ok_or(StoreError::Corrupt)?;
                let vector = bytes
                    .get(start..end)
                    .ok_or(StoreError::Corrupt)?
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();
                Ok((id.clone(), vector))
            })
            .collect()
    }

    /// Write a fresh vector generation, then atomically publish its computed index.
    /// An existing sidecar may only be reused with identical bytes, so readers holding an old
    /// manifest remain valid. The caller owns the workspace writer lock for this transaction.
    pub fn write_generation(
        &self,
        generation: &Generation,
        vectors: &[(String, Vec<f32>)],
    ) -> Result<(), StoreError> {
        generation.validate()?;
        secure_dir(&self.directory)?;
        let mut index = Generation {
            entries: Vec::new(),
            ..generation.clone()
        };
        let mut bytes = Vec::new();
        for (id, vector) in vectors {
            if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
                return Err(StoreError::Corrupt);
            }
            let entry = VectorEntry {
                offset: u64::try_from(bytes.len()).map_err(|_| StoreError::Corrupt)?,
                length: vector.len().checked_mul(4).ok_or(StoreError::Corrupt)?,
                dims: vector.len(),
            };
            for value in vector {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            if let Some((_, previous)) = index.entries.iter_mut().find(|(key, _)| key == id) {
                *previous = entry;
            } else {
                index.entries.push((id.clone(), entry));
            }
        }
        let path = self.directory.join(&index.file);
        assert_trusted_path(&path)?;
        match fs::read(&path) {
            Ok(existing) if existing == bytes => {}
            Ok(_) => return Err(StoreError::Busy),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                atomic_write(&path, &bytes).map_err(io_error)?
            }
            Err(error) => return Err(io_error(error)),
        }
        StateFile::store(&self.directory.join("vector-index.json"), &index)
    }

    /// Append one real Node turn record without adding invented fields.
    pub fn append_turn(&self, line: &TurnJournalLine) -> Result<(), StoreError> {
        JsonlLedger::open(&self.directory.join(TurnJournalLine::FILE_NAME))?.append(line)
    }
}
