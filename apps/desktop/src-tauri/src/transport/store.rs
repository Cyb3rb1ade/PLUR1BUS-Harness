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
/// defaults apply and every write is refused (spec §3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreMode {
    ReadWrite,
    ReadOnlyNewer,
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

impl std::fmt::Display for TransportStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ReadOnly => "transport-store-readonly",
            Self::NotRemote => "transport store: not a remote connection",
            Self::Connections => "transport store: connections.json is unreadable",
            Self::Io => "transport store: input/output error",
            Self::TooLarge => "transport store: file exceeds 1 MiB",
        })
    }
}

impl std::error::Error for TransportStoreError {}

#[derive(Serialize, Deserialize)]
struct Sidecar {
    version: u64,
    #[serde(default)]
    connections: BTreeMap<Uuid, TransportEntry>,
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
    /// Not readable, not a regular file, or a corrupt file that could not be moved aside.
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
        match self.load() {
            Loaded::Newer => StoreMode::ReadOnlyNewer,
            Loaded::Missing | Loaded::Current(_) | Loaded::Failed => StoreMode::ReadWrite,
        }
    }

    /// The stored entry, if any. A newer, unreadable or corrupt sidecar has none.
    pub fn get(&self, id: Uuid) -> Option<TransportEntry> {
        match self.load() {
            Loaded::Current(file) => file.connections.get(&id).cloned(),
            Loaded::Missing | Loaded::Newer | Loaded::Failed => None,
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
        file.connections.insert(id, entry);
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
    /// changed.
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

    fn load_for_write(&self) -> Result<Sidecar, TransportStoreError> {
        match self.load() {
            Loaded::Missing => Ok(Sidecar::default()),
            Loaded::Current(file) => Ok(file),
            Loaded::Newer => Err(TransportStoreError::ReadOnly),
            Loaded::Failed => Err(TransportStoreError::Io),
        }
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
            return self.quarantine();
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return self.quarantine();
        };
        match value.get("version").and_then(Value::as_u64) {
            Some(VERSION) => match serde_json::from_value::<Sidecar>(value) {
                Ok(file) => Loaded::Current(file),
                Err(_) => self.quarantine(),
            },
            Some(v) if v > VERSION => Loaded::Newer,
            _ => self.quarantine(),
        }
    }

    /// Moves a corrupt sidecar aside as `connection-transport.json.corrupt-<ms>-<uuid>`; `connections.json` is never
    /// touched.
    fn quarantine(&self) -> Loaded {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let target = self
            .dir
            .join(format!("{FILE}.corrupt-{ms}-{}", Uuid::now_v7()));
        match fs::rename(self.path(), target) {
            Ok(()) => Loaded::Missing,
            Err(_) => Loaded::Failed,
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
/// Tailscale, every other row the direct path; no confirmation.
fn derived_default(connection: &Connection) -> TransportEntry {
    let (host, _) = HostInput::from_origin(&connection.origin);
    let tailscale = connection.kind == Kind::Remote
        && match host {
            HostInput::Name(_) => host.is_ts_net(),
            HostInput::Ip(ip) => is_tailnet(ip),
            HostInput::Localhost => false,
        };
    TransportEntry::new(if tailscale {
        Transport::Tailscale
    } else {
        Transport::Direct
    })
}
