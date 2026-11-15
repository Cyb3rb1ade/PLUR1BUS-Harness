//! `secrets/file-backend.ts`: ADR-005's headless fallback, AES-256-GCM entries in `state/secrets/store.json` with the key
//! file `store.key` beside it.
//!
//! The format is the TypeScript one, `plur1bus.secrets-file/1`, read and written by both implementations: each entry has
//! its own random 96-bit nonce, and its AAD binds the schema id and the entry's name (`schema NUL name`), so a ciphertext
//! moved to another name does not decrypt. Metadata and the description sit outside the ciphertext. Every failure to
//! authenticate is `corrupt`: nothing partial or empty is ever returned, and the key is never regenerated over existing
//! entries (that would silently orphan them). What this does not defend: anyone who can read both files as this user, and
//! whole-entry rollback to an older valid copy.
//!
//! The document is held as [`Json`], so members keep JavaScript's order and a member this version does not know survives a
//! rewrite: with the same random draws the bytes written here are the bytes `JSON.stringify` writes there (the vectors of
//! `fixtures/parity/secrets-store/file-backend.json` compare the files).
//!
//! Not the same as TypeScript, on purpose: nothing (the helper process of the TypeScript core is a separate module).
//! Not the same, by nature: a file that only `JSON.parse` can read (a lone surrogate escape, a number outside f64) is
//! `unreadable-store` here; `updatedBy` of another type than string is ignored in the metadata.
use super::backend::{compare_names, iso_timestamp, SecretBackend};
use super::error::{SecretError, SecretErrorCode};
use super::jsdoc::{JsObject, Json};
use super::types::{
    check_description, is_secret_name, next_description, BackendKind, BackendProbe, SecretMeta,
};
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The schema id of the file, also the first part of every entry's AAD.
pub const FILE_SCHEMA: &str = "plur1bus.secrets-file/1";
/// At most this many tombstones are kept; the oldest go first (a core that never had a keyring would otherwise record
/// every delete forever).
pub const MAX_TOMBSTONES: usize = 512;
const KEY_BYTES: usize = 32;
/// GCM's native 96-bit nonce, fresh random per write of an entry.
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Where the random bytes come from (`FileBackendOptions.random`): the key and every nonce. A test scripts it.
pub type RandomBytes = Box<dyn FnMut(&mut [u8]) -> io::Result<()> + Send>;

/// What an operation can fail with before it is reduced to a [`SecretError`] (`serial` of the TypeScript backend: whatever
/// is not already a `SecretError` becomes `storage` with a code, so no platform text leaves the backend).
enum Fail {
    Secret(SecretError),
    Io(io::Error),
    /// Something thrown that has no `code` (a `RangeError` for an invalid time value): `<what> failed (error)`.
    Thrown,
}

impl From<SecretError> for Fail {
    fn from(e: SecretError) -> Fail {
        Fail::Secret(e)
    }
}

impl From<io::Error> for Fail {
    fn from(e: io::Error) -> Fail {
        Fail::Io(e)
    }
}

fn reduce(fail: Fail, what: &str) -> SecretError {
    match fail {
        Fail::Secret(e) => e,
        Fail::Io(e) => SecretError::storage_failed(what, io_code(&e)),
        Fail::Thrown => SecretError::storage_failed(what, "error"),
    }
}

/// The `code` Node gives the same failure (`ENOENT`, `EACCES`, ...); `error` when there is no telling.
pub fn io_code(e: &io::Error) -> &'static str {
    // The numbers below are the same on Linux and macOS; everything else goes by kind.
    #[cfg(unix)]
    match e.raw_os_error() {
        Some(1) => return "EPERM",
        Some(2) => return "ENOENT",
        Some(5) => return "EIO",
        Some(13) => return "EACCES",
        Some(16) => return "EBUSY",
        Some(17) => return "EEXIST",
        Some(18) => return "EXDEV",
        Some(20) => return "ENOTDIR",
        Some(21) => return "EISDIR",
        Some(22) => return "EINVAL",
        Some(23) => return "ENFILE",
        Some(24) => return "EMFILE",
        Some(28) => return "ENOSPC",
        Some(30) => return "EROFS",
        _ => {}
    }
    match e.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        io::ErrorKind::StorageFull => "ENOSPC",
        io::ErrorKind::ReadOnlyFilesystem => "EROFS",
        io::ErrorKind::InvalidFilename => "ENAMETOOLONG",
        _ => "error",
    }
}

