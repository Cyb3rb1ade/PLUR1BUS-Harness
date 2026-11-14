//! `identity/desktop-attach.ts`: `state/desktop-attach.db`, the one-use codes a desktop app is attached with and the hashed
//! bearer credentials it then presents (P4-12 task 5). A library: nothing in the front door calls it yet.
//!
//! A code and a credential are stored as SHA-256 only. A code binds a person, the kind `desktop` and the person's version
//! at issue; redeeming it spends it atomically (`DELETE ... RETURNING`), whatever happens afterwards. The device store
//! ([`DeviceStore`], `packages/remote-access` in TypeScript, a trait here) stays the authority: a credential is good only
//! while its device is unrevoked, of platform `desktop`, and its person's version is the one the credential was issued
//! under. The audit line comes before the effect: a failing sink leaves no code and no credential.
//!
//! The file is opened as TypeScript opens it (ruling R4): private directory and file (a path that is not a regular file is
//! refused), only `busy_timeout` set (foreign keys on, as on every `node:sqlite` connection), the journal mode and
//! `user_version` left alone, `CREATE TABLE IF NOT EXISTS` with the
//! TypeScript texts, and the two option columns of `codes` added to a file from before them. The recorded sequences
//! (`fixtures/parity/identity-admin/attach.json`) are replayed by `admin_vectors.rs`.
use super::codes::RandomSource;
use super::sha256_hex;
use super::store::create_private;
use crate::js::utf16;
use crate::logs::query::base64url_encode;
use crate::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_store::rusqlite::{self, OptionalExtension};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The tables, as the TypeScript constructor creates them on every open.
const TABLES: &str = "      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;\n      CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY,device_id TEXT NOT NULL UNIQUE,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;";

/// `DESKTOP_SCOPES`: the initial desktop scope pending Owner confirmation. Neither role inheritance nor a browser request
/// can widen it.
pub const DESKTOP_SCOPES: [&str; 13] = [
    "chat:read",
    "chat:write",
    "chat:delete",
    "agent.list",
    "agent.read",
    "agent.use",
    "sessions.read",
    "admin.sessions.read",
    "admin.sessions.write",
    "admin.sessions.transcript",
    "models.read",
    "activity.read",
    "device.list",
];
/// `DESKTOP_EXTENSION_SCOPES`: Owner-approved opt-in; only a privileged CLI pairing grant can add these actions.
pub const DESKTOP_EXTENSION_SCOPES: [&str; 2] = ["extensions.read", "extensions.manage"];
/// `DESKTOP_IMPORT_SCOPES`.
pub const DESKTOP_IMPORT_SCOPES: [&str; 2] = ["imports.read", "imports.manage"];

/// A code lives ten minutes.
const CODE_TTL_MS: i64 = 600_000;
/// A credential lives 30 days.
const CREDENTIAL_TTL_MS: i64 = 30 * 86_400_000;
/// At most this many unexpired codes at a time.
const MAX_CODES: i64 = 256;

/// `DeviceErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceErrorCode {
    /// `invalid`
    Invalid,
    /// `not-found`
    NotFound,
    /// `denied`
    Denied,
    /// `revoked`
    Revoked,
    /// `conflict`
    Conflict,
    /// `storage`
    Storage,
}

impl DeviceErrorCode {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceErrorCode::Invalid => "invalid",
            DeviceErrorCode::NotFound => "not-found",
            DeviceErrorCode::Denied => "denied",
            DeviceErrorCode::Revoked => "revoked",
            DeviceErrorCode::Conflict => "conflict",
            DeviceErrorCode::Storage => "storage",
        }
    }
    /// The code named exactly `s`.
    pub fn parse(s: &str) -> Option<DeviceErrorCode> {
        [
            DeviceErrorCode::Invalid,
            DeviceErrorCode::NotFound,
            DeviceErrorCode::Denied,
            DeviceErrorCode::Revoked,
            DeviceErrorCode::Conflict,
            DeviceErrorCode::Storage,
        ]
        .into_iter()
        .find(|c| c.as_str() == s)
    }
}

/// What a method of the desktop attach store fails with.
#[derive(Debug)]
pub enum AttachError {
    /// `DeviceError`: the store's own refusals and whatever the device store answers.
    Device(DeviceErrorCode),
    /// The audit sink failed: the effect did not happen.
    Audit(String),
    /// SQLite or the file system failed and the TypeScript store does not catch it either.
    Sqlite(rusqlite::Error),
    /// The file could not be created or opened.
    Io(String),
}

