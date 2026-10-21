//! `connection-transport.json`, the sidecar that keeps each remote connection's transport choice (spec §3.2).
//!
//! `connections.json` is never written here: it is only read, to learn which ids are remote rows. Older builds
//! ignore the sidecar, so a downgrade loses nothing (R10).

use super::{HostInput, PublicAck, Transport};
use crate::connections::{Connection, Kind};
use plur1bus_desktop_net::is_tailnet;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const FILE: &str = "connection-transport.json";
const CONNECTIONS: &str = "connections.json";
/// Both files are at most 1 MiB.
const MAX_BYTES: usize = 1024 * 1024;
const VERSION: u64 = 1;

/// Serialises read-modify-write cycles of this process.
static WRITE_OWNER: Mutex<()> = Mutex::new(());

/// Whether the store may write. A sidecar from a newer app version (`version` above 1) is left alone: derived
/// defaults apply and every write is refused (spec §3.2). A sidecar that cannot be read (not a regular file, an I/O
/// error, a corrupt file that could not be moved aside) is `Failed`: defaults apply and writes fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreMode {
    ReadWrite,
    ReadOnlyNewer,
    Failed,
}

/// One connection's entry. Unknown fields are kept on write, so a newer build's additions survive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportEntry {
    pub transport: Transport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_ack: Option<PublicAck>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl TransportEntry {
    pub fn new(transport: Transport) -> Self {
        Self {
            transport,
            public_ack: None,
            extra: Map::new(),
        }
    }
}

/// Why a write was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportStoreError {
    /// The sidecar is from a newer app version (`transport-store-readonly`, spec §8).
    ReadOnly,
    /// The id is not a `remote` row of `connections.json`; bundled and local connections have no transport.
    NotRemote,
    /// `connections.json` could not be read, so the id cannot be checked.
    Connections,
    /// The sidecar could not be read or written.
    Io,
    /// The sidecar would exceed 1 MiB.
    TooLarge,
}

impl TransportStoreError {
    /// A stable code. Only `transport-store-readonly` is a spec §8 code the shell translates; the others are internal
    /// command-error strings (no §8 code fits them), stable but not part of the UI catalogue.
    pub fn code(&self) -> &'static str {
        match self {
            Self::ReadOnly => "transport-store-readonly",
            Self::NotRemote => "transport-store-not-remote",
            Self::Connections => "transport-store-connections-unreadable",
            Self::Io => "transport-store-io",
            Self::TooLarge => "transport-store-too-large",
        }
    }
}

impl std::fmt::Display for TransportStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ReadOnly => "transport store: written by a newer app version, read-only",
            Self::NotRemote => "transport store: not a remote connection",
            Self::Connections => "transport store: connections.json is unreadable",
            Self::Io => "transport store: input/output error",
            Self::TooLarge => "transport store: file exceeds 1 MiB",
        })
    }
}

impl std::error::Error for TransportStoreError {}

/// One entry of the sidecar. An entry whose `transport` is a string this build does not know (a newer build's path)
/// is kept as it was read and treated as absent (derived default); it does not make the file corrupt, and it is
/// written back unchanged until an explicit set replaces it. Any other malformed entry still makes the file corrupt.
#[derive(Clone, Debug)]
enum Slot {
    Known(TransportEntry),
    Unknown(Value),
}

impl Serialize for Slot {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Known(entry) => entry.serialize(s),
            Self::Unknown(raw) => raw.serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for Slot {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(d)?;
        let unknown = raw
            .get("transport")
            .and_then(Value::as_str)
            .is_some_and(|t| serde_json::from_value::<Transport>(Value::from(t)).is_err());
        if unknown {
            return Ok(Self::Unknown(raw));
        }
        serde_json::from_value(raw)
            .map(Self::Known)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Serialize, Deserialize)]