fn corrupt(why: &str, name: Option<&str>) -> SecretError {
    SecretError::with_detail(
        SecretErrorCode::Corrupt,
        format!("encrypted secret store is corrupt ({why}); refusing to continue"),
        match name {
            Some(name) => json!({ "why": why, "name": name }),
            None => json!({ "why": why }),
        },
    )
}

/// `Buffer.from(text, "base64")`: Node decodes leniently. Characters outside both alphabets (the standard one and the
/// URL-safe one) are skipped, the first `=` ends the input, and a last group of two or three characters gives one or two
/// bytes (a single left-over character gives none). Node looks at the low byte of every UTF-16 code unit, so U+0144 counts
/// as `D` and the first half of an emoji (U+D83D) as `=`. `fixtures/parity/secrets-store/file-backend.json` pins it.
pub fn node_base64_decode(text: &str) -> Vec<u8> {
    let mut sextets = Vec::with_capacity(text.len());
    for unit in text.encode_utf16() {
        let byte = (unit & 0xff) as u8;
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        sextets.push(value);
    }
    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    for group in sextets.chunks(4) {
        if group.len() >= 2 {
            out.push((group[0] << 2) | (group[1] >> 4));
        }
        if group.len() >= 3 {
            out.push((group[1] << 4) | (group[2] >> 2));
        }
        if group.len() == 4 {
            out.push((group[2] << 6) | group[3]);
        }
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `readFileSync(path, "utf8")`: bytes that are not UTF-8 become U+FFFD.
fn read_utf8(path: &Path) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

/// `existsSync(path)`: false for anything that cannot be seen.
fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// The core's `securePath` for a file that exists: `chmod 0600` on POSIX. On Windows a file is created with its protected
/// DACL ([`plur1bus_audit::create_new_private`]) and keeps it through the rename, so nothing is left to do.
fn secure_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `secure(dir, { mode: 0o700 })`: `0700` on POSIX, the protected
/// user-and-SYSTEM DACL on Windows.
fn ensure_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        fs::create_dir_all(dir)?;
        let sid = plur1bus_rpc::win::user_sid()?;
        plur1bus_rpc::win::set_path_dacl(dir, &plur1bus_rpc::acl::run_dir_sddl(&sid))?;
    }
    #[cfg(not(any(unix, windows)))]
    fs::create_dir_all(dir)?;
    Ok(())
}

/// The parsed file. `root` is the whole document, so what this version does not know is written back as it was read.
struct Doc {
    root: JsObject,
}

impl Doc {
    fn empty() -> Doc {
        let mut root = JsObject::new();
        root.set("schema", Json::from(FILE_SCHEMA));
        root.set("entries", Json::Object(JsObject::new()));
        Doc { root }
    }

    fn entries(&self) -> &JsObject {
        // `read_doc` only lets a document through whose `entries` is an object.
        static EMPTY: std::sync::OnceLock<JsObject> = std::sync::OnceLock::new();
        self.root
            .get("entries")
            .and_then(Json::as_object)
            .unwrap_or_else(|| EMPTY.get_or_init(JsObject::new))
    }

    fn entries_mut(&mut self) -> Option<&mut JsObject> {
        self.root.get_mut("entries").and_then(Json::as_object_mut)
    }

    fn has(&self, name: &str) -> bool {
        self.entries().has(name)
    }

    fn entry(&self, name: &str) -> Option<&JsObject> {
        self.entries().get(name).and_then(Json::as_object)
    }

    fn tombstones(&self) -> Option<&JsObject> {
        self.root.get("tombstones").and_then(Json::as_object)
    }