impl From<rusqlite::Error> for AttachError {
    fn from(e: rusqlite::Error) -> Self {
        AttachError::Sqlite(e)
    }
}
impl From<StoreError> for AttachError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Sqlite(e) => AttachError::Sqlite(e),
            other => AttachError::Io(other.to_string()),
        }
    }
}
impl std::fmt::Display for AttachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttachError::Device(code) => write!(f, "device {}", code.as_str()),
            AttachError::Audit(e) => write!(f, "the action could not be audited: {e}"),
            AttachError::Sqlite(e) => write!(f, "sqlite: {e}"),
            AttachError::Io(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for AttachError {}

type Outcome<T> = Result<T, AttachError>;

fn denied() -> AttachError {
    AttachError::Device(DeviceErrorCode::Denied)
}

/// `Device` of the device store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    /// The device id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// Its platform; a desktop credential needs `desktop`.
    pub platform: String,
    /// Canonical base64 DER SubjectPublicKeyInfo, never a private key.
    pub public_key: String,
    /// SHA-256 of the key.
    pub fingerprint: String,
    /// When it was paired.
    pub paired_at: i64,
    /// When it was last seen.
    pub last_seen_at: i64,
    /// The person it was paired by.
    pub paired_by: String,
    /// The actions it may use.
    pub scope: Vec<String>,
    /// Whether it was revoked.
    pub revoked: bool,
    /// When.
    pub revoked_at: Option<i64>,
    /// By whom.
    pub revoked_by: Option<String>,
}

impl Device {
    /// The `Device` object of the TypeScript device store.
    pub fn to_json(&self) -> Value {
        let mut out = json!({ "id": self.id, "name": self.name, "platform": self.platform, "publicKey": self.public_key,
            "fingerprint": self.fingerprint, "pairedAt": self.paired_at, "lastSeenAt": self.last_seen_at, "pairedBy": self.paired_by,
            "scope": self.scope, "revoked": self.revoked });
        if let Some(at) = self.revoked_at {
            out["revokedAt"] = json!(at);
        }
        if let Some(by) = &self.revoked_by {
            out["revokedBy"] = json!(by);
        }
        out
    }
}

/// `PairDevice`: what a trusted pairing flow hands to the device store. `paired_by` and `scope` are server-established facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairDevice {
    /// The device's name.
    pub name: String,
    /// Its platform.
    pub platform: String,
    /// Its public key.
    pub public_key: String,
    /// The person.
    pub paired_by: String,
    /// The actions it may use.
    pub scope: Vec<String>,
}

/// The device store (`DeviceStore` of `packages/remote-access`): the revocation authority behind this store.
pub trait DeviceStore {
    /// Records a pairing; refuses a key it already knows (`conflict`, or `revoked`) or cannot read (`invalid`).
    fn record_pairing(&mut self, input: &PairDevice) -> Result<Device, DeviceErrorCode>;
    /// The device with this id, or `not-found`.
    fn get(&self, id: &str) -> Result<Device, DeviceErrorCode>;
}

/// The version of a person by id; `None` for an unknown or disabled one.
pub type PersonVersion = Box<dyn Fn(&str) -> Option<i64>>;

/// `DesktopAttachOptions`.
pub struct DesktopAttachOptions {
    /// `state/desktop-attach.db`.
    pub file: PathBuf,
    /// The device store.
    pub devices: Box<dyn DeviceStore>,
    /// Epoch milliseconds.
    pub now: Box<dyn Fn() -> i64>,
    /// The audit sink; its failure stops the action.
    pub audit: Box<dyn AuditSink>,
    /// The host's `securePath`, applied to the file.
    pub secure_path: Box<dyn Fn(&Path)>,
    /// The version of a person, `None` for an unknown or disabled one. Without the port every person is version 0.
    pub person_version: Option<PersonVersion>,
    /// Codes and credentials are drawn from here (32 bytes each).
    pub random: Box<dyn RandomSource>,
}

/// What `issue` returns: the code is handed out here once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedCode {
    /// The code, in the clear.
    pub code: String,
    /// When it lapses.
    pub expires_at: i64,
    /// The scope a device attached with it gets.
    pub scopes: Vec<String>,
}

impl IssuedCode {
    /// `{ code, kind: "desktop", expiresAt, scopes }`.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "kind": "desktop", "expiresAt": self.expires_at, "scopes": self.scopes })
    }
}

/// What `redeem` returns: the credential is handed out here once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attached {
    /// The recorded device.
    pub device: Device,
    /// The bearer credential, in the clear.
    pub token: String,
    /// When it lapses.
    pub expires_at: i64,
}

