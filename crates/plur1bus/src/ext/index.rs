//! `skills/index.json` written from Rust, and the importer's lock (X1-R14). The TS importer
//! (`packages/core/src/import/skills-registry.ts`) is the reference: this module reads with the same refusals, writes
//! the same bytes and takes the same lock, so the two writers can never interleave.
use super::record::skill_id_ok;
use super::state::{remove_retrying, rename_retrying, write_private_atomic, ItemRecord};
use super::ExtError;
use crate::paths::Layout;
use crate::proc::pid_alive;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

const INDEX_VERSION: u64 = 1;

/// `{version: 1, skills: [...]}` with every field this code does not own kept as it was read.
#[derive(Clone, Debug, PartialEq)]
pub struct SkillIndex(pub Value);

impl SkillIndex {
    fn skills(&self) -> &[Value] {
        self.0
            .get("skills")
            .and_then(Value::as_array)
            .map_or(&[], |a| a.as_slice())
    }

    fn skills_mut(&mut self) -> &mut Vec<Value> {
        if !self.0.get("skills").is_some_and(Value::is_array) {
            self.0["skills"] = json!([]);
        }
        self.0["skills"].as_array_mut().expect("just ensured")
    }

    pub fn entry(&self, id: &str) -> Option<&Value> {
        self.skills().iter().find(|e| e["id"] == id)
    }

    /// Replaces the entry with the same `id`, or adds it.
    pub fn upsert(&mut self, entry: Value) {
        let id = entry["id"].clone();
        let list = self.skills_mut();
        match list.iter_mut().find(|e| e["id"] == id) {
            Some(slot) => *slot = entry,
            None => list.push(entry),
        }
    }

    pub fn remove(&mut self, id: &str) -> Option<Value> {
        let list = self.skills_mut();
        let at = list.iter().position(|e| e["id"] == id)?;
        Some(list.remove(at))
    }

    /// Sets `enabled` on an existing entry; false when there is none.
    pub fn set_enabled(&mut self, id: &str, on: bool) -> bool {
        match self.skills_mut().iter_mut().find(|e| e["id"] == id) {
            Some(e) => {
                e["enabled"] = json!(on);
                true
            }
            None => false,
        }
    }
}

