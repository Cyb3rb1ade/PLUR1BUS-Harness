//! `secrets/keyring-backend.ts`: the OS keychain backend (macOS Keychain, Windows Credential Manager, the Secret Service).
//!
//! A keyring cannot enumerate, so the names and timestamps (never a value) live in one extra entry, the index
//! (`plur1bus.secrets-index/1` under the account `__plur1bus-index__`). The service name is per home, so two homes of one
//! OS user do not see each other's secrets. The value and the index are two writes: when the second fails, the first is
//! undone, so a failed `put` leaves the old state.
//!
//! The keyring itself is behind [`Keyring`]: the operating system's one is an adapter of its own, a test hands in a fake.
//! This module makes the same calls in the same order as the TypeScript backend (the vectors of
//! `fixtures/parity/secrets-store/keyring-backend.json` record every call on a fake keyring) and writes the same index
//! text: the index is held as [`Json`], so its members keep JavaScript's order and a member this version does not know
//! survives a rewrite.
//!
//! Not the same as TypeScript (P4D-32):
//! - `put` with a time no date can hold fails before anything is written. TypeScript writes the value, then throws at
//!   `toISOString`, and the index never learns of the value.
//! - `list` and the answer of `describe` carry the known members of an entry. TypeScript spreads the whole entry, so a
//!   member the index was given from outside (`name`, `backend`, anything else) shows in its answer; `updatedBy` of another
//!   type than string is ignored here.
//! - An index that only `JSON.parse` can read (a lone surrogate escape, a number outside f64, nesting deeper than 128) is
//!   `unreadable-index` here.
use super::backend::{compare_names, iso_timestamp, SecretBackend};
use super::error::{SecretError, SecretErrorCode};
use super::jsdoc::{JsObject, Json};
use super::types::{
    check_description, is_secret_name, next_description, BackendKind, BackendProbe, SecretMeta,
};

/// The index's schema id.
pub const INDEX_SCHEMA: &str = "plur1bus.secrets-index/1";
/// The account that holds the index. Not a secret name (a name starts with a letter or a digit), so no secret can take it.
pub const INDEX_ACCOUNT: &str = "__plur1bus-index__";
/// The account `probe` reads.
pub const PROBE_ACCOUNT: &str = "__plur1bus-probe__";

/// What a keyring call failed with: the `code` property of what the platform layer threw, when it is a string. Platform
/// text never travels with it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyringFailure {
    /// A short code (`ENOENT`, a status name), or `None` (the message then says `error`).
    pub code: Option<String>,
}

/// One credential of the keyring (`KeyringEntry`).
pub trait KeyringEntry {
    /// The password, or `None` when there is no such credential.
    fn get_password(&mut self) -> Result<Option<String>, KeyringFailure>;

    /// Creates or replaces the credential.
    fn set_password(&mut self, password: &str) -> Result<(), KeyringFailure>;

    /// Removes the credential; true when there was one.
    fn delete_password(&mut self) -> Result<bool, KeyringFailure>;
}

/// The keyring (`KeyringModule`, with its loader).
pub trait Keyring: Send {
    /// `new Entry(service, account)`. An error is "the keyring is not available" (the module cannot be loaded, the entry
    /// cannot be made): whatever it carries, the backend answers `backend-unavailable`.
    fn entry(&self, service: &str, account: &str) -> Result<Box<dyn KeyringEntry>, KeyringFailure>;
}

fn unavailable() -> SecretError {
    SecretError::new(
        SecretErrorCode::BackendUnavailable,
        "the OS keyring is not available",
    )
}

fn corrupt(why: &str) -> SecretError {
    SecretError::new(
        SecretErrorCode::Corrupt,
        format!("keyring index is corrupt ({why}); refusing to continue"),
    )
}

/// `guarded(what, fn)`: what the keyring threw becomes `storage` with a code.
fn guarded<T>(what: &str, result: Result<T, KeyringFailure>) -> Result<T, SecretError> {
    result
        .map_err(|fail| SecretError::storage_failed(what, fail.code.as_deref().unwrap_or("error")))
}

fn string_member<'a>(object: &'a JsObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Json::as_str)
}

/// The index: `{ schema, entries: { name: { createdAt, updatedAt, updatedBy?, description? } } }`.
struct Index {
    root: JsObject,
}