impl Attached {
    /// `{ device, token, expiresAt }`.
    pub fn to_json(&self) -> Value {
        json!({ "device": self.device.to_json(), "token": self.token, "expiresAt": self.expires_at })
    }
}

/// What `authenticate` and `resolve` return.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopSession {
    /// The device.
    pub device_id: String,
    /// The person it acts for.
    pub user_id: String,
    /// The desktop scopes the device store grants it.
    pub scopes: Vec<String>,
    /// When the credential lapses.
    pub expires_at: i64,
}

impl DesktopSession {
    /// `{ deviceId, userId, scopes, expiresAt }`.
    pub fn to_json(&self) -> Value {
        json!({ "deviceId": self.device_id, "userId": self.user_id, "scopes": self.scopes, "expiresAt": self.expires_at })
    }
}

fn digest(value: &str) -> String {
    sha256_hex(&[value.as_bytes()])
}

fn scopes(extensions: bool, imports: bool) -> Vec<String> {
    let mut out: Vec<String> = DESKTOP_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    if extensions {
        out.extend(DESKTOP_EXTENSION_SCOPES.iter().map(|s| (*s).to_owned()));
    }
    if imports {
        out.extend(DESKTOP_IMPORT_SCOPES.iter().map(|s| (*s).to_owned()));
    }
    out
}

/// `DesktopAttach`.
pub struct DesktopAttach {
    store: Store,
    o: DesktopAttachOptions,
}