struct Sidecar {
    version: u64,
    #[serde(default)]
    connections: BTreeMap<Uuid, Slot>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            version: VERSION,
            connections: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

enum Loaded {
    /// No sidecar (or a corrupt one that was just moved aside).
    Missing,
    Current(Sidecar),
    Newer,
    /// Corrupt (not JSON, oversized, wrong types, bad version): the bytes read, for the move under the write lock.
    Corrupt(Vec<u8>),
    /// Not readable, not a regular file, or a corrupt file that could not be moved aside.
    Failed,
}

enum Quarantine {
    Moved,
    /// The file is no longer the corrupt bytes that were read (for example a good write replaced it).
    Changed,
    Failed,
}

/// The rows of `connections.json` this store needs; every other field is ignored.
#[derive(Deserialize)]
struct ConnectionRows {
    #[serde(default)]
    connections: Vec<ConnectionRow>,
}

#[derive(Deserialize)]
struct ConnectionRow {
    id: Uuid,
    kind: String,
}

/// The sidecar store in the app config directory, beside `connections.json`.
pub struct TransportStore {
    dir: PathBuf,
}

impl TransportStore {
    pub fn open(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    pub fn mode(&self) -> StoreMode {
        match self.read_settled() {
            Loaded::Newer => StoreMode::ReadOnlyNewer,
            Loaded::Failed => StoreMode::Failed,
            Loaded::Missing | Loaded::Current(_) | Loaded::Corrupt(_) => StoreMode::ReadWrite,
        }
    }

    /// The stored entry, if any. A newer, unreadable or corrupt sidecar has none.
    pub fn get(&self, id: Uuid) -> Option<TransportEntry> {
        match self.read_settled() {
            Loaded::Current(file) => match file.connections.get(&id) {
                Some(Slot::Known(entry)) => Some(entry.clone()),
                Some(Slot::Unknown(_)) | None => None,
            },
            _ => None,
        }
    }

    /// The entry the app uses: the stored one of a remote row, otherwise the derived default (spec §3.2).
    pub fn effective(&self, connection: &Connection) -> TransportEntry {
        if connection.kind == Kind::Remote {
            if let Some(entry) = self.get(connection.id) {
                return entry;
            }
        }
        derived_default(connection)
    }

    /// Stores the entry of a remote row. Entries of ids that are no longer remote rows of `connections.json` are
    /// dropped in the same write.
    pub fn set(&self, id: Uuid, entry: TransportEntry) -> Result<(), TransportStoreError> {
        let _guard = WRITE_OWNER.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load_for_write()?;
        let remote = self.remote_ids()?;
        if !remote.contains(&id) {
            return Err(TransportStoreError::NotRemote);
        }
        file.connections.insert(id, Slot::Known(entry));
        file.connections.retain(|k, _| remote.contains(k));
        self.write(&file)
    }

    /// Removes an id's entry (after the connection itself was removed). Writes only when something changed; stale
    /// entries go in the same write when `connections.json` is readable.
    pub fn remove(&self, id: Uuid) -> Result<(), TransportStoreError> {
        let _guard = WRITE_OWNER.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load_for_write()?;
        let before = file.connections.len();
        file.connections.remove(&id);
        if let Ok(remote) = self.remote_ids() {
            file.connections.retain(|k, _| remote.contains(k));
        }
        if file.connections.len() == before {
            return Ok(());
        }
        self.write(&file)
    }

    /// Drops every entry whose id is not in `live` (the ids of `connections.json`). Writes only when something
    /// changed. Test surface only (debug builds): production drops stale entries in [`Self::set`] and
    /// [`Self::remove`].
    #[cfg(debug_assertions)]
    pub fn gc(&self, live: &[Uuid]) -> Result<(), TransportStoreError> {
        let _guard = WRITE_OWNER.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.load_for_write()?;
        let before = file.connections.len();
        file.connections.retain(|k, _| live.contains(k));
        if file.connections.len() == before {
            return Ok(());
        }
        self.write(&file)
    }

    fn path(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    /// Called with the write lock held.
    fn load_for_write(&self) -> Result<Sidecar, TransportStoreError> {
        match self.settle() {
            Loaded::Missing => Ok(Sidecar::default()),
            Loaded::Current(file) => Ok(file),
            Loaded::Newer => Err(TransportStoreError::ReadOnly),
            Loaded::Corrupt(_) | Loaded::Failed => Err(TransportStoreError::Io),
        }
    }

    /// A read without the write lock. A corrupt file is moved aside only under the lock, after a fresh read
    /// ([`Self::settle`]), so a reader can never rename a good sidecar a writer has just persisted.
    fn read_settled(&self) -> Loaded {
        match self.load() {
            Loaded::Corrupt(_) => {
                let _guard = WRITE_OWNER.lock().unwrap_or_else(|e| e.into_inner());
                self.settle()
            }
            other => other,
        }
    }

    /// Reads the sidecar with the write lock held and moves a corrupt one aside. A file that changed between the read
    /// and the move (another process wrote it) is read again, a bounded number of times.
    fn settle(&self) -> Loaded {
        for _ in 0..3 {
            match self.load() {
                Loaded::Corrupt(bytes) => match self.quarantine(&bytes) {
                    Quarantine::Moved => return Loaded::Missing,
                    Quarantine::Changed => continue,
                    Quarantine::Failed => return Loaded::Failed,
                },
                other => return other,
            }
        }
        Loaded::Failed
    }

    fn load(&self) -> Loaded {
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Loaded::Failed,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
            Err(_) => return Loaded::Failed,
        }
        let Ok(bytes) = read_capped(&path) else {
            return Loaded::Failed;
        };
        if bytes.len() > MAX_BYTES {
            return Loaded::Corrupt(bytes);
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return Loaded::Corrupt(bytes);
        };
        match value.get("version").and_then(Value::as_u64) {
            Some(VERSION) => match serde_json::from_value::<Sidecar>(value) {
                Ok(file) => Loaded::Current(file),
                Err(_) => Loaded::Corrupt(bytes),
            },
            Some(v) if v > VERSION => Loaded::Newer,
            _ => Loaded::Corrupt(bytes),
        }
    }

    /// Moves a corrupt sidecar aside as `connection-transport.json.corrupt-<ms>-<uuid>`, but only while it still holds
    /// exactly the corrupt bytes that were read; `connections.json` is never touched. Called with the write lock
    /// held, so no writer of this process can replace the file in between.
    fn quarantine(&self, corrupt: &[u8]) -> Quarantine {
        match read_capped(&self.path()) {
            Ok(now) if now == corrupt => {}
            Ok(_) => return Quarantine::Changed,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Quarantine::Changed,
            Err(_) => return Quarantine::Failed,
        }
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let target = self
            .dir
            .join(format!("{FILE}.corrupt-{ms}-{}", Uuid::now_v7()));
        match fs::rename(self.path(), target) {
            Ok(()) => Quarantine::Moved,
            Err(_) => Quarantine::Failed,
        }
    }

    /// The ids of the `remote` rows of `connections.json`, read without ever opening it for writing.
    fn remote_ids(&self) -> Result<Vec<Uuid>, TransportStoreError> {
        let path = self.dir.join(CONNECTIONS);
        let bytes = match read_capped(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(TransportStoreError::Connections),
        };
        if bytes.len() > MAX_BYTES {
            return Err(TransportStoreError::Connections);
        }
        let rows: ConnectionRows =
            serde_json::from_slice(&bytes).map_err(|_| TransportStoreError::Connections)?;
        Ok(rows
            .connections
            .into_iter()
            .filter(|r| r.kind == "remote")
            .map(|r| r.id)
            .collect())
    }

    /// Atomic replace through a temporary file in the same directory, POSIX mode `0600`.
    fn write(&self, file: &Sidecar) -> Result<(), TransportStoreError> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|_| TransportStoreError::Io)?;
        if bytes.len() > MAX_BYTES {
            return Err(TransportStoreError::TooLarge);
        }
        fs::create_dir_all(&self.dir).map_err(|_| TransportStoreError::Io)?;
        let mut tmp = tempfile::Builder::new()
            .prefix(".connection-transport-")
            .tempfile_in(&self.dir)
            .map_err(|_| TransportStoreError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tmp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| TransportStoreError::Io)?;
        }
        tmp.write_all(&bytes).map_err(|_| TransportStoreError::Io)?;
        tmp.as_file()
            .sync_all()
            .map_err(|_| TransportStoreError::Io)?;
        tmp.persist(self.path())
            .map_err(|_| TransportStoreError::Io)?;
        Ok(())
    }
}