impl Index {
    fn empty() -> Index {
        let mut root = JsObject::new();
        root.set("schema", Json::from(INDEX_SCHEMA));
        root.set("entries", Json::Object(JsObject::new()));
        Index { root }
    }

    /// `JSON.parse` and the shape check of `readIndex`.
    fn parse(raw: &str) -> Result<Index, SecretError> {
        let parsed = Json::parse(raw).map_err(|_| corrupt("unreadable-index"))?;
        let Json::Object(root) = parsed else {
            return Err(corrupt("bad-schema"));
        };
        if string_member(&root, "schema") != Some(INDEX_SCHEMA) {
            return Err(corrupt("bad-schema"));
        }
        let Some(entries) = root.get("entries").and_then(Json::as_object) else {
            return Err(corrupt("bad-schema"));
        };
        for (name, entry) in entries.iter() {
            let sound = is_secret_name(name)
                && entry.as_object().is_some_and(|e| {
                    string_member(e, "createdAt").is_some()
                        && string_member(e, "updatedAt").is_some()
                        && e.get("description").is_none_or(|d| d.as_str().is_some())
                });
            if !sound {
                return Err(corrupt("bad-entry"));
            }
        }
        Ok(Index { root })
    }

    fn entries(&self) -> &JsObject {
        // `parse` and `empty` only make an index whose `entries` is an object.
        static EMPTY: std::sync::OnceLock<JsObject> = std::sync::OnceLock::new();
        self.root
            .get("entries")
            .and_then(Json::as_object)
            .unwrap_or_else(|| EMPTY.get_or_init(JsObject::new))
    }

    fn entry(&self, name: &str) -> Option<&JsObject> {
        self.entries().get(name).and_then(Json::as_object)
    }

    /// `idx.entries[name] = { createdAt, updatedAt, updatedBy?, description? }`: the whole entry is replaced; an existing
    /// name keeps its place.
    fn set(&mut self, name: &str, meta: &SecretMeta) {
        let mut entry = JsObject::new();
        entry.set("createdAt", Json::from(meta.created_at.clone()));
        entry.set("updatedAt", Json::from(meta.updated_at.clone()));
        if let Some(by) = &meta.updated_by {
            entry.set("updatedBy", Json::from(by.clone()));
        }
        if let Some(text) = &meta.description {
            entry.set("description", Json::from(text.clone()));
        }
        if let Some(Json::Object(entries)) = self.root.get_mut("entries") {
            entries.set(name, Json::Object(entry));
        }
    }

    /// `delete idx.entries[name]`; whether the name was indexed.
    fn remove(&mut self, name: &str) -> bool {
        match self.root.get_mut("entries") {
            Some(Json::Object(entries)) => entries.remove(name).is_some(),
            _ => false,
        }
    }

    fn text(self) -> String {
        Json::Object(self.root).stringify()
    }
}

/// `{ name, backend: "keyring", ...entry }`, the known members.
fn meta_of(name: &str, entry: &JsObject) -> SecretMeta {
    SecretMeta {
        name: name.to_owned(),
        backend: BackendKind::Keyring,
        created_at: string_member(entry, "createdAt")
            .unwrap_or_default()
            .to_owned(),
        updated_at: string_member(entry, "updatedAt")
            .unwrap_or_default()
            .to_owned(),
        updated_by: string_member(entry, "updatedBy").map(str::to_owned),
        description: string_member(entry, "description").map(str::to_owned),
    }
}

/// The keyring backend of one service.
pub struct KeyringBackend {
    service: String,
    keyring: Box<dyn Keyring>,
}

impl KeyringBackend {
    /// A backend over `keyring` for the credentials of `service`.
    pub fn new(service: impl Into<String>, keyring: Box<dyn Keyring>) -> KeyringBackend {
        KeyringBackend {
            service: service.into(),
            keyring,
        }
    }

    /// `entry(account)`: any failure to make the entry is `backend-unavailable`.
    fn entry(&self, account: &str) -> Result<Box<dyn KeyringEntry>, SecretError> {
        self.keyring
            .entry(&self.service, account)
            .map_err(|_| unavailable())
    }