/// The index entry of a skill installed from a package (X1-R14): the importer's fields (`sha256` is the folder hash
/// over the record's files, `plur1bus-skill-sha256/v1`) plus `package`, over the other fields of `prev`.
pub(crate) fn package_entry(
    rec: &ItemRecord,
    source_path: &str,
    enabled: bool,
    at: &str,
    prev: Option<&Value>,
) -> Value {
    let mut entry = prev
        .filter(|e| e.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let pairs: Vec<(String, String)> = rec
        .files
        .iter()
        .map(|(k, v)| (k.clone(), v.sha256.clone()))
        .collect();
    entry["id"] = json!(rec.name);
    entry["source"] = json!(rec.source);
    entry["sourcePath"] = json!(source_path);
    entry["sha256"] = json!(plur1bus_ext::folder_hash::skill_folder_hash(&pairs));
    entry["enabled"] = json!(enabled);
    entry["importedAt"] = json!(at);
    entry["package"] = json!({ "id": rec.id, "version": rec.version, "trust": rec.trust });
    entry
}

/// `(POSIX relative path, SHA-256 hex)` of every regular file under `dir` (symlinks and special files skipped), for the
/// folder hash of a skill that has no package record.
fn folder_files(dir: &std::path::Path) -> Vec<(String, String)> {
    use sha2::{Digest, Sha256};
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((d, prefix)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(name) = e.file_name().into_string() else {
                continue;
            };
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            match std::fs::symlink_metadata(e.path()) {
                Ok(m) if m.is_dir() => stack.push((e.path(), rel)),
                Ok(m) if m.is_file() => {
                    if let Ok(bytes) = std::fs::read(e.path()) {
                        let hex = Sha256::digest(&bytes)
                            .iter()
                            .map(|b| format!("{b:02x}"))
                            .collect();
                        out.push((rel, hex));
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// The first index entry of a skill folder that had none (X1-R12): `source` is `bundled` or `local`, `sourcePath` the
/// folder itself, `sha256` the folder hash over its regular files, `package: null`.
pub(crate) fn local_entry(
    layout: &Layout,
    name: &str,
    source: &str,
    enabled: bool,
    at: &str,
) -> Value {
    let dir = layout.skills().join(name);
    json!({
        "id": name,
        "source": source,
        "sourcePath": dir.to_string_lossy(),
        "sha256": plur1bus_ext::folder_hash::skill_folder_hash(&folder_files(&dir)),
        "enabled": enabled,
        "importedAt": at,
        "package": null,
    })
}

pub(crate) fn index_path(layout: &Layout) -> PathBuf {
    layout.skills().join("index.json")
}

fn bad(reason: &'static str, path: &std::path::Path, why: impl std::fmt::Display) -> ExtError {
    ExtError::new("E_STORAGE", reason, format!("{}: {why}", path.display()))
}

/// Reads the index with the importer's refusals: unreadable or malformed → `index-invalid`, a `version` above 1 →
/// `index-newer`, an entry without a valid `id` → `index-invalid`. No file is an empty index.
pub fn read_index(layout: &Layout) -> Result<SkillIndex, ExtError> {
    let p = index_path(layout);
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SkillIndex(json!({"version": INDEX_VERSION, "skills": []})));
        }
        Err(e) => return Err(bad("index-invalid", &p, e)),
    };
    let v: Value = serde_json::from_str(&text).map_err(|e| bad("index-invalid", &p, e))?;
    if !v.is_object() || !v.get("skills").is_some_and(Value::is_array) {
        return Err(bad(
            "index-invalid",
            &p,
            "expected {version, skills: [...]}",
        ));
    }
    if let Some(n) = v.get("version").and_then(Value::as_f64) {
        if n > INDEX_VERSION as f64 {
            return Err(bad(
                "index-newer",
                &p,
                format!("index version {n} is newer than {INDEX_VERSION}"),
            ));
        }
    }
    for e in v["skills"].as_array().into_iter().flatten() {
        match e.get("id").and_then(Value::as_str) {
            Some(id) if skill_id_ok(id) => {}
            other => {
                return Err(bad(
                    "index-invalid",
                    &p,
                    format!(
                        "invalid skill id {}",
                        other.map_or("undefined".into(), |s| json!(s).to_string())
                    ),
                ))
            }
        }
    }
    Ok(SkillIndex(v))
}

/// The importer writes an entry as `{id, source, sourcePath, sha256, enabled, importedAt}` and the extensions layer
/// adds `package: {id, version, trust}`; JavaScript keeps insertion order, so those come first in that order. A
/// `Value` object sorts its keys, so everything else follows alphabetically (a difference only in the order of
/// fields neither writer owns).
fn key_rank(scope: Scope, key: &str) -> usize {
    let order: &[&str] = match scope {
        Scope::Top => &["version", "skills"],
        Scope::Entry => &[
            "id",
            "source",
            "sourcePath",
            "sha256",
            "enabled",
            "importedAt",
            "package",
        ],
        Scope::Package => &["id", "version", "trust"],
        Scope::Other => &[],
    };
    order.iter().position(|k| *k == key).unwrap_or(order.len())
}

#[derive(Clone, Copy, PartialEq)]
enum Scope {
    Top,
    Entry,
    Package,
    Other,
}

/// `JSON.stringify(v, null, 2)`: two-space indent, `[]` and `{}` for empty containers.
fn emit(v: &Value, scope: Scope, depth: usize, out: &mut String) {
    let pad = |n: usize| "  ".repeat(n);
    match v {
        Value::Array(a) if !a.is_empty() => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                emit(
                    x,
                    if scope == Scope::Top {
                        Scope::Entry
                    } else {
                        Scope::Other
                    },
                    depth + 1,
                    out,
                );
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            out.push_str(&pad(depth));
            out.push(']');
        }
        Value::Object(m) if !m.is_empty() => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by_key(|k| (key_rank(scope, k), (*k).clone()));
            out.push_str("{\n");
            for (i, k) in keys.iter().enumerate() {
                let child = match (scope, k.as_str()) {
                    (Scope::Entry, "package") => Scope::Package,
                    _ => Scope::Other,
                };
                out.push_str(&pad(depth + 1));
                out.push_str(&json!(k).to_string());
                out.push_str(": ");
                // `skills` at the top level holds the entries.
                let child = if scope == Scope::Top && k.as_str() == "skills" {
                    Scope::Top
                } else {
                    child
                };
                emit(&m[*k], child, depth + 1, out);
                out.push_str(if i + 1 < keys.len() { ",\n" } else { "\n" });
            }
            out.push_str(&pad(depth));
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Writes the index as the importer does: `version` forced to 1, entries sorted by `id`, two-space JSON and a trailing
/// newline, mode 0600, atomically. The caller holds [`lock_skills`].
pub fn write_index(layout: &Layout, idx: &SkillIndex) -> std::io::Result<()> {
    let mut v = idx.0.clone();
    if !v.is_object() {
        v = json!({});
    }
    v["version"] = json!(INDEX_VERSION);
    let mut skills = v
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // JavaScript's `<` on strings compares UTF-16 code units.
    skills.sort_by(|a, b| {
        let key = |e: &Value| {
            e["id"]
                .as_str()
                .unwrap_or_default()
                .encode_utf16()
                .collect::<Vec<u16>>()
        };
        key(a).cmp(&key(b))
    });
    v["skills"] = Value::Array(skills);
    let mut text = String::new();
    emit(&v, Scope::Top, 0, &mut text);
    text.push('\n');
    write_private_atomic(&index_path(layout), text.as_bytes())
}

/// A lock with no readable pid younger than this is a holder between its exclusive create and its write, not a
/// leftover: it is refused, not taken over (N1; same value as the importer's `LOCK_UNREADABLE_GRACE_MS`).
pub const LOCK_UNREADABLE_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

/// `<home>/imports/.lock`, held while this value lives. Released on drop only while the file still holds our nonce:
/// renamed aside to `.lock.rel-<nonce>`, re-read there, deleted if ours, else put back (N1: it used to check the pid,
/// then delete, so a lock taken over in between was deleted too).
#[derive(Debug)]
pub struct ImportLock {
    path: PathBuf,
    nonce: String,
}

impl Drop for ImportLock {
    fn drop(&mut self) {
        let moved = sibling(&self.path, &format!("rel-{}", self.nonce));
        if rename_retrying(&self.path, &moved).is_err() {
            return; // gone (taken over) or busy: nothing of ours to delete
        }
        match std::fs::read_to_string(&moved) {
            Ok(text) if lock_field(&text, "nonce").as_deref() != Some(self.nonce.as_str()) => {
                put_back(&moved, &self.path); // someone else's lock: never delete it
            }
            _ => {
                if let Err(e) = remove_retrying(&moved) {
                    eprintln!(
                        "plur1bus: warning: could not release {}: {e}",
                        self.path.display()
                    );
                }
            }
        }
    }
}

fn locked(msg: String) -> ExtError {
    ExtError::new("E_LOCKED", "skills-locked", msg)
}

/// `<dir>/.lock.<suffix>` next to the lock.
fn sibling(lock: &Path, suffix: &str) -> PathBuf {
    let mut name = lock.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(suffix);
    lock.with_file_name(name)
}

/// A string or integer field of a lock body as text; `None` when the body is no JSON object or lacks it.
fn lock_field(text: &str, key: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    match &v[key] {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn lock_pid(text: Option<&str>) -> Option<u32> {
    text.and_then(|t| lock_field(t, "pid"))
        .and_then(|p| p.parse::<u32>().ok())
        .filter(|p| *p > 0)
}

/// Stale = the holder pid is dead, or it is ours (ext mutations are serialised in-process, X1-R15), or there is no
/// readable pid and the file is older than [`LOCK_UNREADABLE_GRACE`]. A live foreign holder is never stale.
fn lock_stale(text: Option<&str>, meta: &std::fs::Metadata) -> bool {
    match lock_pid(text) {
        Some(pid) => pid == std::process::id() || !pid_alive(pid),
        None => meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > LOCK_UNREADABLE_GRACE),
    }
}

/// The same file? dev/ino where the platform gives them; contents always.
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        true
    }
}

/// Puts a moved-aside lock back without overwriting a newer one (`hard_link` fails if one exists), then drops the
/// moved name.
fn put_back(moved: &Path, lock: &Path) {
    if let Err(e) = std::fs::hard_link(moved, lock) {
        if e.kind() != std::io::ErrorKind::AlreadyExists
            && std::fs::symlink_metadata(lock).is_err()
            && rename_retrying(moved, lock).is_ok()
        {
            return;
        }
    }
    let _ = remove_retrying(moved); // a leftover is swept by the next taker
}

/// Removes the judged lock only if the moved-aside file is still it (same file, same contents); true when removed.
fn break_stale(lock: &Path, judged: &std::fs::Metadata, text: Option<&str>) -> bool {
    let moved = sibling(lock, &format!("break-{}", uuid::Uuid::new_v4()));
    if rename_retrying(lock, &moved).is_err() {
        return false;
    }
    let same = std::fs::metadata(&moved).is_ok_and(|m| same_file(&m, judged))
        && std::fs::read_to_string(&moved).ok().as_deref() == text;
    if same {
        let _ = remove_retrying(&moved);
        return true;
    }
    put_back(&moved, lock); // a fresh lock took its place meanwhile: never delete it
    false
}

/// Sweeps `.lock.rel-*` / `.lock.break-*` leftovers (a crash mid-release) by the same stale rule.
fn sweep_leftovers(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(".lock.rel-") || name.starts_with(".lock.break-")) {
            continue;
        }
        let p = entry.path();
        if let Ok(meta) = std::fs::metadata(&p) {
            if lock_stale(std::fs::read_to_string(&p).ok().as_deref(), &meta) {
                let _ = remove_retrying(&p);
            }
        }
    }
}

/// Takes the importer's own lock (X1-R14): exclusive create of `<home>/imports/.lock` holding `{pid, at, nonce}`. A
/// live foreign holder is `E_LOCKED reason=skills-locked`. A lock whose pid is gone, names this very process (as the
/// importer does: ext mutations are serialised in-process, X1-R15), or is unreadable for longer than
/// [`LOCK_UNREADABLE_GRACE`] is taken over — on a moved-aside name, re-verified as the judged file (N1).
pub fn lock_skills(layout: &Layout) -> Result<ImportLock, ExtError> {
    let dir = layout.imports();
    std::fs::create_dir_all(&dir)
        .map_err(|e| ExtError::new("E_INTERNAL", "io", format!("{}: {e}", dir.display())))?;
    let path = dir.join(".lock");
    sweep_leftovers(&dir);
    for _ in 0..2 {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        match o.open(&path) {
            Ok(mut f) => {
                let nonce = uuid::Uuid::new_v4().to_string();
                let body =
                    json!({"pid": std::process::id(), "at": super::now_iso(), "nonce": nonce})
                        .to_string();
                if let Err(e) = f.write_all(body.as_bytes()) {
                    // Our own nonce-less file: identified by the open handle's metadata, removed only if still it.
                    if let Ok(own) = f.metadata() {
                        drop(f);
                        break_stale(&path, &own, std::fs::read_to_string(&path).ok().as_deref());
                    }
                    return Err(ExtError::new(
                        "E_INTERNAL",
                        "io",
                        format!("{}: {e}", path.display()),
                    ));
                }
                return Ok(ImportLock { path, nonce });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let Ok(judged) = std::fs::metadata(&path) else {
                    continue; // gone meanwhile: try again
                };
                let text = std::fs::read_to_string(&path).ok();
                if !lock_stale(text.as_deref(), &judged) {
                    return Err(locked(match lock_pid(text.as_deref()) {
                        Some(pid) => format!("another import (pid {pid}) holds {}", path.display()),
                        None => format!("another import is taking {}", path.display()),
                    }));
                }
                break_stale(&path, &judged, text.as_deref());
            }
            Err(e) => {
                return Err(ExtError::new(
                    "E_INTERNAL",
                    "io",
                    format!("{}: {e}", path.display()),
                ))
            }
        }
    }
    Err(locked(format!("could not take {}", path.display())))
}