    /// `delete doc.tombstones[name]`, and the member itself once it is empty. False when there was no such tombstone.
    fn drop_tombstone(&mut self, name: &str) -> bool {
        let Some(Json::Object(tombstones)) = self.root.get_mut("tombstones") else {
            return false;
        };
        if tombstones.remove(name).is_none() {
            return false;
        }
        if tombstones.is_empty() {
            self.root.remove("tombstones");
        }
        true
    }
}

fn string_member<'a>(object: &'a JsObject, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Json::as_str)
}

/// A member that is a non-empty string (`e.updatedBy ? ... : {}`).
fn truthy_string(object: &JsObject, key: &str) -> Option<String> {
    string_member(object, key)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn meta_of(name: &str, entry: &JsObject) -> SecretMeta {
    SecretMeta {
        name: name.to_owned(),
        backend: BackendKind::File,
        created_at: string_member(entry, "createdAt")
            .unwrap_or_default()
            .to_owned(),
        updated_at: string_member(entry, "updatedAt")
            .unwrap_or_default()
            .to_owned(),
        updated_by: truthy_string(entry, "updatedBy"),
        description: truthy_string(entry, "description"),
    }
}

/// `createFileBackend(options)`.
pub struct FileBackend {
    dir: PathBuf,
    max_tombstones: usize,
    random: RandomBytes,
}

impl FileBackend {
    /// A backend over `dir` (`<home>/state/secrets`) with the operating system's randomness.
    pub fn new(dir: impl Into<PathBuf>) -> FileBackend {
        FileBackend {
            dir: dir.into(),
            max_tombstones: MAX_TOMBSTONES,
            random: Box::new(|out| {
                getrandom::fill(out).map_err(|_| io::Error::other("no entropy"))
            }),
        }
    }

    /// The same backend with another source of random bytes (the key and the nonces).
    pub fn with_random(mut self, random: RandomBytes) -> FileBackend {
        self.random = random;
        self
    }

    /// The same backend with another bound of tombstones (`maxTombstones`).
    pub fn with_max_tombstones(mut self, max: usize) -> FileBackend {
        self.max_tombstones = max;
        self
    }

    fn store_path(&self) -> PathBuf {
        self.dir.join("store.json")
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("store.key")
    }

    fn read_doc(&self) -> Result<Doc, Fail> {
        let path = self.store_path();
        if !exists(&path) {
            return Ok(Doc::empty());
        }
        let parsed = read_utf8(&path)
            .ok()
            .and_then(|text| Json::parse(&text).ok());
        let Some(raw) = parsed else {
            return Err(corrupt("unreadable-store", None).into());
        };
        let Json::Object(root) = raw else {
            return Err(corrupt("bad-schema", None).into());
        };
        let entries = match (string_member(&root, "schema"), root.get("entries")) {
            (Some(FILE_SCHEMA), Some(Json::Object(entries))) => entries,
            _ => return Err(corrupt("bad-schema", None).into()),
        };
        for (name, entry) in entries.iter() {
            let well_formed = is_secret_name(name)
                && entry.as_object().is_some_and(|e| {
                    ["createdAt", "updatedAt", "nonce", "ct", "tag"]
                        .iter()
                        .all(|key| string_member(e, key).is_some())
                        && e.get("description").is_none_or(|d| d.as_str().is_some())
                });
            if !well_formed {
                return Err(corrupt("bad-entry", Some(name)).into());
            }
        }
        if let Some(tombstones) = root.get("tombstones") {
            let Some(tombstones) = tombstones.as_object() else {
                return Err(corrupt("bad-tombstones", None).into());
            };
            for (name, at) in tombstones.iter() {
                if !is_secret_name(name) || at.as_str().is_none() {
                    return Err(corrupt("bad-tombstones", Some(name)).into());
                }
            }
        }
        Ok(Doc { root })
    }

    fn read_key(&self) -> Result<Option<Vec<u8>>, Fail> {
        let path = self.key_path();
        if !exists(&path) {
            return Ok(None);
        }
        let text = read_utf8(&path)?;
        let key = node_base64_decode(text.trim_matches(crate::js::is_js_space));
        if key.len() != KEY_BYTES {
            return Err(corrupt("bad-key", None).into());
        }
        Ok(Some(key))
    }

    /// Reads the key; creates it only when there is nothing yet to orphan.
    fn key(&mut self, doc: &Doc, create: bool) -> Result<Vec<u8>, Fail> {
        let empty = doc.entries().is_empty();
        let key = match self.read_key() {
            Ok(key) => key,
            // A crash between creating the key file and writing it leaves an empty or short file. With nothing to
            // orphan it is safe to start over; with entries it stays corrupt.
            Err(Fail::Secret(e)) if create && empty && e.code == SecretErrorCode::Corrupt => {
                match fs::remove_file(self.key_path()) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
                    _ => None,
                }
            }
            Err(other) => return Err(other),
        };
        if let Some(key) = key {
            return Ok(key);
        }
        if !empty || !create {
            return Err(corrupt("key-missing", None).into());
        }
        ensure_dir(&self.dir)?;
        let mut fresh = vec![0u8; KEY_BYTES];
        (self.random)(&mut fresh)?;
        let path = self.key_path();
        // Created new and private before any key byte is written.
        let mut file = plur1bus_audit::create_new_private(&path)
            .map_err(|e| SecretError::storage_failed("creating the key file", io_code(&e)))?;
        let written = file
            .write_all(format!("{}\n", base64_encode(&fresh)).as_bytes())
            .and_then(|()| file.sync_all());
        drop(file);
        if let Err(e) = written {
            let _ = fs::remove_file(&path);
            return Err(SecretError::storage_failed("creating the key file", io_code(&e)).into());
        }
        Ok(fresh)
    }

    fn write_doc(&self, doc: &Doc) -> Result<(), Fail> {
        ensure_dir(&self.dir)?;
        let mut suffix = [0u8; 6];
        getrandom::fill(&mut suffix).map_err(|_| io::Error::other("no entropy"))?;
        let hex: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
        let tmp = self
            .dir
            .join(format!("store.json.{}.{hex}.tmp", std::process::id()));
        let store = self.store_path();
        let failed = |e: &io::Error| -> Fail {
            SecretError::storage_failed("writing the encrypted store", io_code(e)).into()
        };
        // Restricted before any content exists.
        let mut file = plur1bus_audit::create_new_private(&tmp).map_err(|e| failed(&e))?;
        let text = Json::Object(doc.root.clone()).stringify();
        let written = file
            .write_all(text.as_bytes())
            .and_then(|()| file.sync_all());
        drop(file);
        if let Err(e) = written.and_then(|()| fs::rename(&tmp, &store)) {
            let _ = fs::remove_file(&tmp);
            return Err(failed(&e));
        }
        secure_file(&store)?;
        Ok(())
    }

    fn decrypt(&mut self, doc: &Doc, name: &str) -> Result<String, Fail> {
        let key = self.key(doc, false)?;
        let failed = || Fail::Secret(corrupt("authentication-failed", Some(name)));
        let entry = doc.entry(name).ok_or_else(failed)?;
        let member = |key: &str| node_base64_decode(string_member(entry, key).unwrap_or_default());
        let (nonce, tag, mut sealed) = (member("nonce"), member("tag"), member("ct"));
        if nonce.len() != NONCE_BYTES || tag.len() != TAG_BYTES {
            return Err(failed());
        }
        sealed.extend_from_slice(&tag);
        let cipher = cipher(&key).ok_or_else(failed)?;
        let nonce = Nonce::try_assume_unique_for_key(&nonce).map_err(|_| failed())?;
        let plain = cipher
            .open_in_place(nonce, Aad::from(aad(name)), &mut sealed)
            .map_err(|_| failed())?;
        // `Buffer.toString("utf8")`: bytes that are not UTF-8 become U+FFFD.
        Ok(String::from_utf8_lossy(plain).into_owned())
    }

    fn put_inner(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, Fail> {
        let mut doc = self.read_doc()?;
        let existing = doc.has(name);
        let stored = doc
            .entry(name)
            .and_then(|e| string_member(e, "description"))
            .map(str::to_owned);
        let kept = next_description(stored.as_deref(), description).filter(|text| !text.is_empty());
        // The text is checked, not replaced: what is stored is what was given (or kept).
        check_description(
            next_description(stored.as_deref(), description).as_deref(),
            Some(value),
        )?;
        if let (Some(text), true) = (&kept, existing) {
            let previous = self.decrypt(&doc, name)?;
            if let Some(register) = register {
                register(&previous);
            }
            check_description(Some(text), Some(&previous))?;
        }
        let key = self.key(&doc, true)?;
        let mut nonce = [0u8; NONCE_BYTES];
        (self.random)(&mut nonce)?;
        let mut sealed = value.as_bytes().to_vec();
        let tag = cipher(&key)
            .and_then(|cipher| {
                cipher
                    .seal_in_place_separate_tag(
                        Nonce::assume_unique_for_key(nonce),
                        Aad::from(aad(name)),
                        &mut sealed,
                    )
                    .ok()
            })
            .ok_or(Fail::Thrown)?;
        let at = iso_timestamp(now_ms).map_err(|_| Fail::Thrown)?;
        let created_at = doc
            .entry(name)
            .and_then(|e| string_member(e, "createdAt"))
            .map_or_else(|| at.clone(), str::to_owned);
        doc.drop_tombstone(name);
        let updated_by = updated_by.filter(|by| !by.is_empty());
        let mut entry = JsObject::new();
        entry.set("createdAt", Json::from(created_at.clone()));
        entry.set("updatedAt", Json::from(at.clone()));
        if let Some(by) = updated_by {
            entry.set("updatedBy", Json::from(by));
        }
        if let Some(text) = &kept {
            entry.set("description", Json::from(text.clone()));
        }
        entry.set("nonce", Json::from(base64_encode(&nonce)));
        entry.set("ct", Json::from(base64_encode(&sealed)));
        entry.set("tag", Json::from(base64_encode(tag.as_ref())));
        let Some(entries) = doc.entries_mut() else {
            return Err(corrupt("bad-schema", None).into());
        };
        entries.set(name, Json::Object(entry));
        self.write_doc(&doc)?;
        Ok(SecretMeta {
            name: name.to_owned(),
            backend: BackendKind::File,
            created_at,
            updated_at: at,
            updated_by: updated_by.map(str::to_owned),
            description: kept,
        })
    }

    fn describe_inner(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, Fail> {
        let mut doc = self.read_doc()?;
        if !doc.has(name) {
            return Err(SecretError::not_found().into());
        }
        let value = self.decrypt(&doc, name)?;
        if let Some(register) = register {
            register(&value);
        }
        let text = check_description(Some(description), Some(&value))?.unwrap_or_default();
        let at = iso_timestamp(now_ms).map_err(|_| Fail::Thrown)?;
        let entry = match doc.entries_mut().and_then(|entries| entries.get_mut(name)) {
            Some(Json::Object(entry)) => entry,
            _ => return Err(corrupt("bad-entry", Some(name)).into()),
        };
        entry.set("updatedAt", Json::from(at));
        if let Some(by) = updated_by.filter(|by| !by.is_empty()) {
            entry.set("updatedBy", Json::from(by));
        }
        if text.is_empty() {
            entry.remove("description");
        } else {
            entry.set("description", Json::from(text));
        }
        let meta = meta_of(name, entry);
        self.write_doc(&doc)?;
        Ok(meta)
    }

    fn delete_inner(&mut self, name: &str, tombstone_at_ms: Option<i64>) -> Result<bool, Fail> {
        let mut doc = self.read_doc()?;
        if !doc.has(name) {
            return Ok(false);
        }
        if let Some(entries) = doc.entries_mut() {
            entries.remove(name);
        }
        if let Some(at_ms) = tombstone_at_ms {
            let at = iso_timestamp(at_ms).map_err(|_| Fail::Thrown)?;
            let mut tombstones = doc.tombstones().cloned().unwrap_or_default();
            tombstones.set(name, Json::from(at));
            if tombstones.len() > self.max_tombstones {
                // The oldest go first; `sort` is stable, so equal times leave in the order of the document.
                let mut names: Vec<(String, String)> = tombstones
                    .iter()
                    .map(|(n, at)| (n.to_owned(), at.as_str().unwrap_or_default().to_owned()))
                    .collect();
                names.sort_by(|a, b| crate::js::compare_utf16(&a.1, &b.1));
                let excess = names.len() - self.max_tombstones;
                for (old, _) in names.into_iter().take(excess) {
                    tombstones.remove(&old);
                }
            }
            doc.root.set("tombstones", Json::Object(tombstones));
        }
        self.write_doc(&doc)?;
        Ok(true)
    }
}

fn aad(name: &str) -> Vec<u8> {
    format!("{FILE_SCHEMA}\u{0}{name}").into_bytes()
}

fn cipher(key: &[u8]) -> Option<LessSafeKey> {
    UnboundKey::new(&AES_256_GCM, key)
        .ok()
        .map(LessSafeKey::new)
}

impl SecretBackend for FileBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::File
    }

    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        let checked: Result<(), Fail> = ensure_dir(&self.dir)
            .map_err(Fail::from)
            .and_then(|()| self.read_doc().map(|_| ()));
        Ok(match checked {
            Ok(()) => BackendProbe {
                available: true,
                reason: None,
            },
            Err(Fail::Secret(e)) => BackendProbe {
                available: false,
                reason: Some(e.code.as_str().to_owned()),
            },
            Err(_) => BackendProbe {
                available: false,
                reason: Some("dir-not-writable".to_owned()),
            },
        })
    }

    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError> {
        let read = |backend: &mut FileBackend| -> Result<Option<String>, Fail> {
            let doc = backend.read_doc()?;
            if !doc.has(name) {
                return Ok(None);
            }
            backend.decrypt(&doc, name).map(Some)
        };
        read(self).map_err(|fail| reduce(fail, "reading the encrypted store"))
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
        self.put_inner(name, value, now_ms, updated_by, description, register)
            .map_err(|fail| reduce(fail, "writing the encrypted store"))
    }

    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.describe_inner(name, description, now_ms, updated_by, register)
            .map_err(|fail| reduce(fail, "describing the encrypted store"))
    }

    fn delete(&mut self, name: &str, tombstone_at_ms: Option<i64>) -> Result<bool, SecretError> {
        self.delete_inner(name, tombstone_at_ms)
            .map_err(|fail| reduce(fail, "deleting from the encrypted store"))
    }

    fn tombstones(&mut self) -> Option<Result<BTreeMap<String, String>, SecretError>> {
        Some(
            self.read_doc()
                .map(|doc| {
                    doc.tombstones()
                        .map(|tombstones| {
                            tombstones
                                .iter()
                                .map(|(name, at)| {
                                    (name.to_owned(), at.as_str().unwrap_or_default().to_owned())
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .map_err(|fail| reduce(fail, "reading the encrypted store")),
        )
    }

    fn clear_tombstone(&mut self, name: &str) -> Option<Result<(), SecretError>> {
        let clear = |backend: &mut FileBackend| -> Result<(), Fail> {
            let mut doc = backend.read_doc()?;
            if doc.drop_tombstone(name) {
                backend.write_doc(&doc)?;
            }
            Ok(())
        };
        Some(clear(self).map_err(|fail| reduce(fail, "writing the encrypted store")))
    }

    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        let doc = self
            .read_doc()
            .map_err(|fail| reduce(fail, "listing the encrypted store"))?;
        let mut metas: Vec<SecretMeta> = doc
            .entries()
            .iter()
            .filter_map(|(name, entry)| entry.as_object().map(|e| meta_of(name, e)))
            .collect();
        metas.sort_by(|a, b| compare_names(&a.name, &b.name));
        Ok(metas)
    }
}