impl DesktopAttach {
    /// Opens (creating) the store. A path that exists and is not a regular file (a symbolic link, a directory) is `storage`.
    pub fn open(o: DesktopAttachOptions) -> Outcome<DesktopAttach> {
        let io =
            |e: std::io::Error| AttachError::Io(format!("desktop attach store unavailable: {e}"));
        if let Some(parent) = o.file.parent().filter(|p| !p.as_os_str().is_empty()) {
            let mut dir = std::fs::DirBuilder::new();
            dir.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
            dir.create(parent).map_err(io)?;
        }
        match std::fs::symlink_metadata(&o.file) {
            Ok(meta) if !meta.file_type().is_file() => {
                return Err(AttachError::Device(DeviceErrorCode::Storage))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
        create_private(&o.file).map_err(io)?;
        (o.secure_path)(&o.file);
        let spec = OwnerSpec {
            store: StoreSpec::new("desktop-attach", 0),
            journal: Journal::Unchanged,
            schema: Schema::Unversioned,
            create: false,
        };
        let store = Store::open_owner(&o.file, &spec)?;
        let conn = store.conn();
        conn.execute_batch(TABLES)?;
        for column in ["extensions", "imports"] {
            let columns: Vec<String> = conn
                .prepare("PRAGMA table_info(codes)")?
                .query_map([], |row| row.get(1))?
                .collect::<rusqlite::Result<_>>()?;
            if !columns.iter().any(|c| c == column) {
                conn.execute_batch(&format!(
                    "ALTER TABLE codes ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                ))?;
            }
        }
        Ok(DesktopAttach { store, o })
    }

    /// `#version`: the person's version; an unknown or disabled person is `denied`.
    fn version(&self, id: &str) -> Outcome<i64> {
        match &self.o.person_version {
            None => Ok(0),
            Some(port) => port(id).ok_or_else(denied),
        }
    }

    /// 32 random bytes as unpadded base64url (43 characters).
    fn secret(&mut self) -> String {
        let mut bytes = [0u8; 32];
        self.o.random.fill_bytes(&mut bytes);
        base64url_encode(&bytes)
    }

    /// `#audit`: the person and the device are hashed (plain SHA-256 hex); "desktop" and the host are fixed labels.
    fn audit(&mut self, action: &str, user: &str, device: Option<&str>) -> Outcome<()> {
        let event = AuditEvent {
            at: (self.o.now)(),
            user: digest(user),
            host: "desktop-attach".to_owned(),
            action: action.to_owned(),
            target: device.map_or_else(|| "desktop".to_owned(), digest),
            detail: Vec::new(),
        };
        self.o.audit.append(&event).map_err(AttachError::Audit)
    }

    /// `issue`: a one-use code for a person, good for ten minutes. Issuing drops the lapsed codes first.
    pub fn issue(
        &mut self,
        user_id: &str,
        kind: &str,
        extensions: bool,
        imports: bool,
    ) -> Outcome<IssuedCode> {
        if kind != "desktop" || user_id.is_empty() {
            return Err(AttachError::Device(DeviceErrorCode::Invalid));
        }
        let version = self.version(user_id)?;
        let now = (self.o.now)();
        self.store
            .conn()
            .prepare_cached("DELETE FROM codes WHERE expires_at<=?")?
            .execute([now])?;
        let count: i64 =
            self.store
                .conn()
                .query_row("SELECT COUNT(*) AS n FROM codes", [], |row| row.get(0))?;
        if count >= MAX_CODES {
            return Err(denied());
        }
        let code = self.secret();
        let expires_at = now + CODE_TTL_MS;
        self.audit("device.attach.opened", user_id, None)?;
        self.store
            .conn()
            .prepare_cached("INSERT INTO codes(hash,user_id,kind,person_version,expires_at,extensions,imports) VALUES (?,?,?,?,?,?,?)")?
            .execute(rusqlite::params![digest(&code), user_id, kind, version, expires_at, i64::from(extensions), i64::from(imports)])?;
        Ok(IssuedCode {
            code,
            expires_at,
            scopes: scopes(extensions, imports),
        })
    }

    /// `redeem`: spends a code and records the device. The code is spent whatever happens next; a failed enrolment needs a
    /// new code.
    pub fn redeem(
        &mut self,
        code: &str,
        kind: &str,
        name: &str,
        public_key: &str,
    ) -> Outcome<Attached> {
        if utf16(code).len() != 43 || kind != "desktop" {
            return Err(denied());
        }
        // DELETE RETURNING spends the code atomically, including across process connections.
        let row: Option<(String, i64, i64, i64)> = self
            .store
            .conn()
            .prepare_cached("DELETE FROM codes WHERE hash=? AND kind=? AND expires_at>? RETURNING user_id,person_version,extensions,imports")?
            .query_row(rusqlite::params![digest(code), kind, (self.o.now)()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .optional()?;
        let Some((user_id, person_version, extensions, imports)) = row else {
            return Err(denied());
        };
        if self.version(&user_id)? != person_version {
            return Err(denied());
        }
        let device = self
            .o
            .devices
            .record_pairing(&PairDevice {
                name: name.to_owned(),
                platform: kind.to_owned(),
                public_key: public_key.to_owned(),
                paired_by: user_id,
                scope: scopes(extensions == 1, imports == 1),
            })
            .map_err(AttachError::Device)?;
        let token = self.secret();
        let expires_at = (self.o.now)() + CREDENTIAL_TTL_MS;
        self.audit(
            "device.attach.redeemed",
            &device.paired_by.clone(),
            Some(&device.id.clone()),
        )?;
        self.store
            .conn()
            .prepare_cached("INSERT INTO credentials VALUES (?,?,?,?)")?
            .execute(rusqlite::params![
                digest(&token),
                device.id,
                person_version,
                expires_at
            ])?;
        Ok(Attached {
            device,
            token,
            expires_at,
        })
    }

    /// `authenticate`: the session of a bearer credential.
    pub fn authenticate(&self, token: &str) -> Outcome<DesktopSession> {
        if utf16(token).len() != 43 {
            return Err(denied());
        }
        let device_id: Option<String> = self
            .store
            .conn()
            .prepare_cached("SELECT device_id FROM credentials WHERE hash=? AND expires_at>?")?
            .query_row(rusqlite::params![digest(token), (self.o.now)()], |row| {
                row.get(0)
            })
            .optional()?;
        self.resolve(&device_id.ok_or_else(denied)?)
    }

    /// `resolve`: the session of a device with a live credential. The device store is asked first: a device it does not
    /// know is its `not-found`, not this store's `denied`.
    pub fn resolve(&self, device_id: &str) -> Outcome<DesktopSession> {
        let row: Option<(i64, i64)> = self
            .store
            .conn()
            .prepare_cached("SELECT expires_at,person_version FROM credentials WHERE device_id=? AND expires_at>?")?
            .query_row(rusqlite::params![device_id, (self.o.now)()], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let d = self.o.devices.get(device_id).map_err(AttachError::Device)?;
        let Some((expires_at, person_version)) = row else {
            return Err(denied());
        };
        if d.revoked || d.platform != "desktop" || self.version(&d.paired_by)? != person_version {
            return Err(denied());
        }
        let granted = scopes(true, true)
            .into_iter()
            .filter(|s| d.scope.contains(s))
            .collect();
        Ok(DesktopSession {
            device_id: d.id,
            user_id: d.paired_by,
            scopes: granted,
            expires_at,
        })
    }

    /// The connection, for the replay's table dumps and its raw statements.
    #[cfg(test)]
    pub(crate) fn conn(&self) -> &rusqlite::Connection {
        self.store.conn()
    }
}
