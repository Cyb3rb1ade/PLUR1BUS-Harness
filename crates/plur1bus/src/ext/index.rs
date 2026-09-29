//! `skills/index.json` written from Rust, and the importer's lock (X1-R14). The TS importer
//! (`packages/core/src/import/skills-registry.ts`) is the reference: this module reads with the same refusals, writes
//! the same bytes and takes the same lock, so the two writers can never interleave.
use super::state::{remove_retrying, write_private_atomic};
use super::ExtError;
use crate::paths::Layout;
use crate::proc::pid_alive;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

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

fn index_path(layout: &Layout) -> PathBuf {
    layout.skills().join("index.json")
}

/// The importer's `SKILL_ID`: `^[a-z0-9][a-z0-9._-]{0,63}$`.
fn skill_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
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

/// `<home>/imports/.lock`, held while this value lives. Released on drop only if the file still names our pid.
#[derive(Debug)]
pub struct ImportLock {
    path: PathBuf,
    pid: u32,
}

impl Drop for ImportLock {
    fn drop(&mut self) {
        let ours = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["pid"].as_u64())
            == Some(u64::from(self.pid));
        if ours {
            if let Err(e) = remove_retrying(&self.path) {
                eprintln!(
                    "plur1bus: warning: could not release {}: {e}",
                    self.path.display()
                );
            }
        }
    }
}

fn locked(msg: String) -> ExtError {
    ExtError::new("E_LOCKED", "skills-locked", msg)
}

/// Takes the importer's own lock (X1-R14): exclusive create of `<home>/imports/.lock` holding `{pid, at}`. A lock whose
/// pid is gone (or unreadable) is taken over; a live holder is `E_LOCKED reason=skills-locked`. A lock naming this very
/// process is taken over as well, as the importer does: ext mutations are serialised in-process (X1-R15).
pub fn lock_skills(layout: &Layout) -> Result<ImportLock, ExtError> {
    let dir = layout.imports();
    std::fs::create_dir_all(&dir)
        .map_err(|e| ExtError::new("E_INTERNAL", "io", format!("{}: {e}", dir.display())))?;
    let path = dir.join(".lock");
    let me = std::process::id();
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
                let body = json!({"pid": me, "at": super::now_iso()}).to_string();
                f.write_all(body.as_bytes()).map_err(|e| {
                    ExtError::new("E_INTERNAL", "io", format!("{}: {e}", path.display()))
                })?;
                return Ok(ImportLock { path, pid: me });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let holder = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v["pid"].as_u64())
                    .and_then(|p| u32::try_from(p).ok());
                if let Some(pid) = holder.filter(|p| *p != me && pid_alive(*p)) {
                    return Err(locked(format!(
                        "another import (pid {pid}) holds {}",
                        path.display()
                    )));
                }
                remove_retrying(&path).map_err(|e| {
                    ExtError::new(
                        "E_INTERNAL",
                        "io",
                        format!("cannot take over the stale lock {}: {e}", path.display()),
                    )
                })?;
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
