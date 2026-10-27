//! Bounded numeric calibration state with a lifetime writer lock and atomic copy-on-write saves.
//! Only the supplied engine state directory is used; prompt text and credentials are never persisted.

use super::calibration_fit;
use super::{
    CalibrationError, CalibrationFit, TokenCounter, TokenMethod, TokenObservation, TokenRoute,
    MAX_CALIBRATION_BYTES, MAX_CALIBRATION_KEYS, MAX_CALIBRATION_OBSERVATIONS,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const STATE_VERSION: u32 = 1;
const STATE_FILE: &str = "token-calibration.json";
const LOCK_FILE: &str = "token-calibration.lock";
const TEMP_FILE: &str = "token-calibration.tmp";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Key {
    pub route: TokenRoute,
    pub family: String,
    pub method: TokenMethod,
    pub version: u32,
}

impl Key {
    pub(super) fn from_observation(observation: &TokenObservation) -> Self {
        Self {
            route: observation.route.clone(),
            family: observation.family.clone(),
            method: observation.base.method,
            version: observation.base.version,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Sample {
    pub estimated: u64,
    pub reported: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    key: Key,
    samples: Vec<Sample>,
    #[serde(skip)]
    fit: Option<CalibrationFit>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct State {
    version: u32,
    entries: Vec<Entry>,
}

/// In-memory fits backed by versioned numeric observations in an explicitly supplied state directory.
/// A lifetime exclusive OS lock prevents lost updates; the persistent lock file must not be deleted.
/// Opening reads once, observation batches write atomically, and fit lookup performs no I/O.
pub struct CalibrationStore {
    directory: PathBuf,
    _lock: File,
    entries: Vec<Entry>,
}

impl CalibrationStore {
    /// Open `<engine_state>/token-calibration.json`, creating an empty store only if it is absent.
    /// Refuse contention, malformed/newer/oversized state and invalid persisted keys. A stale regular
    /// staging file from a crashed owner is removed under the lock; symlinks and directories are refused.
    pub fn open(engine_state: &Path) -> Result<Self, CalibrationError> {
        fs::create_dir_all(engine_state).map_err(CalibrationError::Io)?;
        let lock_path = engine_state.join(LOCK_FILE);
        refuse_non_regular(&lock_path)?;
        let lock = private_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(CalibrationError::Io)?;
        lock.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => CalibrationError::Locked,
            fs::TryLockError::Error(error) => CalibrationError::Io(error),
        })?;
        let entries = load(&engine_state.join(STATE_FILE))?;
        let temporary = engine_state.join(TEMP_FILE);
        refuse_non_regular(&temporary)?;
        match fs::remove_file(temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(CalibrationError::Io(error)),
        }
        Ok(Self {
            directory: engine_state.to_owned(),
            _lock: lock,
            entries,
        })
    }

    /// Look up a learned full-prompt fit by the complete route, family and underlying method.
    /// Returns `None` for unseen, sparse or degenerate data; no filesystem access occurs.
    pub fn fit(
        &self,
        route: &TokenRoute,
        family: &str,
        method: TokenMethod,
    ) -> Option<CalibrationFit> {
        self.find(route, family, method).and_then(|entry| entry.fit)
    }

    pub(super) fn observations(
        &self,
        route: &TokenRoute,
        family: &str,
        method: TokenMethod,
    ) -> usize {
        self.find(route, family, method)
            .map_or(0, |entry| entry.samples.len())
    }

    fn find(&self, route: &TokenRoute, family: &str, method: TokenMethod) -> Option<&Entry> {
        self.entries.iter().find(|entry| {
            entry.key.route == *route && entry.key.family == family && entry.key.method == method
        })
    }

    pub(super) fn append(
        &mut self,
        observations: &[TokenObservation],
    ) -> Result<(), CalibrationError> {
        // Clone once at the transactional boundary: validation/save failures leave the live model untouched.
        let mut entries = self.entries.clone();
        for observation in observations {
            let Some(reported) = observation.reported.input_total else {
                continue;
            };
            let key = Key::from_observation(observation);
            let index = match entries.iter().position(|entry| entry.key == key) {
                Some(index) => index,
                None => {
                    if entries.len() >= MAX_CALIBRATION_KEYS {
                        return Err(CalibrationError::Capacity);
                    }
                    entries.push(Entry {
                        key,
                        samples: Vec::new(),
                        fit: None,
                    });
                    entries.len() - 1
                }
            };
            let entry = &mut entries[index];
            if entry.samples.len() == MAX_CALIBRATION_OBSERVATIONS {
                entry.samples.remove(0);
            }
            entry.samples.push(Sample {
                estimated: observation.base.tokens,
                reported,
            });
        }
        for entry in &mut entries {
            entry.fit = calibration_fit::fit(&entry.samples);
        }
        let state = State {
            version: STATE_VERSION,
            entries,
        };
        save(&self.directory, &state)?;
        self.entries = state.entries;
        Ok(())
    }
}

fn load(path: &Path) -> Result<Vec<Entry>, CalibrationError> {
    refuse_non_regular(path)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(CalibrationError::Io(error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CALIBRATION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(CalibrationError::Io)?;
    if bytes.len() > MAX_CALIBRATION_BYTES {
        return Err(CalibrationError::TooLarge);
    }
    let mut state: State = serde_json::from_slice(&bytes).map_err(CalibrationError::Malformed)?;
    if state.version != STATE_VERSION {
        return Err(CalibrationError::UnsupportedVersion(state.version));
    }
    validate_entries(&state.entries)?;
    for entry in &mut state.entries {
        entry.fit = calibration_fit::fit(&entry.samples);
    }
    Ok(state.entries)
}

fn validate_entries(entries: &[Entry]) -> Result<(), CalibrationError> {
    if entries.len() > MAX_CALIBRATION_KEYS {
        return Err(CalibrationError::Capacity);
    }
    let counter = TokenCounter::heuristic()
        .map_err(|_| CalibrationError::InvalidObservation("cannot validate profile families"))?;
    let mut keys = BTreeSet::new();
    for entry in entries {
        if !keys.insert(&entry.key)
            || entry.samples.is_empty()
            || entry.samples.len() > MAX_CALIBRATION_OBSERVATIONS
        {
            return Err(CalibrationError::InvalidObservation(
                "duplicate key or invalid sample count",
            ));
        }
        counter.validate_calibration_key(&entry.key)?;
        for sample in &entry.samples {
            super::calibration::validate_counts(sample.estimated, Some(sample.reported))?;
        }
    }
    Ok(())
}

fn save(directory: &Path, state: &State) -> Result<(), CalibrationError> {
    let bytes = serde_json::to_vec(state).map_err(CalibrationError::Malformed)?;
    if bytes.len() > MAX_CALIBRATION_BYTES {
        return Err(CalibrationError::TooLarge);
    }
    let temporary = directory.join(TEMP_FILE);
    let mut file = private_options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(CalibrationError::Io)?;
    // Only clean up a file created by this call, never an existing path that caused create_new to fail.
    let cleanup = TemporaryFile(temporary);
    file.write_all(&bytes).map_err(CalibrationError::Io)?;
    file.sync_all().map_err(CalibrationError::Io)?;
    drop(file);
    // Replacement is the commit point and final fallible operation: errors preserve prior disk and memory.
    fs::rename(&cleanup.0, directory.join(STATE_FILE)).map_err(CalibrationError::Io)?;
    Ok(())
}

struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        // Best-effort cleanup after failure; a crash/stale file is handled under the next owner's lock.
        let _ = fs::remove_file(&self.0);
    }
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn refuse_non_regular(path: &Path) -> Result<(), CalibrationError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err(CalibrationError::InvalidObservation(
                "state, lock and staging paths must be regular files",
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CalibrationError::Io(error)),
    }
}