    fn read_index(&self) -> Result<Index, SecretError> {
        let mut entry = self.entry(INDEX_ACCOUNT)?;
        match guarded("reading the keyring index", entry.get_password())? {
            None => Ok(Index::empty()),
            Some(raw) => Index::parse(&raw),
        }
    }

    fn write_index(&self, index: Index) -> Result<(), SecretError> {
        let mut entry = self.entry(INDEX_ACCOUNT)?;
        guarded(
            "writing the keyring index",
            entry.set_password(&index.text()),
        )
    }
}

impl SecretBackend for KeyringBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Keyring
    }

    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        let reason = match self.entry(PROBE_ACCOUNT) {
            Err(_) => Some("keyring-unavailable"),
            Ok(mut entry) => entry.get_password().err().map(|_| "keyring-error"),
        };
        Ok(BackendProbe {
            available: reason.is_none(),
            reason: reason.map(str::to_owned),
        })
    }

    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError> {
        let mut entry = self.entry(name)?;
        guarded("reading from the keyring", entry.get_password())
    }

    fn put(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        let mut index = self.read_index()?;
        let mut entry = self.entry(name)?;
        let before = guarded("reading from the keyring", entry.get_password())?;
        let stored = index
            .entry(name)
            .and_then(|e| string_member(e, "description"));
        // The text is checked, not replaced: what is stored is what was given (or kept).
        let kept = next_description(stored, description);
        check_description(kept.as_deref(), Some(value))?;
        if let Some(before) = &before {
            if let Some(register) = register {
                register(before);
            }
            check_description(kept.as_deref(), Some(before))?;
        }
        // Before the write, not after it (P4D-32): a time no date can hold must not leave a value the index does not know.
        let at = iso_timestamp(now_ms)?;
        guarded("writing to the keyring", entry.set_password(value))?;
        let created_at = index
            .entry(name)
            .and_then(|e| string_member(e, "createdAt"))
            .map_or_else(|| at.clone(), str::to_owned);
        let meta = SecretMeta {
            name: name.to_owned(),
            backend: BackendKind::Keyring,
            created_at,
            updated_at: at,
            updated_by: updated_by.filter(|by| !by.is_empty()).map(str::to_owned),
            description: kept.filter(|text| !text.is_empty()),
        };
        index.set(name, &meta);
        if let Err(failed) = self.write_index(index) {
            // The value is back to what it was; when that fails too, the first failure is the one to report.
            let _ = match &before {
                Some(before) => entry.set_password(before),
                None => entry.delete_password().map(|_| ()),
            };
            return Err(failed);
        }
        Ok(meta)
    }

    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        let mut index = self.read_index()?;
        let mut entry = self.entry(name)?;
        let Some(value) = guarded("reading from the keyring", entry.get_password())? else {
            return Err(SecretError::not_found());
        };
        if let Some(register) = register {
            register(&value);
        }
        let text = check_description(Some(description), Some(&value))?;
        let at = iso_timestamp(now_ms)?;
        let created_at = index
            .entry(name)
            .and_then(|e| string_member(e, "createdAt"))
            .map_or_else(|| at.clone(), str::to_owned);
        let meta = SecretMeta {
            name: name.to_owned(),
            backend: BackendKind::Keyring,
            created_at,
            updated_at: at,
            updated_by: updated_by.filter(|by| !by.is_empty()).map(str::to_owned),
            description: text.filter(|text| !text.is_empty()),
        };
        index.set(name, &meta);
        self.write_index(index)?;
        Ok(meta)
    }

    /// The keyring keeps no tombstones: `tombstone_at_ms` is not used.
    fn delete(&mut self, name: &str, _tombstone_at_ms: Option<i64>) -> Result<bool, SecretError> {
        let mut index = self.read_index()?;
        let mut entry = self.entry(name)?;
        let removed = guarded("deleting from the keyring", entry.delete_password())?;
        let indexed = index.remove(name);
        if indexed {
            self.write_index(index)?;
        }
        Ok(removed || indexed)
    }

    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        let index = self.read_index()?;
        let mut metas: Vec<SecretMeta> = index
            .entries()
            .iter()
            .filter_map(|(name, entry)| entry.as_object().map(|e| meta_of(name, e)))
            .collect();
        metas.sort_by(|a, b| compare_names(&a.name, &b.name));
        Ok(metas)
    }
}