/// Reads at most `MAX_BYTES + 1` bytes, so an oversized file is recognised without reading all of it.
fn read_capped(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Spec §3.2: a remote row whose origin host is a `*.ts.net` name or a literal in a Tailscale range uses
/// Tailscale, every other row the direct path; no confirmation. A stored origin whose host fails spec §4.4 gets the
/// direct path (the check then refuses it with `host-invalid`).
fn derived_default(connection: &Connection) -> TransportEntry {
    let tailscale = connection.kind == Kind::Remote
        && match HostInput::from_origin(&connection.origin) {
            Ok((host @ HostInput::Name(_), _)) => host.is_ts_net(),
            Ok((HostInput::Ip(ip), _)) => is_tailnet(ip),
            Ok((HostInput::Localhost, _)) | Err(_) => false,
        };
    TransportEntry::new(if tailscale {
        Transport::Tailscale
    } else {
        Transport::Direct
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The interleaving of review Minor 1: a reader saw corrupt bytes, then a writer replaced the file with a good
    /// sidecar before the reader got the lock. The move must not happen.
    #[test]
    fn quarantine_skips_a_file_that_changed_since_it_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = TransportStore::open(dir.path());
        fs::write(store.path(), b"{ corrupt").unwrap();
        let Loaded::Corrupt(seen) = store.load() else {
            panic!("expected a corrupt sidecar")
        };
        let good = br#"{"version":1,"connections":{}}"#;
        fs::write(store.path(), good).unwrap();
        assert!(matches!(store.quarantine(&seen), Quarantine::Changed));
        assert_eq!(fs::read(store.path()).unwrap(), good);
        assert!(matches!(store.read_settled(), Loaded::Current(_)));
        // Gone in between: changed as well, nothing to move.
        fs::remove_file(store.path()).unwrap();
        assert!(matches!(store.quarantine(&seen), Quarantine::Changed));
        // Still the bytes that were read: moved aside.
        fs::write(store.path(), b"{ corrupt").unwrap();
        assert!(matches!(store.quarantine(&seen), Quarantine::Moved));
        assert!(!store.path().exists());
        let copies = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(copies, 1);
    }
}
